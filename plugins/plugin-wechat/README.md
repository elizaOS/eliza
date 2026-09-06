# @elizaos/plugin-wechat

Direct first-party WeChat connector plugin for [elizaOS](https://github.com/elizaOS/eliza)
(Official Account / WeCom self-built apps).

Adds WeChat messaging to an Eliza agent over the official platform APIs — no
third-party proxy. The plugin runs a public callback HTTP server for
signature-verified inbound delivery (SHA-1 checks; AES-encrypted mode for WeCom
and Official Account safe mode) and sends replies through the official
customer-service (`message/custom/send`) and WeCom app-message
(`message/send`) endpoints against the fixed `api.weixin.qq.com` /
`qyapi.weixin.qq.com` hosts.

## Features

- WeChat Official Account mode (plaintext or encrypted callback security)
- WeCom self-built application mode (always-encrypted callbacks)
- Multi-account support with per-account observational health
  (configuration alone is never "connected")
- Webhook-based inbound delivery with signature-first verification,
  cross-account replay rejection, and deduplication
- Observed-only connector targets (derived from verified inbound senders —
  the first-party platforms have no roster API)
- Personal WeChat explicitly unsupported (no first-party API exists)

## Install

```bash
npx elizaos plugins add @elizaos/plugin-wechat
```

## Configuration

All configuration lives under `connectors.wechat` in character settings.
Legacy `WECHAT_API_KEY` / `WECHAT_PROXY_URL` environment variables configured
the removed proxy transport and now fail with a typed migration error.

### WeChat Official Account (official-account mode)

```jsonc
{
  "connectors": {
    "wechat": {
      "account": {
        "mode": "official-account",
        "appId": "wx1234",
        "appSecret": "<secret>",
        "token": "<callback signature token>",
        "encodingAESKey": "<43-char key>",       // only for encrypted security mode
        "messageSecurityMode": "plaintext"       // or "encrypted"
      }
    }
  }
}
```

### WeCom self-built application (wecom mode)

```jsonc
{
  "connectors": {
    "wechat": {
      "accounts": {
        "corp": {
          "mode": "wecom",
          "corpId": "ww1234",
          "agentId": 1000002,
          "corpSecret": "<secret>",
          "token": "<callback token>",
          "encodingAESKey": "<43-char key>"
        }
      }
    }
  }
}
```

### Receiver binding (`callbackId`)

Inbound `ToUserName` / the decrypted receiver id is the account's WeChat
original ID (`gh_...`), not the appId — the appId is only the token-API
identity. Set `callbackId` to the original ID to enable receiver binding for
an official account; when omitted, receiver binding is skipped rather than
mis-verified against the appId. WeCom binds automatically to the corpId (set
`callbackId` only to override), and payloads carrying `AgentID` must match the
configured `agentId`.

### Callback exposure

The plugin listens on `0.0.0.0:<callbackPort>` (default 18790) with one path
per account (`/webhook/wechat/<accountId>`). Configure that URL in the MP /
WeCom admin console out of band — the plugin never registers it anywhere.
Deploy behind TLS termination on a platform-supported port (80/443).

### Unsupported modes

- **Personal WeChat** — no legitimate first-party API exists; pad/mac protocol
  proxies are exactly the third-party dependency this plugin removed.
  Configuring `mode: "personal"` fails with
  `WECHAT_PERSONAL_MODE_UNSUPPORTED`.
- **WeCom third-party (suite) apps** — the suite-ticket authorization
  lifecycle is not implemented; self-built apps only.

## Security model

- Every callback request is signature-verified (SHA-1 over the sorted
  token/timestamp/nonce[/ciphertext] parts) against the addressed account
  **before** any parsing, decryption, memory creation, or evidence
  publication. Encrypted payloads additionally validate the embedded receiver
  id, so a ciphertext signed for one account cannot be replayed against
  another.
- Secrets (`appSecret`, `corpSecret`, `token`, `encodingAESKey`) are never
  logged, never copied into connector-account metadata, and never included in
  published evidence.
- Account status is observational: `pending` until a successful token probe
  or verified callback, `connected` on observation, `error` when degraded or
  unavailable. A failed startup probe marks the account unavailable — the
  connector never reports fake health.

## License

MIT
