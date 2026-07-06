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
bun run --cwd plugins/plugin-wechat typecheck   # tsgo --noEmit -p tsconfig.json
bun run --cwd plugins/plugin-wechat test        # vitest run
bun run --cwd plugins/plugin-wechat test:watch  # vitest watch
bun run --cwd plugins/plugin-wechat lint        # biome check --write --unsafe
bun run --cwd plugins/plugin-wechat lint:check  # biome check (read-only)
bun run --cwd plugins/plugin-wechat format      # biome format --write
bun run --cwd plugins/plugin-wechat format:check # biome format (read-only)
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

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — platform connector:**
- A real (or sandbox-account) round-trip on the platform: inbound message → agent → outbound reply, captured as logs **and** a screenshot/recording of the actual conversation.
- The raw inbound event/webhook payload and the outbound API request/response, with IDs mapped correctly (`stringToUuid` / `createUniqueUuid`).
- Attachments, threads/replies, edits, multi-account, and rate-limit/error paths — not just a single text ping.
- The agent trajectory for the turn the connector drove.
<!-- END: evidence-and-e2e-mandate -->
