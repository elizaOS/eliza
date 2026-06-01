# @elizaos/plugin-x

X (formerly Twitter) connector for elizaOS agents: posting, mentions, replies, DMs, timeline actions, and autonomous content discovery.

## Purpose / role

Adds an `XService` to the elizaOS agent runtime that bridges the agent to X/Twitter via Twitter API v2. The plugin registers as a message connector (DMs) and post connector (public tweets), starts autonomous polling loops for mentions/interactions/timeline/discovery, and wires OAuth 1.0a env-var credentials or OAuth 2.0 PKCE into the connector account manager.

Auto-enabled when `config.connectors.x` (or legacy `config.connectors.twitter`) is present and not explicitly disabled. Entry-point check lives in `auto-enable.ts`.

## Plugin surface

**Services** (registered in `XPlugin.services`):

- `XService` (`serviceType = "x"`) — Core service. Starts `TwitterClientInstance` per account; registers the X message connector (DMs) and post connector (public feed) with the runtime; manages per-account client lifecycle.
- `XWorkflowCredentialProvider` (`serviceType = "workflow_credential_provider"`) — Supplies OAuth 1.0a credentials (`twitterApi` credential type) to the workflow plugin. Only supports `twitterApi`; does not support `twitterOAuth2Api`.

**No actions, providers, or evaluators** are registered.

**Connectors registered at runtime startup** (inside `XService.start`):

- Message connector `"x"` — DM channel; implements `resolveTargets`, `listRecentTargets`, `getUserContext`, `fetchMessages`, `sendHandler`.
- Post connector `"x"` — Public feed; implements `postHandler`, `fetchFeed`, `searchPosts`.

**Auto-enable module**: `auto-enable.ts` — `shouldEnable(ctx)` returns `true` when `ctx.config.connectors.x` or `.twitter` block is present and not `{enabled: false}`.

## Layout

```
plugins/plugin-x/
  auto-enable.ts                   Auto-enable entry-point (no heavy imports)
  src/
    index.ts                       XPlugin export; services: [XService, XWorkflowCredentialProvider]
    base.ts                        ClientBase — wraps the twitter-api-v2 client; caches profile, fetches timeline/tweets/search
    environment.ts                 twitterEnvSchema (zod); TwitterConfig type; validateTwitterConfig()
    types.ts                       TwitterClientState, ITwitterClient, event payload types, Tweet, MediaData
    constants.ts                   Shared string constants
    templates.ts                   LLM prompt templates for post/interaction generation
    post.ts                        TwitterPostClient — autonomous tweet generation loop
    interactions.ts                TwitterInteractionClient — mention/reply polling loop
    timeline.ts                    TwitterTimelineClient — home timeline action loop (like/retweet/quote)
    discovery.ts                   TwitterDiscoveryClient — autonomous follow/like/reply discovery loop
    connector-account-provider.ts  ConnectorAccountProvider impl; bridges env-mode + OAuth PKCE to ConnectorAccountManager
    connector-credential-refs.ts   Persists connector credential references into runtime cache
    workflow-credential-provider.ts XWorkflowCredentialProvider service
    client/
      index.ts                     Re-exports Client, SearchMode, QueryTweetsResponse, Tweet
      client.ts                    Low-level twitter-api-v2 wrapper (Client class)
      tweets.ts                    Tweet/Mention types; tweet fetch helpers
      accounts.ts                  resolveTwitterAccountConfig, resolveDefaultXAccountId, resolveRequestedXAccountId
      auth.ts                      TwitterAuth — authenticated twitter-api-v2 client wrapper
      profile.ts                   getProfile, parseProfile, profile caching
      search.ts                    searchTweets / searchProfiles / searchQuotedTweets generators
      relationships.ts             followUser, getFollowing, getFollowers helpers
      errors.ts                    Typed error classes
      api-types.ts                 Raw API response type shapes
      auth-providers/
        factory.ts                 createTwitterAuthProvider — picks env-mode vs PKCE
        pkce.ts                    createCodeVerifier / createCodeChallenge helpers
        env.ts                     Env-mode (OAuth 1.0a) auth provider
        oauth2-pkce.ts             OAuth 2.0 PKCE auth provider
        interactive.ts             Interactive authorization flow helpers
        token-store.ts             Token persistence helpers
        types.ts                   Auth provider type definitions
    services/
      x.service.ts                 XService + TwitterClientInstance (orchestrates all sub-clients)
      IPostService.ts              IPostService interface; Post / CreatePostOptions / GetPostsOptions types
      PostService.ts               TwitterPostService — createPost / getPosts / getMentions via ClientBase
      IMessageService.ts           IMessageService interface; Message / SendMessageOptions types
      MessageService.ts            TwitterMessageService — DM send/list via ClientBase
    utils.ts                       sendTweet, SentTweet, fetchMediaData, parseActionResponseFromText; re-exports utils/error-handler
    utils/
      settings.ts                  getSetting(runtime, key) — checks runtime settings then process.env
      memory.ts                    createMemorySafe, ensureTwitterContext, isTweetProcessed, buildTwitterMessageMetadata
      time.ts                      getEpochMs
      error-handler.ts             Shared API error handling helpers
```

## Commands

```bash
bun run --cwd plugins/plugin-x build           # tsup production build → dist/
bun run --cwd plugins/plugin-x dev             # tsup --watch
bun run --cwd plugins/plugin-x test            # vitest run
bun run --cwd plugins/plugin-x test:coverage   # vitest run --coverage
bun run --cwd plugins/plugin-x lint            # biome check --write --unsafe
bun run --cwd plugins/plugin-x lint:check      # biome check (read-only)
bun run --cwd plugins/plugin-x format          # biome format --write
bun run --cwd plugins/plugin-x format:check    # biome format (read-only)
bun run --cwd plugins/plugin-x clean           # rm -rf dist .turbo
```

## Config / env vars

All vars are read via `getSetting(runtime, key)` which checks `runtime.getSetting()` then `process.env`.

| Variable | Required | Default | Description |
|---|---|---|---|
| `TWITTER_AUTH_MODE` | No | `env` | `env` = OAuth 1.0a static credentials; `oauth` = OAuth 2.0 PKCE interactive |
| `TWITTER_API_KEY` | env-mode | — | Consumer API key |
| `TWITTER_API_SECRET_KEY` | env-mode | — | Consumer API secret |
| `TWITTER_ACCESS_TOKEN` | env-mode | — | Access token (must have write permissions) |
| `TWITTER_ACCESS_TOKEN_SECRET` | env-mode | — | Access token secret |
| `TWITTER_CLIENT_ID` | oauth-mode | — | OAuth 2.0 Client ID |
| `TWITTER_REDIRECT_URI` | oauth-mode | — | OAuth 2.0 redirect URI (loopback recommended) |
| `TWITTER_SCOPES` | No | `tweet.read tweet.write users.read offline.access` | OAuth 2.0 scopes |
| `TWITTER_DEFAULT_ACCOUNT_ID` | No | `default` | Default account ID for multi-account routing |
| `TWITTER_ACCOUNTS` | No | — | JSON blob of account-scoped credentials for multi-account pilots |
| `TWITTER_DRY_RUN` | No | `false` | Simulate all actions; nothing is actually posted |
| `TWITTER_ENABLE_POST` | No | `false` | Enable autonomous tweet generation loop |
| `TWITTER_ENABLE_REPLIES` | No | `true` | Enable mention/reply handling loop |
| `TWITTER_ENABLE_ACTIONS` | No | `false` | Enable timeline action loop (like/retweet/quote) |
| `TWITTER_ENABLE_DISCOVERY` | No | `false` | Enable discovery loop (follows + engagement) |
| `TWITTER_TARGET_USERS` | No | `""` | Comma-separated usernames to target; empty = all; `*` = all |
| `TWITTER_RETRY_LIMIT` | No | `5` | Max retries on failed operations |
| `TWITTER_POST_INTERVAL` | No | `120` | Fixed minutes between posts when MIN/MAX not set |
| `TWITTER_POST_INTERVAL_MIN` | No | `90` | Minimum minutes between posts |
| `TWITTER_POST_INTERVAL_MAX` | No | `180` | Maximum minutes between posts |
| `TWITTER_POST_IMMEDIATELY` | No | `false` | Skip first interval and post on startup |
| `TWITTER_ENGAGEMENT_INTERVAL` | No | `30` | Fixed minutes between engagements |
| `TWITTER_ENGAGEMENT_INTERVAL_MIN` | No | `20` | Minimum minutes between engagements |
| `TWITTER_ENGAGEMENT_INTERVAL_MAX` | No | `40` | Maximum minutes between engagements |
| `TWITTER_DISCOVERY_INTERVAL_MIN` | No | `15` | Minimum minutes between discovery cycles |
| `TWITTER_DISCOVERY_INTERVAL_MAX` | No | `30` | Maximum minutes between discovery cycles |
| `TWITTER_MAX_ENGAGEMENTS_PER_RUN` | No | `5` | Max interactions per engagement cycle |
| `TWITTER_MAX_TWEET_LENGTH` | No | `280` | Max tweet length |
| `TWITTER_MIN_FOLLOWER_COUNT` | No | `100` | Min follower count for discovery follows |
| `TWITTER_MAX_FOLLOWS_PER_CYCLE` | No | `5` | Max follows per discovery cycle |
| `TWITTER_AUTO_RESPOND_MENTIONS` | No | `true` | Auto-respond to mentions |
| `TWITTER_AUTO_RESPOND_REPLIES` | No | `true` | Auto-respond to replies |
| `TWITTER_TIMELINE_MODE` | No | `home` | Timeline mode |

## How to extend

**Add a new autonomous loop** (e.g., a scheduled quote-tweet cycle):

1. Create `src/my-feature.ts` exporting a class with `start()` and `stop()` methods. Follow `post.ts` or `discovery.ts` as a pattern — construct with `(client: ClientBase, runtime: IAgentRuntime, state: TwitterClientState)`.
2. Add a field to `TwitterClientInstance` in `src/services/x.service.ts` and instantiate it in the constructor when the relevant env var is set.
3. Call `await instance.myFeature.start()` inside `startAutonomousClients()` and `await client.myFeature.stop()` inside `XService.stop()`.

**Add a new IPostService or IMessageService method**:

1. Extend the interface in `src/services/IPostService.ts` or `src/services/IMessageService.ts`.
2. Implement in `src/services/PostService.ts` / `src/services/MessageService.ts`.
3. Call the new method from `XService` handler methods as needed.

**Add a new connector capability** (e.g., `search_posts` on the message connector):

1. Add the capability string to `X_CONNECTOR_CAPABILITIES` in `x.service.ts`.
2. Implement the handler method on `XService`.
3. Include it in the `XMessageConnectorRegistration` passed to `runtime.registerMessageConnector`.

## Conventions / gotchas

- **OAuth 1.0a (`env` mode)** is the default. It requires all four vars: `TWITTER_API_KEY`, `TWITTER_API_SECRET_KEY`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_TOKEN_SECRET`. The app must have "Read and write" permissions in the Twitter Developer Portal. After changing permissions, regenerate access tokens.
- **OAuth 2.0 PKCE (`oauth` mode)** requires `TWITTER_CLIENT_ID` and `TWITTER_REDIRECT_URI`. No client secret is stored. Tokens persist per `accountId` via the runtime cache (key `twitter/oauth2/tokens/<agentId>/<accountId>`) and the connector credential store — see `client/auth-providers/token-store.ts`. There is no local-file fallback; token persistence requires runtime cache APIs.
- **`TWITTER_ENABLE_POST=false` by default.** Posting is opt-in to prevent accidental bots.
- **`TWITTER_ENABLE_ACTIONS=false` by default.** Timeline actions (likes, retweets) are also opt-in.
- **Discovery auto-enables with actions.** `TWITTER_ENABLE_DISCOVERY` defaults to `true` when `TWITTER_ENABLE_ACTIONS=true`, unless explicitly set to `false`.
- **`TWITTER_DRY_RUN=true`** simulates all write operations without calling the API. Use during development.
- **`getSetting(runtime, key)`** in `src/utils/settings.ts` is the canonical way to read any config — it checks runtime settings before `process.env`. Never read `process.env.TWITTER_*` directly inside service code.
- **Multi-account**: use `TWITTER_ACCOUNTS` (JSON) or add accounts via the ConnectorAccountManager HTTP surface. All methods on `XService` accept an `accountId` parameter. The default account is `TWITTER_DEFAULT_ACCOUNT_ID` (default: `"default"`).
- **`XWorkflowCredentialProvider`** only resolves `twitterApi` (OAuth 1.0a). Attempting to use `twitterOAuth2Api` with env-mode credentials will silently fail at workflow execution time.
- **twitter-api-v2** is the sole external Twitter API dep. Check its types and docs when adding new API calls.
- **No actions or providers** are registered by this plugin; all agent-facing behavior goes through message/post connector handlers.
