# @elizaos/plugin-x

X (formerly Twitter) connector for elizaOS agents, built on the official Twitter API v2 (`twitter-api-v2`).

It adds an `XService` to the agent runtime that registers an X message connector (DMs) and post connector (public tweets), and runs optional autonomous loops for posting, mention/reply handling, timeline actions, and content discovery. The plugin registers **no actions, providers, or evaluators** — all agent-facing behavior flows through the connector handlers.

The plugin auto-enables when a `connectors.x` (or legacy `connectors.twitter`) block is present in agent config and is not explicitly disabled.

## Authentication

Two auth modes, selected by `TWITTER_AUTH_MODE`:

- **`env` (default) — OAuth 1.0a static credentials.** Requires `TWITTER_API_KEY`, `TWITTER_API_SECRET_KEY`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_TOKEN_SECRET`. The Twitter app must have **Read and write** permissions; after enabling write, regenerate the access token + secret.
- **`oauth` — OAuth 2.0 PKCE (login + approve).** Requires `TWITTER_CLIENT_ID` and `TWITTER_REDIRECT_URI` (loopback recommended). No client secret is used or stored. On first run the plugin prints an authorization URL and captures the callback; tokens persist per `accountId` via the runtime cache and connector credential store (no local token file).

### Getting credentials

1. Create an app in the [Twitter Developer Portal](https://developer.twitter.com/en/portal/projects-and-apps) with API v2 access.
2. Under **User authentication settings**, set **App permissions: Read and write**.
3. For `env` mode, copy API Key/Secret (Consumer Keys) and Access Token/Secret (Authentication Tokens). For `oauth` mode, copy the OAuth 2.0 Client ID.

## Configuration

Set via the agent's settings or environment. All values are read with `getSetting(runtime, key)`, which checks runtime settings before `process.env`. Intervals are in minutes unless noted.

```bash
# Auth (env mode shown)
TWITTER_AUTH_MODE=env
TWITTER_API_KEY=...
TWITTER_API_SECRET_KEY=...
TWITTER_ACCESS_TOKEN=...          # must have write permission
TWITTER_ACCESS_TOKEN_SECRET=...

# OAuth 2.0 PKCE alternative
# TWITTER_AUTH_MODE=oauth
# TWITTER_CLIENT_ID=...
# TWITTER_REDIRECT_URI=http://127.0.0.1:8080/callback
# TWITTER_SCOPES="tweet.read tweet.write users.read offline.access"

# Feature toggles (all opt-in except replies)
TWITTER_ENABLE_POST=false         # autonomous posting loop
TWITTER_ENABLE_REPLIES=true       # mention/reply handling
TWITTER_ENABLE_ACTIONS=false      # timeline likes/retweets/quotes
TWITTER_ENABLE_DISCOVERY=         # defaults to true when ACTIONS=true, unless set false

# Behavior
TWITTER_DRY_RUN=false             # simulate writes, post nothing
TWITTER_POST_IMMEDIATELY=false    # post once on startup
TWITTER_TARGET_USERS=             # comma-separated usernames; empty or "*" = all
TWITTER_MAX_TWEET_LENGTH=280
TWITTER_RETRY_LIMIT=5

# Timing (minutes; MIN/MAX add randomness, else the fixed value is used)
TWITTER_POST_INTERVAL=120
TWITTER_POST_INTERVAL_MIN=90
TWITTER_POST_INTERVAL_MAX=180
TWITTER_ENGAGEMENT_INTERVAL=30
TWITTER_ENGAGEMENT_INTERVAL_MIN=20
TWITTER_ENGAGEMENT_INTERVAL_MAX=40
TWITTER_DISCOVERY_INTERVAL_MIN=15
TWITTER_DISCOVERY_INTERVAL_MAX=30

# Discovery limits
TWITTER_MAX_ENGAGEMENTS_PER_RUN=5
TWITTER_MIN_FOLLOWER_COUNT=100
TWITTER_MAX_FOLLOWS_PER_CYCLE=5
```

Multi-account routing: provide account-scoped credentials in `TWITTER_ACCOUNTS` (JSON) or register accounts via the runtime's ConnectorAccountManager. `TWITTER_DEFAULT_ACCOUNT_ID` selects the default account (effective default: `"default"`).

For the full validated schema and defaults see `src/environment.ts` (`twitterEnvSchema`, `validateTwitterConfig`). For an exhaustive variable table and architecture notes see [CLAUDE.md](./CLAUDE.md).

## Discovery service

When enabled, the discovery service searches for content matching the agent's `topics` (falling back to its `bio`), scores accounts and tweets, and engages. Relevance thresholds (in `src/discovery.ts`): like ≥ 0.5, reply ≥ 0.7, quote ≥ 0.85. Engaged tweets and followed accounts are tracked to avoid duplicates.

## src layout

```
src/
  index.ts                 XPlugin (services: XService, XWorkflowCredentialProvider)
  base.ts                  ClientBase — twitter-api-v2 wrapper, profile/timeline/search
  environment.ts           twitterEnvSchema, validateTwitterConfig
  types.ts                 TwitterClientState, ITwitterClient, Tweet, MediaData, event payloads
  post.ts                  TwitterPostClient — posting loop
  interactions.ts          TwitterInteractionClient — mention/reply loop
  timeline.ts              TwitterTimelineClient — timeline action loop
  discovery.ts             TwitterDiscoveryClient — discovery loop
  connector-account-provider.ts, connector-credential-refs.ts, workflow-credential-provider.ts
  client/                  Low-level API: client.ts, tweets.ts, profile.ts, search.ts,
                           relationships.ts, accounts.ts, auth.ts, errors.ts, auth-providers/
  services/                XService (x.service.ts), Post/Message services + interfaces
  utils/                   settings.ts, memory.ts, time.ts, error-handler.ts
```

## Commands

```bash
bun run --cwd plugins/plugin-x build           # tsup → dist/
bun run --cwd plugins/plugin-x dev             # tsup --watch
bun run --cwd plugins/plugin-x test            # vitest run
bun run --cwd plugins/plugin-x test:coverage   # vitest run --coverage
bun run --cwd plugins/plugin-x lint            # biome check --write --unsafe
bun run --cwd plugins/plugin-x format          # biome format --write
```

## Troubleshooting

- **403 on post or engagement** — app is read-only, or you're engaging a protected/own tweet. Set **Read and write** permissions, regenerate the access token + secret, and restart.
- **"Could not authenticate you"** — credentials don't match the selected `TWITTER_AUTH_MODE`. In `env` mode use Consumer Keys + Authentication Tokens; in `oauth` mode use the OAuth 2.0 Client ID and a loopback redirect URI (no client secret).
- **Bot not posting** — confirm `TWITTER_ENABLE_POST=true`, the character has `bio`/`topics`/`messageExamples` for generation, and try `TWITTER_POST_IMMEDIATELY=true`.

## Resources

- [Twitter API v2 docs](https://developer.twitter.com/en/docs/twitter-api)
- [OAuth 2.0 Authorization Code with PKCE](https://developer.twitter.com/en/docs/authentication/oauth-2-0/authorization-code)
- [Twitter automation rules](https://help.twitter.com/en/rules-and-policies/twitter-automation)
