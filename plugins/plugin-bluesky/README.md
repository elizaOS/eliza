# @elizaos/plugin-bluesky

BlueSky (AT Protocol) client plugin for elizaOS. Adds BlueSky social capabilities to any Eliza agent: public-feed posting, direct messages, and notification polling.

## What it does

- **Public posts** — create, like, repost, delete posts; read and search the timeline.
- **Direct messages** — send and receive DMs via `chat.bsky` (AT Protocol chat API).
- **Notifications** — poll mentions, replies, follows, likes, reposts, and quotes; emit elizaOS events for each.
- **Automated posting** — optional randomized posting loop driven by configurable intervals.
- **Multi-account** — configure multiple BlueSky handles per agent.

## Installation

```bash
bun add @elizaos/plugin-bluesky
```

## Enabling the plugin

Add `blueSkyPlugin` to your agent's plugin list:

```ts
import { blueSkyPlugin } from "@elizaos/plugin-bluesky";

const agent = createAgent({
  plugins: [blueSkyPlugin],
});
```

The plugin is opt-in: if `BLUESKY_HANDLE` and `BLUESKY_PASSWORD` are not set (or `BLUESKY_ENABLED=false`), it starts but does nothing.

## Required configuration

| Variable | Description |
|---|---|
| `BLUESKY_HANDLE` | Your BlueSky handle, e.g. `agent.bsky.social` |
| `BLUESKY_PASSWORD` | App password — generate at https://bsky.app/settings/app-passwords |

## Optional configuration

| Variable | Default | Description |
|---|---|---|
| `BLUESKY_ENABLED` | inferred | Explicit `true`/`false` override |
| `BLUESKY_SERVICE` | `https://bsky.social` | PDS URL (for self-hosted instances) |
| `BLUESKY_DRY_RUN` | `false` | Log operations without sending to the API |
| `BLUESKY_POLL_INTERVAL` | `60` | Notification poll interval (seconds) |
| `BLUESKY_ENABLE_POSTING` | `true` | Enable automated posting loop |
| `BLUESKY_POST_INTERVAL_MIN` | `1800` | Minimum seconds between auto-posts |
| `BLUESKY_POST_INTERVAL_MAX` | `3600` | Maximum seconds between auto-posts |
| `BLUESKY_POST_IMMEDIATELY` | `false` | Post immediately on startup |
| `BLUESKY_ENABLE_ACTION_PROCESSING` | `true` | Process mention/reply response cycle |
| `BLUESKY_ACTION_INTERVAL` | `120` | Action-processing cycle interval (seconds) |
| `BLUESKY_MAX_ACTIONS_PROCESSING` | `5` | Max notifications handled per cycle |
| `BLUESKY_ENABLE_DMS` | `true` | Enable DM connector |
| `BLUESKY_MAX_POST_LENGTH` | `300` | Character cap (AT Protocol max is 300) |
| `BLUESKY_ACCOUNTS` | — | JSON for multi-handle configuration (see below) |
| `BLUESKY_DEFAULT_ACCOUNT_ID` | `"default"` | Which account to use as the default |

## Multi-account configuration

Pass `BLUESKY_ACCOUNTS` as a JSON array or object to configure multiple handles:

```json
[
  { "accountId": "main", "handle": "main.bsky.social", "password": "app-password-1" },
  { "accountId": "alt",  "handle": "alt.bsky.social",  "password": "app-password-2" }
]
```

Or set it in `character.settings.bluesky.accounts` with the same shape.

## Events

The plugin emits these elizaOS events that your handlers can subscribe to:

| Event | When |
|---|---|
| `bluesky.mention_received` | Agent is mentioned or replied to |
| `bluesky.follow_received` | Agent receives a new follower |
| `bluesky.like_received` | An agent post is liked |
| `bluesky.repost_received` | An agent post is reposted |
| `bluesky.quote_received` | An agent post is quoted |
| `bluesky.should_respond` | Mention/reply enters the action-processing cycle |
| `bluesky.create_post` | Automated posting timer fires |

## Using BlueSkyClient directly

```ts
import { BlueSkyClient } from "@elizaos/plugin-bluesky";

const client = new BlueSkyClient({
  service: "https://bsky.social",
  handle: "agent.bsky.social",
  password: "your-app-password",
  dryRun: false,
});

await client.authenticate();

// Post
const post = await client.sendPost({ content: { text: "Hello from elizaOS!" } });

// Reply
await client.sendPost({
  content: { text: "Replying!" },
  replyTo: { uri: post.uri, cid: post.cid },
});

// Like / repost / delete
await client.likePost(post.uri, post.cid);
await client.repost(post.uri, post.cid);
await client.deletePost(post.uri);

// Timeline and search
const timeline = await client.getTimeline({ limit: 50 });
const results = await client.searchPosts({ query: "elizaOS", limit: 25 });

// Notifications
const { notifications } = await client.getNotifications(50);
await client.updateSeenNotifications();

// DMs (requires chat.bsky access)
const { conversations } = await client.getConversations();
const { messages } = await client.getMessages(conversations[0].id);
await client.sendMessage({ convoId: conversations[0].id, message: { text: "Hello!" } });
```

## License

MIT
