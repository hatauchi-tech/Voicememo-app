# **AI Voice Transcription for Google Docs**

モバイルブラウザから音声を録音し、Google Gemini API を用いて高精度な文字起こしを行った後、Google ドキュメントへ自動追記する Google Apps Script (GAS) Webアプリケーションです。

生成されたテキストは、NotebookLM などのRAG（検索拡張生成）ツールのソースデータとして即座に活用可能です。

## **✨ 主な機能**

* **📱 モバイル最適化UI:** iOS/Androidブラウザで動作するレスポンシブデザイン。  
* **🔄 堅牢なアップロード:**  
  * クライアント側でのチャンク分割送信により、大容量音声データに対応。  
  * **Resumable Upload (再開可能なアップロード)** プロトコルを採用し、Gemini APIへの転送エラーを極小化。  
* **⏳ 非同期バックグラウンド処理:**  
  * ユーザーには即座にレスポンスを返し、重い推論処理はサーバー側トリガーで非同期実行（Fire-and-forget）。  
  * **Driveフォルダベースのキュー管理**により、GASの実行時間制限（6分）や同時実行の壁をクリア。  
* **🤖 最新AIモデル対応:** デフォルトで gemini-3-flash-preview を採用。設定で変更可能。  
* **🧹 自動クリーンアップ:** 処理完了後、Drive上の一時ファイルおよびGemini上のファイルを自動削除し、ストレージを圧迫しません。

## **🛠 技術スタック**

* **Frontend:** HTML5, JavaScript (MediaRecorder API), Tailwind CSS, Lucide Icons  
* **Backend:** Google Apps Script (GAS)  
* **AI:** Google Gemini API (File API \+ GenerateContent)  
* **Storage:** Google Drive (一時ファイル・キュー管理), Google Docs (出力先)

## **🚀 セットアップ手順**

### **1\. Google Apps Script プロジェクトの作成**

1. Google Drive または [script.google.com](https://script.google.com/) から新しいプロジェクトを作成します。  
2. Code.gs と index.html にコードをコピー＆ペーストします。

### **2\. 必要なサービスの有効化**

GASエディタ左側の「サービス (+)」から以下を追加してください。

* **Drive API** (識別子: Drive)

### **3\. スクリプトプロパティの設定**

「プロジェクトの設定」\>「スクリプト プロパティ」に以下を設定してください。

| プロパティ名 | 設定値の例 | 説明 |
| :---- | :---- | :---- |
| GEMINI\_API\_KEY | AIzaSy... | Google AI Studioで取得したAPIキー |
| NOTEBOOK\_LM\_URL | https://notebooklm... | 完了後に遷移させるNotebookLMのURL |
| TEMP\_FOLDER\_ID | 1xyz... | 音声とタスク情報を一時保存するDriveフォルダID |
| DOCUMENT\_1 | 1abc... | 書き込み先のドキュメントID (1つ目) |
| DOCUMENT\_2 | 1def... | (任意) 書き込み先のドキュメントID (2つ目) |
| GEMINI\_MODEL | gemini-3-flash-preview | (任意) 使用するモデル名。省略時はデフォルト値が適用されます。 |

### **4\. デプロイ**

1. 右上の「デプロイ」\>「新しいデプロイ」を選択。  
2. 種類の選択: **ウェブアプリ**。  
3. 設定:  
   * 説明: v1.0.0 など  
   * 次のユーザーとして実行: **自分 (Me)**  
   * アクセスできるユーザー: **Googleアカウントを持つ全員 (Anyone with Google Account)** ※または組織内  
4. 発行されたURLをスマホで開いて利用開始します。

## **📂 ディレクトリ構成 (Drive内の一時フォルダ)**

処理中、TEMP\_FOLDER\_ID で指定したフォルダ内に、セッションごとのサブフォルダが作成されます。

Target Folder/  
└── session\_1700000000000/    \<-- 自動生成・自動削除  
    ├── chunk\_0000            \<-- 分割音声データ  
    ├── chunk\_0001  
    └── task.json             \<-- タスク定義ファイル (キュー管理用)

## **⚠️ 注意事項**

* **実行時間:** GASのトリガー実行時間制限（6分/回）を超えないよう設計されていますが、極端に長い音声（1時間超など）の場合、分割処理等のさらなる拡張が必要になる場合があります。  
* **Quotas:** Gemini API および Drive API のQuota（割り当て）にご注意ください。

## **License**

MIT License / Internal Use