# @elizaos/plugin-wechat

WeChat connector plugin for elizaOS via the first-party platform APIs.

## Purpose / Role

Adds WeChat messaging to an Eliza agent over the official platform APIs — WeChat
Official Account (MP) and WeCom (Enterprise WeChat) self-built applications.
There is no third-party proxy: the plugin runs a public HTTP callback server for
signature-verified inbound delivery (SHA-1 over sorted parts; AES-256-CBC
encrypted mode for WeCom and Official Account safe/compatible mode, using the
platform's 32-byte PKCS#7 scheme with a Tencent-reference wire format) and sends
replies through the official customer-service (`message/custom/send`) and WeCom
app-message (`message/send`) endpoints against the fixed `api.weixin.qq.com` /
`qyapi.weixin.qq.com` hosts. It registers a `MessageConnector` with the runtime
so the agent can resolve contacts and send text. Personal WeChat has no
first-party API and is rejected with a typed error; the legacy proxy transport
was removed and its env keys fail with a typed migration error.

Auto-enabled when a `connectors.wechat` block is present in character config
and `enabled` is not `false`. The entry point is `auto-enable.ts`
(`elizaos.plugin.autoEnableModule`).

## Plugin Surface

No elizaOS `actions`, `providers`, or `evaluators`. Runtime extension points:

- **MessageConnector** (`source: "wechat"`) — registered with the runtime's
  `registerMessageConnector` (or `registerSendHandler` fallback). Capabilities:
  `send_message`, `resolve_targets`, `chat_context`. There is no roster API on
  the first-party platforms, so targets are derived exclusively from
  signature-verified inbound senders (observed evidence). Supports target kinds
  `user`, `group`, `room`. Contexts: `social`, `connectors`.
- **ConnectorAccountProvider** (`provider: "wechat"`) — registered with
  `ConnectorAccountManager` on init. Surfaces configured accounts with
  observational status (connected requires a real first-party observation:
  token probe, send receipt, or verified callback). Reads from
  `character.settings.connectors.wechat`.

## Layout

```
plugins/plugin-wechat/
  auto-enable.ts              # Lightweight auto-enable check (env reads only)
  src/
    index.ts                  # Plugin definition, init/dispose, connector wiring
    types.ts                  # WechatConfig, ResolvedWechatAccount, WechatError, receipts, health
    channel.ts                # WechatChannel — lifecycle orchestrator, resolveDirectAccount
    bot.ts                    # Bot — deduplication of inbound messages
    api-client.ts             # WechatApiClient — outbound first-party sends
    token-manager.ts          # TokenManager — account-scoped access tokens, single-flight
    callback-server.ts        # Public callback HTTP server; signature-first verification
    callback-crypto.ts        # SHA-1 verification, AES-256-CBC decrypt/encrypt (32B PKCS#7)
    xml.ts                    # Hardened flat-XML parser (CDATA leaf values supported)
    reply-dispatcher.ts       # ReplyDispatcher — Unicode-safe chunked text send
    runtime-bridge.ts         # deliverIncomingWechatMessage — bridges to runtime pipeline
    connector-account-provider.ts # ConnectorAccountProvider for ConnectorAccountManager
    delivery-error.ts         # WechatDeliveryError — retryability classification
    index.test.ts             # Config resolution + dispatcher + error contracts
    callback-server.test.ts   # Real-listener callback boundary tests
    callback-crypto.test.ts   # Crypto + XML hardening tests (official Tencent vectors)
    callback-utf8.test.ts     # Inbound UTF-8 chunk-boundary integrity
    token-manager.test.ts     # Token lifecycle tests
    connector-account-provider.test.ts # Provider tests
```

## Commands

```bash
bun run --cwd plugins/plugin-wechat build       # tsup + tsc declaration emit
bun run --cwd plugins/plugin-wechat typecheck   # tsc --noEmit -p tsconfig.json
bun run --cwd plugins/plugin-wechat test        # vitest run
bun run --cwd plugins/plugin-wechat test:watch  # vitest watch
bun run --cwd plugins/plugin-wechat lint        # biome check --write --unsafe
bun run --cwd plugins/plugin-wechat lint:check  # biome check (read-only)
bun run --cwd plugins/plugin-wechat format      # biome format --write
bun run --cwd plugins/plugin-wechat format:check # biome format (read-only)
bun run --cwd plugins/plugin-wechat clean       # rm -rf dist
```

## Config

All config lives under `connectors.wechat` in character settings. Legacy
`WECHAT_API_KEY` / `WECHAT_PROXY_URL` env keys configured the removed proxy
transport and now fail with `WECHAT_PROXY_CONFIG_UNSUPPORTED`.

```jsonc
{
  "connectors": {
    "wechat": {
      "callbackPort": 18790,          // optional public callback port
      "account": { /* single account */ },
      "accounts": { /* or multi-account map */ }
    }
  }
}
```

Official Account account block:

```jsonc
{
  "mode": "official-account",
  "appId": "wx...",                  // token API identity
  "appSecret": "<secret>",
  "token": "<callback signature token>",
  "encodingAESKey": "<43 chars>",    // required when messageSecurityMode is "encrypted"
  "messageSecurityMode": "plaintext", // "plaintext" | "encrypted"
  "callbackId": "gh_..."             // optional: WeChat original ID; enables ToUserName receiver binding
}
```

WeCom self-built app account block (always encrypted):

```jsonc
{
  "mode": "wecom",
  "corpId": "ww...",
  "corpSecret": "<secret>",
  "agentId": 1000002,
  "token": "<callback signature token>",
  "encodingAESKey": "<43 chars>",
  "callbackId": "ww..."              // optional override; defaults to corpId
}
```

`mode: "personal"`, `mode: "proxy"`, and `mode: "wecom-third-party"` are
rejected with dedicated typed errors.

## How to Extend

- **Add a send capability:** extend `WechatApiClient` with the new endpoint,
  then call it from `ReplyDispatcher` or the connector's send handler.
- **Support a new message type:** extend the `MsgType` switch in
  `normalizePlatformXml` (`src/callback-server.ts`).
- **Add an action/provider:** create `src/actions/my-action.ts` implementing
  `@elizaos/core` `Action` (or a `Provider`) and register it in `src/index.ts`.

## Conventions / Gotchas

- **First-party only.** Fixed platform hosts; no proxy, no configurable base
  URL. Personal WeChat has no API and is unsupported.
- **Callback security.** The security mode comes from the resolved account,
  never from request shape — an encrypted-mode account cannot be downgraded to
  the plaintext verification path. Signature verification happens before any
  payload parsing; the decrypted receiver id is bound to the account's
  `callbackIdentity` (corpId for WeCom; gh_ original ID for Official Account
  when `callbackId` is configured — the appId is never mis-used as the inbound
  receiver identity). WeCom payloads carrying an `AgentID` must match the
  account's configured `agentId`.
- **AES wire format.** WeChat's scheme applies its own 32-byte PKCS#7 padding;
  Node's 16-byte auto-padding is disabled on both directions. Padding is
  stripped per Tencent's reference (last byte, 1..32) without a consistency
  loop — the platform's own sample vectors carry non-uniform padding bytes and
  integrity is carried by the SHA-1 signature.
- **XML shape.** Platform envelopes wrap leaf values in CDATA and separate
  children with newlines; the hardened parser supports exactly that flat shape
  and rejects DTDs, entities, nesting, and duplicate roots. Parsing happens
  only after signature verification.
- **Webhook port.** The callback server binds `0.0.0.0` (the platform must
  reach it) on `callbackPort` (default 18790). Accounts are addressed by path
  (`/webhook/wechat/<accountId>`); a ciphertext signed for one account can
  never be accepted for another.
- **Outbound receipts are enforced.** A platform rejection (`{ok:false}`), a
  non-zero `errcode`, or a missing/unparseable body is a failed send: outbound
  health degrades and the dispatcher throws — receipts are never discarded.
- **Message dedup.** `Bot` tracks seen message IDs in a 30-minute window,
  makes concurrent duplicates await the owning delivery, and keeps a failed
  delivery claimed when an outbound side effect already occurred.
- **Connector target inventories are complete.** Resolution and recent-target
  discovery consider every configured account's observed targets. Do not
  silently slice these model-facing lists.
- **Chunking.** `ReplyDispatcher` breaks outgoing text at 2 000-character
  boundaries (newline > space > hard cut) with Unicode-safe truncation;
  whitespace is preserved exactly across chunk boundaries.
- **Error policy.** `WechatError` extends core `ElizaError` with a stable
  `code`, structured `context`, and preserved `cause`. Use the structured
  `logger` from `@elizaos/core` — never `console` — in runtime paths.
- **Auto-enable.** `auto-enable.ts` must stay import-free of the full plugin
  runtime — it is loaded by the auto-enable engine for every plugin at boot.
- **`WECHAT_PLUGIN_PACKAGE`** — exported constant naming this package for
  dependency declarations.
