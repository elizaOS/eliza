# Instagram Connector

Connect your agent to Instagram for media posting, comment monitoring, and DM handling using the `@elizaos/plugin-instagram` package.

## Prerequisites

The Instagram connector is an elizaOS plugin that bridges your agent to Instagram. It supports media posting with caption generation, comment response, and direct message handling. This connector is available from the plugin registry.

## Package Info

| Field | Value |
|-------|-------|
| Package | `@elizaos/plugin-instagram` |
| Config key | `connectors.instagram` |
| Install | `eliza plugins install @elizaos/plugin-instagram` |

## Setup Requirements

- Instagram account credentials (username and password)

## Configuration

| Name | Required | Description |
|------|----------|-------------|
| `INSTAGRAM_USERNAME` | Yes | Instagram username for authentication |
| `INSTAGRAM_PASSWORD` | Yes | Instagram password for authentication |
| `INSTAGRAM_PROXY` | No | Proxy URL for Instagram API requests |
| `INSTAGRAM_VERIFICATION_CODE` | No | Two-factor authentication verification code |

Install the plugin from the registry:

```bash
eliza plugins install instagram
```

Configure in `~/.eliza/eliza.json`:

```json
{
  "connectors": {
    "instagram": {
      "enabled": true
    }
  }
}
```

## Setup

1. Install the plugin: `eliza plugins install instagram`.
2. Set `INSTAGRAM_USERNAME` and `INSTAGRAM_PASSWORD` as environment variables or in your config.
3. If your account has 2FA enabled, provide the `INSTAGRAM_VERIFICATION_CODE` when prompted.
4. Optionally configure a proxy with `INSTAGRAM_PROXY`.
5. Start your agent.

## Features

- Media posting with caption generation
- Comment monitoring and response
- DM handling
- Proxy support for API requests
- Two-factor authentication support

## Related

- [Instagram plugin reference](/plugin-registry/platform/instagram)
- [Connectors overview](/guides/connectors#instagram)
