# @elizaos/plugin-wechat

WeChat connector plugin for elizaOS via proxy API.

## Purpose / Role

Adds WeChat DM and group messaging capability to an Eliza agent. The plugin
connects to a third-party WeChat proxy service (not the official WeChat API)
using an API key. It starts a local HTTP webhook server to receive inbound
messages and dispatches them through the elizaOS message pipeline. It registers
a `MessageConnector` with the runtime so the agent can resolve contacts, list
rooms, fetch message history, send text, and send images.

Auto-enabled when a `connectors.wechat` block is present in character config
and `enabled` is not `false`. The entry point is `auto-enable.ts`
(`elizaos.plugin.autoEnableModule`).

## Plugin Surface

This plugin has no elizaOS `actions`, `providers`, `evaluators`, or `routes` in
the conventional sense. It integrates via these runtime extension points:

- **MessageConnector** (`source: "wechat"`) — registered with the runtime's
  `registerMessageConnector` (or `registerSendHandler` fallback). Capabilities:
  `send_message`, `resolve_targets`, `list_rooms`, `chat_context`. Supports
  target kinds `user`, `group`, `room`. Contexts: `social`, `connectors`.
- **ConnectorAccountProvider** (`provider: "wechat"`) — registered with
  `ConnectorAccountManager` on init. Surfaces configured accounts to the
  connector account UI. Reads from `character.settings.connectors.wechat` or
  falls back to env.

## Layout

```
plugins/plugin-wechat/
  auto-enable.ts              # Lightweight auto-enable check (env reads only)
  src/
    index.ts                  # Plugin definition, init/dispose, connector wiring
    types.ts                  # WechatConfig, WechatMessageContext, AccountStatus, ProxyApiResponse
    channel.ts                # WechatChannel — lifecycle orchestrator per account
    bot.ts                    # Bot — deduplication + feature-gating of inbound msgs
    proxy-client.ts           # ProxyClient — HTTPS client to the proxy service
    callback-server.ts        # Webhook HTTP server; normalizes proxy payloads
    reply-dispatcher.ts       # ReplyDispatcher — chunked text/image send
    runtime-bridge.ts         # deliverIncomingWechatMessage — bridges to runtime pipeline
    connector-account-provider.ts # ConnectorAccountProvider for ConnectorAccountManager
    utils/qrcode.ts           # displayQRUrl — prints QR code login URL to terminal
    index.test.ts             # Unit tests
    connector-account-provider.test.ts # Unit tests for ConnectorAccountProvider
```

## Commands

```bash
bun run --cwd plugins/plugin-wechat build       # tsup + tsc declaration emit
bun run --cwd plugins/plugin-wechat check       # tsc type-check (no emit)
bun run --cwd plugins/plugin-wechat test        # vitest run
bun run --cwd plugins/plugin-wechat test:watch  # vitest watch
bun run --cwd plugins/plugin-wechat clean       # rm -rf dist
```

## Config / Env Vars

All config is read through `resolveWechatConfig` in `src/index.ts`, which
checks `config.connectors.wechat` first, then falls back to runtime settings.

| Var / Config Key | Required | Description |
|---|---|---|
| `WECHAT_API_KEY` | Yes (single-account) | Proxy service API key |
| `WECHAT_PROXY_URL` | Yes (single-account) | Base URL of the WeChat proxy (`https://`) |
| `ELIZA_WECHAT_WEBHOOK_PORT` | No | Override webhook listener port (default: 18790) |

Character config block (`connectors.wechat`):

```jsonc
{
  "connectors": {
    "wechat": {
      "apiKey": "...",
      "proxyUrl": "https://your-proxy.example.com",
      "webhookPort": 18790,           // optional
      "deviceType": "ipad",           // "ipad" | "mac", default "ipad"
      "loginTimeoutMs": 300000,       // default 5 min
      "features": { "images": true, "groups": true },
      "accounts": {                   // multi-account alternative to top-level apiKey
        "main": { "apiKey": "...", "proxyUrl": "https://..." }
      }
    }
  }
}
```

`proxyUrl` must be `https://`; credentials in the URL are rejected.

## How to Extend

**Add an action:** Create `src/actions/my-action.ts` implementing
`@elizaos/core` `Action`. Register it in `src/index.ts` by adding an `actions`
array to the `wechatPlugin` object (see root `AGENTS.md` for the Action shape).

**Add a provider:** Create `src/providers/my-provider.ts` implementing
`Provider`. Add a `providers` array to `wechatPlugin` in `src/index.ts`.

**Add a new send capability:** Extend `ProxyClient` with the new API method,
then call it from `ReplyDispatcher` or directly from the connector's send
handler in `src/index.ts`.

**Add a new proxy endpoint:** Add the method to `ProxyClient.request` (POST
only; all proxy calls are POST). Handle the response code pattern
(`SUCCESS=1000`, `LOGIN_NEEDED=1001`).

**Support a new message type code:** Add the numeric code → `WechatMessageType`
mapping to `WECHAT_TYPE_MAP` in `src/callback-server.ts`.

## Conventions / Gotchas

- **Proxy-only.** There is no direct WeChat API access. All calls go through an
  HTTPS proxy service. The proxy URL must be `https://` with no embedded creds.
- **Login flow.** On first start (or after session expiry), `WechatChannel`
  polls for QR-code login. `displayQRUrl` prints the URL; the user must scan it
  via the WeChat mobile app within `loginTimeoutMs` (default 5 min).
- **Webhook port.** The local HTTP server (`src/callback-server.ts`) listens on
  `ELIZA_WECHAT_WEBHOOK_PORT` → `config.webhookPort` → `18790`. In multi-account
  mode, accounts sharing a port share one server; each gets its own URL path
  (`/webhook/wechat/<accountId>`). Port conflicts throw at startup.
- **Message dedup.** `Bot` tracks seen message IDs in a 30-minute window (max
  1 000 entries) to prevent double-processing webhook retries.
- **Chunking.** `ReplyDispatcher` breaks outgoing text at 2 000-character
  boundaries (newline > space > hard cut) because WeChat enforces a per-message
  size limit.
- **Auto-enable.** `auto-enable.ts` must stay import-free of the full plugin
  runtime — it is loaded by the auto-enable engine for every plugin at boot.
- **`WECHAT_PLUGIN_PACKAGE`** — exported constant (`"@elizaos/plugin-wechat"`)
  used for internal identification.
- See root `AGENTS.md` for repo-wide rules (logger, ESM, architecture layers).
