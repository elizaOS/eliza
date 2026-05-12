# Feishu / Lark Connector

Connect your agent to Feishu (known as Lark outside China) for bot interactions, group chats, and workflow notifications using the `@elizaos/plugin-feishu` package.

## Prerequisites

- A Feishu/Lark Custom App with Bot capability enabled
- App ID and App Secret from the [Feishu Open Platform](https://open.feishu.cn/) or [Lark Developer](https://open.larksuite.com/)

## Configuration

| Name | Required | Description |
|------|----------|-------------|
| `FEISHU_APP_ID` | Yes | Feishu/Lark application ID (`cli_xxx` format) for bot authentication |
| `FEISHU_APP_SECRET` | Yes | Feishu/Lark application secret for bot authentication |
| `FEISHU_DOMAIN` | No | Domain to use: `feishu` for China or `lark` for global |
| `FEISHU_ALLOWED_CHATS` | No | JSON-encoded array of chat IDs authorized to interact with the bot |
| `FEISHU_TEST_CHAT_ID` | No | Chat ID used by the test suite for validation |

## Minimal Configuration

The connector auto-enables when one of the generic trigger fields (`token`, `botToken`, or `apiKey`) is present in the connector config. Environment variables alone do not trigger auto-enable. Here the `apiKey` field is set to the Feishu app secret to trigger auto-enable; actual authentication uses `FEISHU_APP_ID` and `FEISHU_APP_SECRET`.

```json
{
  "env": {
    "FEISHU_APP_ID": "cli_your_app_id",
    "FEISHU_APP_SECRET": "your_app_secret"
  },
  "connectors": {
    "feishu": {
      "apiKey": "your_app_secret"
    }
  }
}
```

The connector auto-enables when `token`, `botToken`, or `apiKey` is truthy in the connector config. Environment variables alone do not trigger auto-enable.

## Setup

1. Go to the [Feishu Open Platform](https://open.feishu.cn/) (or [Lark Developer](https://open.larksuite.com/) for global).
2. Create a new Custom App and note the **App ID** and **App Secret**.
3. Under **Bot**, enable the bot capability for your app.
4. Configure **Event Subscriptions** with a request URL pointing to your Eliza instance.
5. Add the required permissions: `im:message`, `im:message.group_at_msg`, `im:message.p2p_msg`.
6. Publish the app version and have an admin approve it.
7. Add the credentials to your Eliza config.

## Features

- **Bot messaging** -- Respond to direct messages from users
- **Group chats** -- Participate in group conversations
- **Chat allowlist** -- Restrict the bot to specific authorized chats
- **China and global support** -- Works with both `feishu.cn` and `larksuite.com` domains

## Related

- [Feishu plugin reference](/plugin-registry/platform/feishu)
- [Connectors overview](/guides/connectors)
- [Configuration reference](/configuration)
