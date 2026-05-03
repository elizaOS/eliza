---
title: "Gmail Watch Plugin"
sidebarTitle: "Gmail Watch"
description: "Gmail Watch connector for Eliza — monitor Gmail inboxes and respond to incoming emails."
---

The Gmail Watch plugin connects Eliza agents to Gmail, enabling monitoring of incoming emails and automated responses.

**Package:** `@elizaos/plugin-gmail-watch`

> **Note:** Gmail Watch is categorized as a **feature** plugin in the registry, not a connector. It provides Gmail Pub/Sub message watching and auto-renewal.

## Installation

```bash
eliza plugins install @elizaos/plugin-gmail-watch
```

## Setup

### 1. Enable the Feature Flag

The Gmail Watch plugin is activated via the `features.gmailWatch` flag in your Eliza configuration:

```json
{
  "features": {
    "gmailWatch": true
  }
}
```

### 2. Configure Gmail API Access

Follow the Google Cloud Console setup to enable the Gmail API and obtain OAuth credentials for your agent.

## Configuration

Gmail Watch is configured via both a feature flag and the `hooks.gmail` section:

| Field | Required | Description |
|-------|----------|-------------|
| `features.gmailWatch` | Yes | Set `true` to enable the Gmail Watch plugin |
| `hooks.gmail.account` | Yes | Gmail address to monitor |
| `hooks.gmail.label` | No | Gmail label to watch (default: `"INBOX"`) |
| `hooks.gmail.includeBody` | No | Include email body content in agent events |

```json
{
  "features": {
    "gmailWatch": true
  },
  "hooks": {
    "enabled": true,
    "gmail": {
      "account": "user@gmail.com",
      "label": "INBOX",
      "includeBody": true
    }
  }
}
```

## Related

- [Gmail Watch Connector](/connectors/gmail-watch) — Full connector documentation
- [Connectors Guide](/guides/connectors) — General connector documentation
