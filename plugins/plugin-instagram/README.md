# @elizaos/plugin-instagram

Instagram DM and public-comment connector for [elizaOS](https://github.com/elizaos/eliza) agents.

## What it does

Adds Instagram integration to an Eliza agent:

- **Direct messages** — agent can send DMs to existing Instagram threads via the `MESSAGE` connector.
- **Media comments** — agent can post and reply to comments on Instagram media via the `POST` connector.
- **User lookup** — resolves Instagram usernames/handles to entity objects the runtime can reason about.
- **Thread browsing** — lists and searches DM threads so the runtime can pick the right target.
- **Multi-account** — configure multiple Instagram accounts; each gets its own connector pair.
- **Workflow credentials** — supplies a `facebookGraphApi` token to workflow plugin nodes when `INSTAGRAM_PAGE_ACCESS_TOKEN` is set.

> **Note:** The connector and credential plumbing is complete, but this package does not ship a
> concrete Instagram API client backend. Runtime API methods fail explicitly until a backend such as
> `instagram-private-api` or an approved Graph API adapter is wired into `src/service.ts`.

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
| `INSTAGRAM_USERNAME` | **Yes** | Instagram username |
| `INSTAGRAM_PASSWORD` | **Yes** | Instagram password |
| `INSTAGRAM_VERIFICATION_CODE` | No | 2FA code if account has it enabled |
| `INSTAGRAM_PROXY` | No | HTTP/SOCKS proxy URL for API requests |
| `INSTAGRAM_AUTO_RESPOND_DMS` | No | `"true"` to auto-respond to DMs |
| `INSTAGRAM_AUTO_RESPOND_COMMENTS` | No | `"true"` to auto-respond to comments |
| `INSTAGRAM_POLLING_INTERVAL` | No | Poll interval in seconds (default: `60`) |
| `INSTAGRAM_PAGE_ACCESS_TOKEN` | No | Meta Graph API page access token for workflow nodes |
| `INSTAGRAM_ACCOUNTS` | No | JSON array/object of additional account configs for multi-account |

### Character-level config

```json
{
  "settings": {
    "instagram": {
      "username": "mybot",
      "password": "secret",
      "autoRespondToDms": true,
      "accounts": {
        "brand-a": { "username": "brand_a", "password": "..." }
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

## Development

```bash
bun run --cwd plugins/plugin-instagram build       # compile
bun run --cwd plugins/plugin-instagram dev         # watch
bun run --cwd plugins/plugin-instagram test        # unit tests
bun run --cwd plugins/plugin-instagram typecheck   # type-check only
bun run --cwd plugins/plugin-instagram lint        # lint + autofix
```
