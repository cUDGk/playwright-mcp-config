<div align="center">

# Playwright MCP - Brave Browser カスタム設定

### Playwright MCP × Brave

[![Playwright](https://img.shields.io/badge/Playwright-MCP-2EAD33?style=for-the-badge&logo=playwright&logoColor=white)](https://github.com/microsoft/playwright-mcp)
[![MCP](https://img.shields.io/badge/MCP-Model_Context_Protocol-8B5CF6?style=for-the-badge)](https://modelcontextprotocol.io/)
[![Brave](https://img.shields.io/badge/Brave-Browser-FB542B?style=for-the-badge&logo=brave&logoColor=white)](https://brave.com/)
[![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)

**Playwright MCP で Brave ブラウザを使うためのカスタム設定**

---

</div>

## 概要

[`@playwright/mcp`](https://github.com/microsoft/playwright-mcp)（Microsoft製、Apache-2.0ライセンス）をBraveブラウザで動作させるためのカスタム設定ファイルです。

デフォルトではPlaywright MCPはChromiumを使用しますが、この設定を適用することでBraveブラウザを代わりに使用できます。

## なぜBraveを使うのか

- **ログインセッションの活用**: 普段使いのブラウザのセッション（Cookie等）をそのまま利用可能
- **拡張機能**: インストール済みのChrome拡張機能がそのまま使える
- **広告ブロック**: Braveの組み込み広告ブロック機能により、クリーンなページ操作が可能
- **実環境でのブラウザ自動化**: テスト用ブラウザではなく、実際の利用環境で自動化タスクを実行できる

## 仕組み

```mermaid
graph LR
    A[Claude Code] -->|MCP Protocol| B[Playwright MCP]
    B -->|config.json| C[Brave Browser]
    style A fill:#6B4FBB,stroke:#333,color:#fff
    style B fill:#2EAD33,stroke:#333,color:#fff
    style C fill:#FB542B,stroke:#333,color:#fff
```

`config.json` でPlaywright MCPに対してBraveの実行ファイルパスを指定することで、Chromiumの代わりにBraveが起動されます。内部的にはBraveもChromiumベースのため、`browserName: "chromium"` のまま動作します。

## インストール手順

### 1. @playwright/mcp をインストール

```bash
npm install -g @playwright/mcp@0.0.68
```

> **Note**: バージョン `0.0.68` に固定しています。新しいバージョンでは設定ファイルの仕様が変更される可能性があるため、安定動作が確認されたこのバージョンを推奨します。

### 2. config.json を配置

このリポジトリの `config.json` を任意の場所にコピーします。

```bash
# 例: ホームディレクトリに配置
cp config.json ~/playwright-mcp-config.json
```

Brave のインストールパスが異なる場合は、`executablePath` を環境に合わせて修正してください。`config.example.json` にプレースホルダー付きのテンプレートがあります。

### 3. Claude Code の MCP 設定に登録

Claude Code の設定ファイル（`.claude/settings.json` 等）に以下を追加します。

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": [
        "@playwright/mcp@0.0.68",
        "--config",
        "C:/path/to/playwright-mcp-config/config.json"
      ]
    }
  }
}
```

`--config` のパスは、手順2で配置した `config.json` の絶対パスに置き換えてください。

## ファイル構成

| ファイル | 説明 |
|---|---|
| `config.json` | Brave用の設定ファイル（Windowsパス） |
| `config.example.json` | テンプレート（パスはプレースホルダー） |
| `brave-daemon.mjs` | 共有 Brave を1つだけ常駐させる（下記） |
| `launch.mjs` | 共有 Brave に CDP 接続して MCP を起動するランチャ（下記） |
| `sync-extensions.ps1` | `extensions/` 直下の拡張を `config.json` に反映（`launch.mjs` 使用時は不要） |

## 共有 Brave 方式（launch.mjs / brave-daemon.mjs）

MCP サーバーのコマンドを `npx @playwright/mcp ...` の代わりに `node launch.mjs` にすると、
**全セッションが同じ Brave を共有**します。Chromium は同じ `user-data-dir` を2プロセスで
開けないため、「セッションごとに Brave を起動する」方式ではログイン状態を共有できず、
同時数もプロファイル数で頭打ちになります。そこで Brave を1つだけ立ててデバッグポートを開き、
各 MCP は CDP でぶら下がります。

- `brave-daemon.mjs` が `brave-claude-profile` の Brave を `--remote-debugging-port=9222` で常駐させる
  （既に生きていれば何もしない。ポート番号は `BRAVE_CDP_PORT` で変更可）
- `launch.mjs` は `browser.cdpEndpoint` を書いた設定で `@playwright/mcp` を起動する
- セッション数の上限は無く、ログイン状態・Cookie は全セッションで共通
- MCP 終了時も Brave は落とさない（他セッションが使っているため）
- 拡張機能は `extensions/` 直下の `manifest.json` 持ちフォルダを常駐 Brave の起動時に自動列挙
  （`sync-extensions.ps1` の実行は不要）

`brave-daemon.mjs` は単体でも実行でき、CDP エンドポイントを標準出力に出します。
Playwright MCP 以外のブラウザ操作 MCP も、この `http://127.0.0.1:9222` にアタッチすれば
同じログイン済みプロファイルを共有できます。

```bash
node brave-daemon.mjs   # -> http://127.0.0.1:9222
```

### 1つのブラウザを共有する副作用への対処

`launch.mjs` は素通しではなく stdio を中継し、次の2つを行います。

- **セッション専用タブの確保**: Playwright MCP は接続時に「既存ページのうち最古のもの」を
  カレントタブにするため、放置すると全セッションが同じタブを掴んで遷移を潰し合う。
  初期化直後に `browser_tabs:new` を1度だけ注入し、終了時にそのタブを閉じる。
- **ツール呼び出しの直列化**: Playwright MCP は応答を組み立てるたびにコンテキスト内の
  全タブの `page.title()` を呼ぶ。他セッションが遷移中のタブに当たると
  `Execution context was destroyed` で無関係な呼び出しごと失敗するため、
  `locks/browser.lock` によりブラウザに触る呼び出しを全セッションで1つずつ通す。

```json
{
  "mcpServers": {
    "playwright": {
      "command": "node",
      "args": ["C:/path/to/playwright-mcp-config/launch.mjs"]
    }
  }
}
```

## バージョン固定について

`@playwright/mcp` はまだ活発に開発が進んでいるパッケージです。設定ファイルの仕様やCLIオプションが予告なく変更される可能性があるため、動作確認済みのバージョン **0.0.68** に固定することを推奨します。

## Attribution

このリポジトリは以下のオープンソースプロジェクトのカスタム設定です:

- **[@playwright/mcp](https://github.com/microsoft/playwright-mcp)** -- Microsoft 製の Playwright MCP サーバー。Apache-2.0 ライセンス。

---

## ライセンス

[MIT License](LICENSE) -- Copyright (c) 2026 cUDGk
