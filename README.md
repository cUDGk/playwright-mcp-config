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

## バージョン固定について

`@playwright/mcp` はまだ活発に開発が進んでいるパッケージです。設定ファイルの仕様やCLIオプションが予告なく変更される可能性があるため、動作確認済みのバージョン **0.0.68** に固定することを推奨します。

## Attribution

このリポジトリは以下のオープンソースプロジェクトのカスタム設定です:

- **[@playwright/mcp](https://github.com/microsoft/playwright-mcp)** -- Microsoft 製の Playwright MCP サーバー。Apache-2.0 ライセンス。

---

## ライセンス

[MIT License](LICENSE) -- Copyright (c) 2026 cUDGk
