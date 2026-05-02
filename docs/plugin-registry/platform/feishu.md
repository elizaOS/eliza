---
title: "Feishu Plugin"
sidebarTitle: "Feishu"
description: "Feishu/Lark connector for Eliza — bot messaging, group chats, and workflow notifications."
---

The Feishu plugin connects Eliza agents to Feishu (known as Lark outside China), enabling bot interactions in direct messages and group chats.

**Package:** `@elizaos/plugin-feishu`

## Installation

```bash
eliza plugins install @elizaos/plugin-feishu
```

## Setup

### 1. Create a Feishu/Lark App

Go to the [Feishu Open Platform](https://open.feishu.cn/) (or [Lark Developer](https://open.larksuite.com/) for global) and create a Custom App.

### 2. Enable Bot Capability

Under your app settings, enable the **Bot** capability and configure event subscriptions.

### 3. Configure Eliza

```json
{
  "env": {
    "FEISHU_APP_ID": "cli_your_app_id",
    "FEISHU_APP_SECRET": "your_app_secret"
  },
  "connectors": {
    "feishu": {
      "enabled": true
    }
  }
}
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FEISHU_APP_ID` | Yes | — | Application ID (`cli_xxx` format) |
| `FEISHU_APP_SECRET` | Yes | — | Application secret |
| `FEISHU_DOMAIN` | No | `feishu` | Domain: `feishu` for China, `lark` for global |
| `FEISHU_ALLOWED_CHATS` | No | — | JSON array of authorized chat IDs |
| `FEISHU_TEST_CHAT_ID` | No | — | Chat ID for test suite validation |

## Features

- Direct bot messaging
- Group chat participation
- Chat allowlist for access control
- China (`feishu.cn`) and global (`larksuite.com`) support
- Event subscription for real-time messages

## Auto-Enable

The plugin auto-enables when the `connectors.feishu` block contains `token`, `botToken`, or `apiKey`. Environment variables alone (`FEISHU_APP_ID` / `FEISHU_APP_SECRET`) do not trigger auto-enable. Set `"apiKey": "your_app_secret"` in the connector config to trigger auto-enable, or add the plugin to `plugins.allow` explicitly.

## Related

- [Feishu connector setup](/connectors/feishu) — full connector configuration
- [Connectors overview](/guides/connectors) — all platform connectors
