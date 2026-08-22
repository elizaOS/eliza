# @elizaos/plugin-instagram

Instagram DM and public-comment connector for [elizaOS](https://github.com/elizaos/eliza) agents.

## What it does

Adds Instagram integration to an Eliza agent:

- **Direct messages** — agent can send DMs to existing Instagram threads via the `MESSAGE` connector.
- **Media comments** — agent can post and reply to comments on Instagram media via the `POST` connector.
- **User lookup** — resolves consented Instagram-scoped IDs from messaging interactions.
- **Thread browsing** — lists and searches DM threads so the runtime can pick the right target.
- **Multi-account** — configure multiple Instagram accounts; each gets its own connector pair.

The connector uses Meta's official Instagram Graph API for approved professional accounts. It does
not log in with an Instagram username/password, automate consumer accounts, or use private/mobile
scraping APIs. The Meta app and account must have the provider permissions required for each
enabled operation.

Protocol behavior follows Meta's official [Instagram API collection](https://www.postman.com/meta/instagram/collection/6yqw8pt/instagram-api), including the Instagram Login
[Conversations API](https://www.postman.com/meta/instagram/folder/23987686-6a91368f-1fa8-4614-9ed6-7d1e08c21e62) and [User Profile API](https://www.postman.com/meta/instagram/folder/23987686-22b3a5b0-4a51-449a-9299-e3667d69b182).

## Installation

```bash
bun add @elizaos/plugin-instagram
```

## Usage

```typescript
import instagramPlugin from "@elizaos/plugin-instagram";

const agent = new AgentRuntime({
  plugins: [instagramPlugin],
  // ...
});
```

## Configuration

Set credentials via environment variables (single account) or in `character.settings.instagram`
(single or multi-account).

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `INSTAGRAM_GRAPH_ACCOUNT_ID` | **Yes** | Instagram professional account ID associated with the token |
| `INSTAGRAM_ACCESS_TOKEN` | **Yes** | Approved Instagram Graph API access token |
| `INSTAGRAM_APP_SECRET` | For webhooks | Meta app secret used to validate `X-Hub-Signature-256` |
| `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` | For webhooks | Secret used for webhook subscription verification |
| `INSTAGRAM_GRAPH_API_VERSION` | No | Explicit Graph API version (default: `v24.0`) |
| `INSTAGRAM_GRAPH_BASE_URL` | No | Graph origin; HTTPS except literal loopback HTTP in tests |
| `INSTAGRAM_REQUEST_TIMEOUT_MS` | No | Request deadline in milliseconds (default: `15000`) |
| `INSTAGRAM_AUTO_RESPOND_DMS` | No | `"true"` to auto-respond to DMs |
| `INSTAGRAM_AUTO_RESPOND_COMMENTS` | No | `"true"` to auto-respond to comments |
| `INSTAGRAM_POLLING_INTERVAL` | No | Poll interval in seconds (default: `60`) |
| `INSTAGRAM_ACCOUNTS` | No | JSON array/object of additional account configs for multi-account. Invalid JSON/primitives fail closed; junk entries are skipped; IDs are trimmed and must remain unique after trimming. |

### Character-level config

```json
{
  "settings": {
    "instagram": {
      "instagramAccountId": "17841400000000000",
      "accessToken": "stored-in-a-secret-provider",
      "appSecret": "stored-as-a-secret",
      "webhookVerifyToken": "stored-as-a-secret",
      "autoRespondToDms": true,
      "accounts": {
        "brand-a": {
          "instagramAccountId": "17841400000000001",
          "accessToken": "separate-account-token"
        }
      }
    }
  }
}
```

## Event types

These event type strings are defined in `InstagramEventType` (exported from the package):

| Event | Description |
|---|---|
| `INSTAGRAM_MESSAGE_RECEIVED` | Incoming DM |
| `INSTAGRAM_MESSAGE_SENT` | Outgoing DM sent |
| `INSTAGRAM_COMMENT_RECEIVED` | Comment received on a post |
| `INSTAGRAM_LIKE_RECEIVED` | Like received on a post |
| `INSTAGRAM_FOLLOW_RECEIVED` | New follower |
| `INSTAGRAM_UNFOLLOW_RECEIVED` | Lost a follower |
| `INSTAGRAM_STORY_VIEWED` | Story viewed |
| `INSTAGRAM_STORY_REPLY_RECEIVED` | Reply to a story |

## Supported capability truth

- Professional-account conversation listing, message reads, one-to-one text sends, public media
  comments/replies, scoped profile lookup, and owned-media reads use the production client.
- Redirects, cross-origin paging cursors, malformed or oversized responses, and unencrypted remote
  origins fail closed. Ambiguous writes are not automatically retried because these calls expose no
  provider idempotency key.
- Consumer-account login, arbitrary username discovery, third-party media reads, follow/unfollow,
  media like/unlike, and private mobile API behavior are deliberately unsupported. The connector
  never fabricates success for them.
- Webhook helpers validate the raw-body signature before parsing and produce stable account-scoped
  event IDs. HTTP route ownership, durable persist-before-process ingress, and shared synthetic
  reset/ledger composition remain tracked by #24093 and #24076-#24078.

## Development

```bash
bun run --cwd plugins/plugin-instagram build       # compile
bun run --cwd plugins/plugin-instagram dev         # watch
bun run --cwd plugins/plugin-instagram test        # unit tests
bun run --cwd plugins/plugin-instagram typecheck   # type-check only
bun run --cwd plugins/plugin-instagram lint        # lint + autofix
```
