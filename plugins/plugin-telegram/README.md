# @elizaos/plugin-telegram

Telegram connector for elizaOS. Gives an Eliza agent the ability to send and receive messages across Telegram private chats, groups, supergroups, channels, and forum topics.

## What it does

- Runs a Telegraf long-poll bot connected to the Telegram Bot API.
- Routes incoming messages and reactions through the elizaOS runtime so configured actions, providers, and evaluators can respond.
- Syncs Telegram chats, users, and group membership into the runtime as Worlds, Rooms, and Entities.
- Handles forum topics as separate Rooms (channelId format: `<chatId>-<threadId>`).
- Supports outgoing buttons (`login` and `url` kinds) via the `TelegramContent.buttons` field.
- Provides HTTP setup routes for bot-token configuration and GramJS user-account login.
- Supports multiple bot accounts per agent via `character.settings.telegram.accounts`.
- Preserves complete outbound text across Telegram's field limits: long messages are split losslessly, and media captions over 1024 UTF-16 units are delivered as follow-up text instead of clipped.

## Account connection status

Account inventory reports a bot connected only while its configured credential
has a healthy polling claim for the same agent and account. Saved account rows
and replacement credentials do not override that live state. Personal account
configuration alone remains pending until an identity-bound live session can be
verified. Connection status does not establish owner pairing or message delivery.

Service shutdown waits for each supervised polling loop to settle before its
credential can be claimed by a replacement. A stop requested during startup
also waits for the eventual loop; a failed stop retains ownership and reports
incomplete shutdown. Shutdown rejects new connector sends, edits and reactions and waits for those
already admitted to settle. Delivery failures still return to their original
callers. Direct Bot API calls and persisted account configuration are outside
this boundary; it is not a complete account-disconnect receipt.

## Delivery evidence

Text and interactive text sends return ordered provider IDs and local memory receipts. A later chunk failure retains earlier accepted IDs; a database failure after delivery is reported separately. Legacy attachment sends do not yet return a complete receipt and must not be treated as confirmed delivery by approval callers.

## Prerequisites

Create a bot via [@BotFather](https://t.me/BotFather) and copy the token it provides.

## Configuration

### Minimal (single bot, environment variable)

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
```

The plugin reads the token from the runtime setting `TELEGRAM_BOT_TOKEN` or `process.env.TELEGRAM_BOT_TOKEN`.

### Via character settings

```json
{
  "name": "MyAgent",
  "settings": {
    "telegram": {
      "botToken": "123456:ABC-DEF...",
      "apiRoot": "https://api.telegram.org"
    }
  }
}
```

### Multi-account

```json
{
  "settings": {
    "telegram": {
      "accounts": {
        "supportBot": { "botToken": "111:aaa", "allowedChats": ["-100123456"] },
        "announcementsBot": { "botToken": "222:bbb" }
      }
    }
  }
}
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes (default account) | Bot token from @BotFather |
| `TELEGRAM_API_ROOT` | No | Override Bot API base URL (e.g. local Bot API server). Default: `https://api.telegram.org` |
| `TELEGRAM_ALLOWED_CHATS` | No | JSON array of chat ID strings the bot will respond to; authoritative for every chat type when set. Example: `["-100123456789"]` |
| `TELEGRAM_DM_POLICY` | No | `open` / `pairing` / `allowlist` / `disabled` — gates private chats when no allowlist is configured. Default `pairing`: unknown senders get a one-time pairing code (core PairingService handshake) instead of full bot access, so an unconfigured bot is never default-open. Group chats are unaffected; a bot only sees groups it was invited to. |
| `TELEGRAM_TEST_CHAT_ID` | No | Chat ID used by the live smoke-test suite |

## Enabling the plugin

The plugin auto-enables when the `telegram` connector key is present in the agent connector config. To load it explicitly, add it to the agent's plugin list:

```json
{
  "plugins": ["@elizaos/plugin-telegram"]
}
```

## Setup UI routes

Bot setup reports `paired` only when the saved credential has a connected poller for this agent and the default account. A constructed service, another account, or the previous token does not establish readiness. Vault-backed credentials are resolved through the existing credential store; an unavailable credential returns an explicit error without exposing secret-store details. This status does not prove owner pairing or message delivery.

The plugin mounts these HTTP routes (no plugin-name prefix) for the dashboard setup wizard:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/setup/telegram/status` | Current pairing state |
| POST | `/api/setup/telegram/start` | Validate + save bot token |
| POST | `/api/setup/telegram/cancel` | Remove saved token |
| POST | `/api/setup/telegram/disconnect` | Disable and drain the managed default bot |
| GET | `/api/setup/telegram-account/status` | GramJS user-account auth state |
| POST | `/api/setup/telegram-account/start` | Begin GramJS login |
| POST | `/api/setup/telegram-account/submit-code` | Submit OTP or 2FA password |
| POST | `/api/setup/telegram-account/cancel` | Tear down GramJS session |

Explicit bot disconnect persists the disabled connector before draining polling and
admitted connector delivery. A terminal receipt means the bot is disconnected;
if credential cleanup fails, it separately reports the credential retained in
Vault, retaining a disabled reference so cleanup can be retried. Status reads do
not resolve disabled credentials: an unfinished drain stays configuring; a
completed disconnect stays idle even if Vault is locked. The setup panel restores saved, connected, and unfinished-disconnect states on
mount. Bot identity is persisted only after successful `getMe` validation; legacy
configurations without a verified identity require token revalidation. Successful
setup clears an earlier unfinished-drain marker. The request requires
`expectedBotId` from the displayed bot identity and rejects a replaced bot before
changing configuration. Saved credentials can be removed before a bot service is registered. A registered
but unfinished startup must settle before disconnect can report completion.
Setup mutations are serialized within one runtime and
configuration identity is rechecked after drain. This is a process-local shutdown,
not revocation of credentials or pollers running on other hosts. Named, personal and standalone sessions
must use their own account controls; this route rejects those scopes. The cancel
route retains its saved-token removal contract and is not a shutdown receipt.

## Sending buttons

Include a `buttons` array in any `Content` object returned to Telegram:

```typescript
callback({
  text: "Welcome! Click below to authenticate.",
  buttons: [
    {
      kind: "login",
      text: "Authenticate",
      url: "https://your-app.example.com/auth",
    },
  ],
});
```

Supported `kind` values: `"login"` (Telegram login widget), `"url"` (plain URL button).

## Owner pairing

The plugin registers a `/eliza_pair <code>` bot command that lets the Telegram user matching a 6-digit code shown in the agent dashboard bind their Telegram identity to the owner account. Rate-limited to 5 attempts per minute per user.

## 409 Conflict errors

The Telegram Bot API permits only one active long-poll connection per token. If two agent processes share the same token simultaneously, Telegram rejects the second with a 409 error. Full and standalone pollers share a process-local lock keyed by a fingerprint of the token; a live, starting, retrying, or merely quiet owner remains a hard launch failure. The lock becomes reclaimable only after that poller reaches an explicit terminal state. Across separate processes, operators must still ensure that only one process uses a given token at a time. Stopping the full service also fences queued failure retries so they cannot restart the old poller or reclaim its token.

## Development

```bash
bun run --cwd plugins/plugin-telegram build
bun run --cwd plugins/plugin-telegram test
bun run --cwd plugins/plugin-telegram lint
```

## Personal-account history

The `telegram-account` service connects the existing GramJS login to personal
history reads. It verifies the configured phone and saved provider subject,
then registers a separate `<accountId>:personal` read connector. Reads require
that exact connected OWNER account and its verified owner binding; bot tokens
and bot memory caches are never used as personal history.

Login sessions and unfinished authentication are encrypted under an agent/account
scope. Existing unscoped sessions are not automatically imported or assigned to
another runtime. Reconnect through personal-account setup to create a scoped
session, or explicitly configure a named account's personal session and API
credentials. Each connection verifies its Telegram identity before use.

An omitted history limit traverses all provider pages until exhaustion. An
explicit positive limit requests that many results; cursor-based continuation
is not currently accepted by the array-valued connector API. Provider errors,
non-progress pages, account changes, and unmapped room scopes reject the read
without a successful partial result. Peers and forum topics use Telegram's
history/replies APIs. Search traverses the requested peer, or all account dialogs
when no peer/room is requested, before applying an explicit match limit. Neither
history nor search marks messages as read. Raw provider message metadata retains
service events, deleted placeholders, entities and media references; media bytes
are not downloaded by a history read.

The focused deterministic tests use actual GramJS TL request/response objects
with controlled RPC responses. They cover a final-page sentinel, exact-page
exhaustion, scoped encrypted storage, restart, owner admission and lifecycle
races. They do not claim a live Telegram account acceptance run.
