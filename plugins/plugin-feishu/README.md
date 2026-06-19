# @elizaos/plugin-feishu

Feishu (飞书) / Lark messaging connector for elizaOS agents. Connects an Eliza
agent to ByteDance's enterprise collaboration platform — Feishu for China, Lark
globally — over a persistent WebSocket event subscription using the Lark Open
Platform API (`@larksuiteoapi/node-sdk`).

The plugin registers a `FeishuService` that opens the WebSocket connection,
routes inbound messages to the agent runtime as standard elizaOS message events,
and exposes a message connector (`send_message`, `send_card`, `send_image`,
`send_file`). It is opt-in and auto-enables when a `feishu` connector block is
present in the agent config (see `auto-enable.ts`).

## Setup

### 1. Create a Feishu/Lark app

1. Open the [Feishu Open Platform](https://open.feishu.cn/) or
   [Lark Open Platform](https://open.larksuite.com/) and create an application.
2. Enable the **Bot** capability (send/receive messages) and **Event
   Subscription** in **long connection / WebSocket** mode.
3. Copy the App ID (`cli_xxx`) and App Secret from the credentials page.

### 2. Provide credentials

Set the env vars (read via `runtime.getSetting` in `src/environment.ts`):

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=your-app-secret
FEISHU_DOMAIN=feishu   # or "lark" for global
```

The env vars act as the `"default"` account. For multiple accounts, set
`character.settings.feishu` instead (see `src/accounts.ts`,
`FeishuMultiAccountConfig`).

### 3. Enable the connector

Add a `feishu` block to the character `connectors` config. The plugin
auto-enables when the block is present and not explicitly disabled:

```json
{
  "connectors": {
    "feishu": { "enabled": true }
  }
}
```

## Config

| Env var | Required | Default | Description |
|---|---|---|---|
| `FEISHU_APP_ID` | Yes | — | App ID (`cli_xxx` format; must start with `cli_`). |
| `FEISHU_APP_SECRET` | Yes | — | App secret for authentication. |
| `FEISHU_DOMAIN` | No | `feishu` | `feishu` (China, `open.feishu.cn`) or `lark` (global, `open.larksuite.com`). |
| `FEISHU_ALLOWED_CHATS` | No | `[]` | JSON array of chat IDs the bot may interact with. Empty = all chats. |
| `FEISHU_IGNORE_BOT_MESSAGES` | No | `true` | Set `"false"` to process messages from other bots. |
| `FEISHU_RESPOND_ONLY_TO_MENTIONS` | No | `false` | Set `"true"` to respond only when @-mentioned. |
| `FEISHU_TEST_CHAT_ID` | No | — | Chat ID used by the test suite. |

## Supported message types

Text, rich text (`post`), interactive cards, images, and files. Outbound text is
chunked at `FEISHU_TEXT_CHUNK_LIMIT` (4000 chars) via `chunkFeishuText` in
`src/formatting.ts`.

## Events emitted

`FeishuEventTypes` (`src/types.ts`): `FEISHU_WORLD_CONNECTED`,
`FEISHU_WORLD_JOINED`, `FEISHU_WORLD_LEFT`, `FEISHU_ENTITY_JOINED`,
`FEISHU_ENTITY_LEFT`, `FEISHU_ENTITY_UPDATED`, `FEISHU_MESSAGE_RECEIVED`,
`FEISHU_MESSAGE_SENT`, `FEISHU_REACTION_RECEIVED`, `FEISHU_INTERACTION_RECEIVED`,
`FEISHU_SLASH_START`.

## Commands

```bash
bun run --cwd plugins/plugin-feishu build         # bun run build.ts → dist/
bun run --cwd plugins/plugin-feishu dev           # bun --hot build.ts
bun run --cwd plugins/plugin-feishu test          # vitest run
bun run --cwd plugins/plugin-feishu lint          # biome check --write --unsafe
bun run --cwd plugins/plugin-feishu typecheck     # tsgo --noEmit
```

## Troubleshooting

- **Connection fails:** verify App ID / App Secret, confirm the Bot capability is
  enabled, and confirm Event Subscription is in WebSocket (long connection) mode.
  The service retries connection up to 5 times with exponential backoff.
- **Messages not received:** confirm the bot is added to the chat, and that the
  chat ID is in `FEISHU_ALLOWED_CHATS` (or that the list is empty).

Keep `FEISHU_APP_SECRET` out of source control. Restrict access in production
with `FEISHU_ALLOWED_CHATS`.

For internals (services, providers, layout, gotchas), see `CLAUDE.md`.
