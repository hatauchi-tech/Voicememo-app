/**
 * Voice Transcription & Document Integration App
 * @author GAS Expert
 * @version 2.0.1 (Fix Content-Length Header Issue)
 */

// --- Configuration Constants ---
const SCRIPT_PROPS = PropertiesService.getScriptProperties();
const TRIGGER_FUNCTION_NAME = 'processAsyncQueue';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Update default model as requested
const DEFAULT_MODEL_NAME = 'gemini-3-flash-preview';

// --- Web App Entry Point ---

function doGet(e) {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('AI Voice Transcription')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// --- Client-Side Callable Functions ---

/**
 * Retrieves configuration data for the UI.
 * @return {Object} Document list and NotebookLM URL.
 */
function getUiData() {
  const props = SCRIPT_PROPS.getProperties();
  const docs = [];
  
  // Extract document IDs dynamically (DOCUMENT_1, DOCUMENT_2, ...)
  Object.keys(props).forEach(key => {
    if (key.startsWith('DOCUMENT_')) {
      try {
        const file = DriveApp.getFileById(props[key]);
        docs.push({
          id: props[key],
          name: file.getName()
        });
      } catch (e) {
        console.warn(`Invalid Document ID for key ${key}: ${props[key]}`);
      }
    }
  });

  return {
    documents: docs,
    notebookLmUrl: props['NOTEBOOK_LM_URL'] || '#'
  };
}

/**
 * Handles chunked file uploads.
 * @param {string} data - Base64 encoded chunk data.
 * @param {string} sessionId - Unique ID for the recording session.
 * @param {number} index - Chunk index (0-based).
 * @param {string} mimeType - Mime type of the audio.
 * @return {Object} Status.
 */
function uploadChunk(data, sessionId, index, mimeType) {
  try {
    const folderId = SCRIPT_PROPS.getProperty('TEMP_FOLDER_ID');
    const rootFolder = folderId ? DriveApp.getFolderById(folderId) : DriveApp.getRootFolder();
    
    // Create a dedicated folder for this session if it doesn't exist (first chunk)
    let sessionFolder;
    const folders = rootFolder.getFoldersByName(sessionId);
    if (folders.hasNext()) {
      sessionFolder = folders.next();
    } else {
      sessionFolder = rootFolder.createFolder(sessionId);
    }

    // Save chunk as a separate file
    const decoded = Utilities.base64Decode(data);
    const blob = Utilities.newBlob(decoded, mimeType, `chunk_${index.toString().padStart(4, '0')}`);
    sessionFolder.createFile(blob);

    return { success: true };
  } catch (e) {
    console.error('Upload Error:', e);
    throw new Error(`Upload failed: ${e.message}`);
  }
}

/**
 * Finalizes the upload and creates a task file in Drive.
 * NO LONGER USES SCRIPT PROPERTIES.
 * * @param {string} sessionId - Unique ID for the recording session.
 * @param {string} targetDocId - ID of the Google Doc to write to.
 * @return {Object} Status.
 */
function finalizeUpload(sessionId, targetDocId) {
  try {
    const folderId = SCRIPT_PROPS.getProperty('TEMP_FOLDER_ID');
    const rootFolder = folderId ? DriveApp.getFolderById(folderId) : DriveApp.getRootFolder();
    
    const folders = rootFolder.getFoldersByName(sessionId);
    if (!folders.hasNext()) {
      throw new Error(`Session folder not found for ${sessionId}`);
    }
    const sessionFolder = folders.next();

    // Create task.json inside the session folder
    // This acts as the "queue item"
    const taskData = {
      sessionId: sessionId,
      targetDocId: targetDocId,
      timestamp: new Date().getTime(),
      status: 'pending'
    };
    
    sessionFolder.createFile('task.json', JSON.stringify(taskData), MimeType.PLAIN_TEXT);

    // Create a one-time trigger to run shortly
    ScriptApp.newTrigger(TRIGGER_FUNCTION_NAME)
      .timeBased()
      .after(100) // Run almost immediately
      .create();

    return { success: true, message: 'Processing started in background.' };
  } catch (e) {
    console.error('Finalize Error:', e);
    throw new Error(`Finalization failed: ${e.message}`);
  }
}

// --- Background Processing (Triggered) ---

/**
 * Main handler for processing the transcription queue.
 * Scans Drive folders for 'task.json' instead of ScriptProperties.
 * @param {Object} e - Event object from the trigger.
 */
function processAsyncQueue(e) {
  const folderId = SCRIPT_PROPS.getProperty('TEMP_FOLDER_ID');
  const rootFolder = folderId ? DriveApp.getFolderById(folderId) : DriveApp.getRootFolder();
  
  // Iterate through session folders in the temp directory
  // Note: getFolders() can be slow if there are thousands of folders, 
  // but since we delete them after processing, it should remain fast.
  const folders = rootFolder.getFolders();
  let taskProcessed = false;

  while (folders.hasNext()) {
    const sessionFolder = folders.next();
    
    // Check for 'task.json'
    const taskFiles = sessionFolder.getFilesByName('task.json');
    if (taskFiles.hasNext()) {
      const taskFile = taskFiles.next();
      
      // Found a pending task!
      // "Lock" the task by renaming the file immediately to prevent double processing
      try {
        taskFile.setName('processing.json');
        const taskJson = taskFile.getBlob().getDataAsString();
        const task = JSON.parse(taskJson);
        
        console.log(`Processing session from Drive: ${task.sessionId}`);
        processTranscriptionTask(task, sessionFolder);
        taskProcessed = true;
        
        // We only process one task per trigger execution to be safe with time limits
        break; 

      } catch (err) {
        console.error(`Error processing folder ${sessionFolder.getName()}:`, err);
        // Rename back to error.json so we don't retry forever loop
        try { taskFile.setName('error.json'); } catch(e){}
      }
    }
  }

  if (!taskProcessed) {
    console.log("No pending tasks found in Drive folders.");
  }
  
  // Cleanup Trigger
  if (e && e.triggerUid) {
    deleteSpecificTrigger(e.triggerUid);
  }
}

/**
 * Core logic: Combine chunks -> Gemini File API -> Inference -> Docs Update.
 * @param {Object} task - The task object.
 * @param {Folder} sessionFolder - The Drive folder object (passed from queue handler).
 */
function processTranscriptionTask(task, sessionFolder) {
  
  // 1. Combine Chunks
  const files = sessionFolder.getFiles();
  const chunks = [];
  while (files.hasNext()) {
    const file = files.next();
    // Exclude the task config files
    if (file.getName().startsWith('chunk_')) {
      chunks.push(file);
    }
  }
  
  if (chunks.length === 0) throw new Error("No audio chunks found.");

  // Sort by name (chunk_0000, chunk_0001...)
  chunks.sort((a, b) => a.getName().localeCompare(b.getName()));

  let combinedBlob = Utilities.newBlob([]);
  chunks.forEach(file => {
    // Determine mime type from first chunk
    if (combinedBlob.getBytes().length === 0) {
      combinedBlob.setContentType(file.getMimeType());
    }
    combinedBlob.setBytes([...combinedBlob.getBytes(), ...file.getBlob().getBytes()]);
  });
  combinedBlob.setName(`audio_${task.sessionId}`);

  // 2. Upload to Gemini File API
  const fileUri = uploadToGeminiFileApi(combinedBlob);
  console.log(`Uploaded to Gemini: ${fileUri}`);

  try {
    // 3. Wait for File Processing (Active State)
    waitForGeminiFileActive(fileUri);

    // 4. Generate Content (Transcribe)
    const transcript = generateContent(fileUri);

    // 5. Update Google Doc
    updateGoogleDoc(task.targetDocId, transcript);

  } finally {
    // 6. Cleanup (Drive Folder & Gemini File)
    // Always attempt cleanup even if transcription fails
    try {
      if (fileUri) deleteGeminiFile(fileUri);
    } catch (e) { console.warn("Failed to delete Gemini file:", e); }
    
    // Delete the entire session folder (including chunks and task json)
    try {
      sessionFolder.setTrashed(true);
      console.log(`[Cleanup] Deleted Drive folder: ${sessionFolder.getName()}`);
    } catch (e) { console.warn("Failed to delete Drive folder:", e); }
  }
}

// --- Gemini API Helpers (Resumable Upload) ---

/**
 * Uploads file using Resumable Upload protocol to avoid multipart issues.
 */
function uploadToGeminiFileApi(blob) {
  const apiKey = SCRIPT_PROPS.getProperty('GEMINI_API_KEY');
  
  // Step 1: Start Resumable Upload Session
  const initUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;
  
  const metadata = { file: { display_name: blob.getName() } };
  const metadataJson = JSON.stringify(metadata);

  const initHeaders = {
    'X-Goog-Upload-Protocol': 'resumable',
    'X-Goog-Upload-Command': 'start',
    'X-Goog-Upload-Header-Content-Length': blob.getBytes().length.toString(),
    'X-Goog-Upload-Header-Content-Type': blob.getContentType(),
    'Content-Type': 'application/json'
  };

  const initOptions = {
    method: 'post',
    headers: initHeaders,
    payload: metadataJson,
    muteHttpExceptions: true
  };

  console.log(`[Upload-Init] Starting resumable upload for ${blob.getName()} (${blob.getBytes().length} bytes)`);

  const initResponse = UrlFetchApp.fetch(initUrl, initOptions);
  const initCode = initResponse.getResponseCode();
  
  if (initCode !== 200) {
    const text = initResponse.getContentText();
    throw new Error(`Gemini Upload Init Failed. Status: ${initCode}. Body: ${text}`);
  }

  // Extract the upload URL from headers
  const headers = initResponse.getAllHeaders();
  const uploadUrl = headers['x-goog-upload-url'];
  
  if (!uploadUrl) {
    throw new Error('Gemini Upload Init Failed: No x-goog-upload-url in response headers.');
  }

  // Step 2: Upload the Actual Bytes
  const uploadHeaders = {
    'X-Goog-Upload-Protocol': 'resumable',
    'X-Goog-Upload-Command': 'upload, finalize',
    'X-Goog-Upload-Offset': '0'
    // 'Content-Length': blob.getBytes().length.toString() // REMOVED: UrlFetchApp adds this automatically.
  };

  const uploadOptions = {
    method: 'post',
    headers: uploadHeaders,
    payload: blob,
    muteHttpExceptions: true
  };

  console.log(`[Upload-Push] Sending bytes to upload URL...`);

  const uploadResponse = UrlFetchApp.fetch(uploadUrl, uploadOptions);
  const uploadCode = uploadResponse.getResponseCode();
  const uploadText = uploadResponse.getContentText();

  console.log(`[Upload-Push] Response: ${uploadCode}`);

  let json;
  try {
    json = JSON.parse(uploadText);
  } catch (e) {
    throw new Error(`Gemini Upload Finalize returned INVALID JSON. Status: ${uploadCode}. Body: ${uploadText}`);
  }

  if (uploadCode !== 200 || json.error) {
    throw new Error(json.error ? `Gemini API Error: ${json.error.message}` : `Upload failed with status ${uploadCode}`);
  }

  return json.file.uri;
}

function waitForGeminiFileActive(fileUri) {
  const apiKey = SCRIPT_PROPS.getProperty('GEMINI_API_KEY');
  const fileName = fileUri.split('/files/')[1];
  
  if (!fileName) throw new Error(`Invalid File URI format: ${fileUri}`);

  const url = `${GEMINI_API_BASE}/files/${fileName}?key=${apiKey}`;

  for (let i = 0; i < 30; i++) { // Max 30 seconds wait
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const responseCode = response.getResponseCode();
    
    if (responseCode !== 200) {
       Utilities.sleep(1000);
       continue;
    }

    const json = JSON.parse(response.getContentText());
    console.log(`[WaitForActive] State: ${json.state}`);
    
    if (json.state === 'ACTIVE') return;
    if (json.state === 'FAILED') throw new Error(`Gemini File Processing FAILED. Details: ${JSON.stringify(json)}`);
    
    Utilities.sleep(1000);
  }
  throw new Error('Gemini File Processing Timeout (30s)');
}

function generateContent(fileUri) {
  const apiKey = SCRIPT_PROPS.getProperty('GEMINI_API_KEY');
  const modelName = SCRIPT_PROPS.getProperty('GEMINI_MODEL') || DEFAULT_MODEL_NAME;
  const url = `${GEMINI_API_BASE}/models/${modelName}:generateContent?key=${apiKey}`;

  console.log(`[Generate] Using model: ${modelName}`);

  const payload = {
    contents: [{
      parts: [
        { text: "以下の音声を正確に文字起こししてください。フィラー（『えー』『あのー』等）は完全に除外してください。出力前に内容を再検証し、誤字脱字を修正したクリーンなテキストのみを出力してください。" },
        { file_data: { mime_type: "audio/mp3", file_uri: fileUri } }
      ]
    }]
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const responseCode = response.getResponseCode();
  const responseText = response.getContentText();

  if (responseCode !== 200) {
     console.error(`[Generate] Error. Status: ${responseCode}, Body: ${responseText}`);
     const json = JSON.parse(responseText);
     throw new Error(json.error ? json.error.message : `GenerateContent failed: ${responseCode}`);
  }

  const json = JSON.parse(responseText);
  
  try {
    return json.candidates[0].content.parts[0].text;
  } catch (e) {
    console.warn(`[Generate] No content in candidate. Full response: ${responseText}`);
    return "(文字起こしに失敗しました、または音声が含まれていません)";
  }
}

function deleteGeminiFile(fileUri) {
  const apiKey = SCRIPT_PROPS.getProperty('GEMINI_API_KEY');
  const fileName = fileUri.split('/files/')[1];
  if (!fileName) return;

  const url = `${GEMINI_API_BASE}/files/${fileName}?key=${apiKey}`;
  UrlFetchApp.fetch(url, { method: 'delete', muteHttpExceptions: true });
  console.log(`[Cleanup] Deleted Gemini file: ${fileName}`);
}

// --- Doc Helpers ---

function updateGoogleDoc(docId, text) {
  const doc = DocumentApp.openById(docId);
  const body = doc.getBody();
  
  const now = new Date();
  const timeString = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm:ss');
  
  const heading = body.appendParagraph(`録音：${timeString}`);
  heading.setHeading(DocumentApp.ParagraphHeading.HEADING3);
  
  body.appendParagraph(text);
  doc.saveAndClose();
}

/**
 * Deletes only the trigger that triggered the current execution.
 * @param {string} triggerUid - The unique ID of the trigger to delete.
 */
function deleteSpecificTrigger(triggerUid) {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getUniqueId() === triggerUid) {
      ScriptApp.deleteTrigger(trigger);
      console.log(`[Cleanup] Trigger deleted: ${triggerUid}`);
    }
  });
}