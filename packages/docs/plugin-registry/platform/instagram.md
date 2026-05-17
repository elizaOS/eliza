---
title: "Instagram Plugin"
sidebarTitle: "Instagram"
description: "Instagram connector for Eliza — interact with Instagram messaging and content."
---

The Instagram plugin connects Eliza agents to Instagram, enabling message handling and content interactions.

**Package:** `@elizaos/plugin-instagram`

## Installation

```bash
eliza plugins install @elizaos/plugin-instagram
```

<Warning>
This plugin uses an unofficial API. Instagram may block automated access, lock accounts, or change endpoints without notice. Use a dedicated account — not your personal one. A proxy reduces the risk of IP-based blocks.
</Warning>

## Setup

### 1. Get Your Instagram Credentials

1. Create a dedicated Instagram account for your agent (do not use your personal account)
2. If you have 2FA enabled, you will need to provide a verification code on startup

### 2. Configure Eliza

```json
{
  "connectors": {
    "instagram": {
      "username": "YOUR_USERNAME",
      "password": "YOUR_PASSWORD"
    }
  }
}
```

Or via environment variables:

```bash
export INSTAGRAM_USERNAME=YOUR_USERNAME
export INSTAGRAM_PASSWORD=YOUR_PASSWORD
```

## Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `username` | Yes | Instagram account username |
| `password` | Yes | Instagram account password |
| `enabled` | No | Set `false` to disable (default: `true`) |
| `proxy` | No | Proxy URL for API requests (reduces rate-limit bans) |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `INSTAGRAM_USERNAME` | Yes | Instagram account username |
| `INSTAGRAM_PASSWORD` | Yes | Instagram account password |
| `INSTAGRAM_VERIFICATION_CODE` | No | 2FA code (required if 2FA is enabled) |
| `INSTAGRAM_PROXY` | No | Proxy URL to avoid rate limiting and IP blocks |

## Related

- [Connectors Guide](/guides/connectors) — General connector documentation
