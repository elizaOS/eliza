# @elizaos/plugin-bluesky

AT Protocol (BlueSky) social client for elizaOS agents.

## Purpose / role

Adds BlueSky integration to any Eliza agent: public-feed posting, direct messages via `chat.bsky`, and notification polling. Loaded as a standard elizaOS plugin (`blueSkyPlugin` exported from `index.ts`). Opt-in — initialization is unavailable unless `BLUESKY_HANDLE` and `BLUESKY_PASSWORD` are configured (or when `BLUESKY_ENABLED` is explicitly `false`). Supports multiple BlueSky handles per agent via `BLUESKY_ACCOUNTS` JSON or `character.settings.bluesky.accounts`.

## Plugin surface

**Services** (registered in `plugin.services`):
- `BlueSkyService` — singleton orchestrator; authenticates one `BlueSkyClient` per configured account, starts `BlueSkyAgentManager`, `BlueSkyMessageService`, and `BlueSkyPostService` per account. Registers message and post connectors with the runtime on startup.
- `BlueskyWorkflowCredentialProvider` — supplies Bluesky `httpHeaderAuth` credentials to the workflow plugin; duck-typed on `"workflow_credential_provider"` service type.

**Actions:** none registered.

**Providers:** none registered in the plugin object. A `ConnectorAccountProvider` (`createBlueSkyConnectorAccountProvider`) is registered with `ConnectorAccountManager` inside `plugin.init` — not a runtime provider.

**Evaluators:** none.

**Routes:** none.

**Events emitted** (via `runtime.emitEvent`):
| Event | Trigger |
|---|---|
| `bluesky.mention_received` | Incoming mention or reply notification |
| `bluesky.follow_received` | New follower notification |
| `bluesky.like_received` | Like notification |
| `bluesky.repost_received` | Repost notification |
| `bluesky.quote_received` | Quote notification |
| `bluesky.should_respond` | Mention/reply reaching action-processing cycle |
| `bluesky.create_post` | Automated posting timer fires |

**Runtime connectors registered:**
- Message connector (`source: "bluesky"`) — DM send/receive, target resolution, room listing.
- Post connector (`source: "bluesky"`) — public-post publishing, feed fetch, post search.

## Layout

```
plugins/plugin-bluesky/
├── index.ts                        Plugin export (blueSkyPlugin); PluginConfig interface
├── index.node.ts                   Re-exports index.ts (node entrypoint)
├── index.browser.ts                Re-exports index.ts (browser entrypoint)
├── client.ts                       BlueSkyClient — wraps @atproto/api BskyAgent;
│                                   authenticate, sendPost, sendMessage, getTimeline,
│                                   searchPosts, getNotifications, getConversations,
│                                   getMessages, likePost, repost, deletePost
├── connector-account-provider.ts   ConnectorAccountProvider adapter (BLUESKY_PROVIDER_ID)
├── workflow-credential-provider.ts BlueskyWorkflowCredentialProvider service
├── prompts.ts                      LLM prompt templates for DM and post generation
├── types/
│   └── index.ts                    All domain types: BlueSkyConfig, BlueSkyPost,
│                                   BlueSkyMessage, BlueSkyConversation, BlueSkyError,
│                                   event payload interfaces, Zod config schema
├── utils/
│   └── config.ts                   Config resolution: validateBlueSkyConfig,
│                                   hasBlueSkyEnabled, listBlueSkyAccountIds,
│                                   normalizeBlueSkyAccountId, readBlueSkyAccountId
├── services/
│   ├── bluesky.ts                  BlueSkyService (main Service class)
│   ├── message.ts                  BlueSkyMessageService — DM fetch/send/connector API
│   └── post.ts                     BlueSkyPostService — post publish/feed fetch/search
└── managers/
    └── agent.ts                    BlueSkyAgentManager — polling timers, notification
                                    dispatch, automated post scheduling
```

## Commands

```bash
bun run --cwd plugins/plugin-bluesky build        # compile (Bun.build + tsc for .d.ts)
bun run --cwd plugins/plugin-bluesky dev          # watch build (--hot)
bun run --cwd plugins/plugin-bluesky test         # vitest run
bun run --cwd plugins/plugin-bluesky typecheck    # tsgo --noEmit
bun run --cwd plugins/plugin-bluesky lint         # biome check --write --unsafe
bun run --cwd plugins/plugin-bluesky clean        # rm dist .turbo
```

## Config / env vars

| Var | Required | Default | Description |
|---|---|---|---|
| `BLUESKY_HANDLE` | yes | — | AT Protocol handle (e.g. `agent.bsky.social`) |
| `BLUESKY_PASSWORD` | yes | — | BlueSky app password |
| `BLUESKY_ENABLED` | no | inferred | Explicit enable/disable override |
| `BLUESKY_SERVICE` | no | `https://bsky.social` | PDS URL |
| `BLUESKY_DRY_RUN` | no | `false` | Log operations without executing |
| `BLUESKY_POLL_INTERVAL` | no | `60` | Notification poll interval (seconds) |
| `BLUESKY_ENABLE_POSTING` | no | `true` | Enable automated posting loop |
| `BLUESKY_POST_INTERVAL_MIN` | no | `1800` | Min seconds between auto-posts |
| `BLUESKY_POST_INTERVAL_MAX` | no | `3600` | Max seconds between auto-posts |
| `BLUESKY_POST_IMMEDIATELY` | no | `false` | Post on first startup tick |
| `BLUESKY_ENABLE_ACTION_PROCESSING` | no | `true` | Run mention/reply response cycle |
| `BLUESKY_ACTION_INTERVAL` | no | `120` | Action-processing interval (seconds) |
| `BLUESKY_MAX_ACTIONS_PROCESSING` | no | `5` | Max notifications per action batch |
| `BLUESKY_ENABLE_DMS` | no | `true` | Enable DM connector |
| `BLUESKY_MAX_POST_LENGTH` | no | `300` | Character cap for posts |
| `BLUESKY_ACCOUNTS` | no | — | JSON array/object for multi-handle config |
| `BLUESKY_DEFAULT_ACCOUNT_ID` | no | `"default"` | Which account handle to use as default |

Config is resolved in priority order: per-account env/character settings → top-level character settings → env vars. See `utils/config.ts:validateBlueSkyConfig`.

## How to extend

**Add a new action** (e.g. `LIKE_POST`):
1. Create `plugins/plugin-bluesky/actions/like-post.ts` — export an `Action` that calls `BlueSkyService` → `getPostServiceForAccount` → `client.likePost`.
2. Import and add it to `blueSkyPlugin.actions` in `index.ts`.

**Add a new service** (e.g. list-management):
1. Create `plugins/plugin-bluesky/services/list.ts` — extend nothing; accept `BlueSkyClient` and `IAgentRuntime` in constructor.
2. Instantiate in `BlueSkyService.start` alongside the existing message/post services.
3. Expose via a new getter on `BlueSkyService`.

**Listen to plugin events** in another plugin or character handler:
```ts
runtime.on("bluesky.mention_received", (payload: BlueSkyNotificationEventPayload) => {
  // payload.notification, payload.accountId, payload.runtime
});
```

## Conventions / gotchas

- **No actions registered.** The plugin is a connector/service plugin only. Social behaviors (reply generation, post creation) are driven by event handlers in the application layer responding to `bluesky.*` events, not by elizaOS actions.
- **Dry-run mode.** When `BLUESKY_DRY_RUN=true`, `BlueSkyClient` records intended writes without calling Bluesky (post, delete, like, repost, sendMessage). `sendPost`/`sendMessage` return synthetic dry-run objects; `deletePost`/`likePost`/`repost` log the intended operation and return. Useful for testing without hitting the API.
- **Multi-account.** Pass `BLUESKY_ACCOUNTS` as a JSON object keyed by account ID, or an array with `accountId` fields. Each account gets its own `BlueSkyClient`, `BlueSkyAgentManager`, and sub-services. The `"default"` account ID reads top-level env vars.
- **Post limit.** AT Protocol enforces 300 grapheme-character posts. `BlueSkyPostService` uses LLM-assisted truncation via `prompts.ts` if generated content exceeds the limit.
- **Auth.** BlueSky uses app passwords — not the main account password. Generate at `https://bsky.app/settings/app-passwords`.
- **Dual build.** Both browser and node builds are emitted. The browser build is functionally identical; `@atproto/api` supports both environments.
- **`@noble/hashes` pin.** The `resolutions` and `overrides` in `package.json` pin `@noble/hashes` to `2.2.0` to avoid version conflicts from `@atproto/*` deps.
- **Root AGENTS.md** covers logger-only rule, ESM, architecture commandments, and git workflow. This file covers only plugin-specific conventions.
