# @elizaos/plugin-social-alpha

Tracks token recommendations (shills/FUD) in chat, builds trust scores per recommender based on P&L outcomes, and injects leaderboard intelligence into agent context.

## Purpose / role

This plugin listens to every incoming message, uses an LLM to extract crypto buy/sell recommendations, stores them against the sender's trust profile, and periodically evaluates whether following those calls would have been profitable. It exposes a provider that gives the agent real-time trust scores and leaderboard data so the agent can weigh advice from different users.

Loaded as `socialAlphaPlugin` (default export). Add it to an agent's `plugins` array — it is opt-in, not auto-enabled.

## Plugin surface

| Kind | Name | What it does |
|------|------|--------------|
| Service | `CommunityInvestorService` | Core engine: token data fetching, trust score calculation, position/recommendation storage, leaderboard assembly |
| Provider | `socialAlpha` | Injects sender's trust profile + leaderboard summary into agent context (dynamic; gated to `finance` / `crypto` / `social_posting` contexts via `contextGate`) |
| Event handler | `MESSAGE_RECEIVED` | Extracts buy/sell signals from incoming messages via a single combined LLM call; writes recommendations to the sender's component; enqueues `PROCESS_TRADE_DECISION` tasks |
| Routes | `GET /api/social-alpha/leaderboard` | Returns `LeaderboardEntry[]` as JSON via `CommunityInvestorService.getLeaderboardData` |
| View | `social-alpha` | Leaderboard view (`SocialAlphaView`, `dist/views/bundle.js`) — registered via `Plugin.views`, shown when the plugin is enabled; gates on a configured agent wallet |

No actions or evaluators are registered.

## Layout

```
src/
  index.ts                    Plugin definition, panel export, AgentPanel interface
  events.ts                   MESSAGE_RECEIVED handler — relevance + extraction in one LLM call
  routes.ts                   GET /leaderboard, /display, /assets/*
  service.ts                  CommunityInvestorService (extends Service)
  config.ts                   TradingConfig defaults, conviction/liquidity/volume multipliers,
                              TRUST_LEADERBOARD_WORLD_SEED constant
  types.ts                    All shared types: UUID, Recommendation, UserTrustProfile,
                              LeaderboardEntry, TokenPerformance, Position, Transaction, …
  clients.ts                  BirdeyeClient, DexscreenerClient, HeliusClient wrappers
  schemas.ts                  Zod schemas + DB-to-domain transforms for token/recommendation models
  reports.ts                  formatFullReport — human-readable trust report generator
  utils.ts                    Misc utilities
  mockPriceService.ts         Mock price service for testing
  simulationActors.ts         Simulation actor helpers (legacy)
  providers/
    socialAlphaProvider.ts    socialAlpha Provider implementation
  services/
    balancedTrustScoreCalculator.ts  Core scoring algorithm (profit, win rate, Sharpe, alpha, …)
    TrustScoreService.ts             Trust score service
    PriceDataService.ts              Historical price data fetching
    priceEnrichmentService.ts        Price enrichment for past recommendations
    historicalPriceService.ts        Historical price lookups
    SimulationService.ts             Consolidated simulation logic
    simulationRunner.ts              Runs simulations against past calls
    simulationActorsV2.ts            Simulation actor abstraction v2
    tokenSimulationService.ts        Per-token simulation
    trustScoreOptimizer.ts           ML-style parameter tuning for scoring weights
    index.ts                         Re-exports
  social-alpha-view-bundle.ts Vite view-bundle entry (exports SocialAlphaView)
  frontend/                   Leaderboard view (SocialAlphaView) built by
                              vite.config.views.ts into dist/views/bundle.js
                              with react + @elizaos/ui externalised to the
                              host shell. Uses canonical @elizaos/ui
                              primitives only — do not re-add local copies.
                              Tailwind classes are emitted by the host
                              (packages/ui/src/styles/styles.css @source's
                              this directory).
  index.test.ts               Vitest smoke tests
```

## Commands

Only scripts defined in this package's `package.json`:

```bash
bun run --cwd plugins/plugin-social-alpha build       # tsup + view bundle + types → dist/
bun run --cwd plugins/plugin-social-alpha test        # vitest run --passWithNoTests
bun run --cwd plugins/plugin-social-alpha clean       # rm -rf dist .turbo node_modules
```

`lint`, `format`, `typecheck` are release-skip scripts — the source is partially vendor-derived.

## Config / env vars

Read from `runtime.getSetting()` / `process.env`. All are declared in `package.json#agentConfig.pluginParameters`.

| Var | Required | Purpose |
|-----|----------|---------|
| `BIRDEYE_API_KEY` | Yes | Token price/security/trade data (Solana) |
| `DEXSCREENER_API_KEY` | Yes | DEX pair data, ticker resolution |
| `HELIUS_API_KEY` | Yes | Solana token holder lists (optional at runtime — service degrades gracefully) |
| `JUPITER_API_KEY` | Yes (declared) | Jupiter swap quotes (not actively used in current code paths) |
| `COINGECKO_API_KEY` | Yes (declared) | CoinGecko data (not actively used in current code paths) |
| `MORALIS_API_KEY` | Yes (declared) | Moralis data (not actively used in current code paths) |

Plugin-level config keys (set in agent character or environment):

| Key | Default | Purpose |
|-----|---------|---------|
| `PROCESS_TRADE_DECISION_INTERVAL_HOURS` | `"1"` | How often PROCESS_TRADE_DECISION tasks run |
| `METRIC_REFRESH_INTERVAL_HOURS` | `"24"` | How often recommender metrics are refreshed |
| `USER_TRADE_COOLDOWN_HOURS` | `"12"` | Minimum hours between trade decisions per user |
| `SCAM_PENALTY` | `"-100"` | Trust score penalty for promoting a rug/scam |
| `SCAM_CORRECT_CALL_BONUS` | `"100"` | Trust score bonus for correctly calling out a scam |
| `MAX_RECOMMENDATIONS_IN_PROFILE` | `"50"` | Rolling window of recommendations kept per user |

## How to extend

**Add a new route:** append a `Route` object to the `communityInvestorRoutes` array in `src/routes.ts`.

**Add a new provider:** create `src/providers/<name>.ts` exporting a `Provider`, then add it to the `providers` array in `src/index.ts`.

**Add a new event handler:** add an entry to the `events` object in `src/events.ts` (keyed by elizaOS event name).

**Extend trust scoring:** the balanced scoring algorithm lives in `src/services/balancedTrustScoreCalculator.ts` (`calculateBalancedTrustScore`). Weights and components are isolated there; `CommunityInvestorService` instantiates it as `this.balancedTrustCalculator` and invokes `calculateBalancedTrustScore`. (The simpler private `CommunityInvestorService.calculateTrustScore` uses its own inline history/performance weights and does not call the balanced calculator.) Do not add business logic to the provider or routes.

## Conventions / gotchas

- **No actions.** All recommendation capture happens via the `MESSAGE_RECEIVED` event handler, not actions. The agent does not need to invoke anything explicitly.
- **Component storage.** Each user's trust profile is stored as an elizaOS Component of type `TRUST_MARKETPLACE_COMPONENT_TYPE` in a seeded world (`TRUST_LEADERBOARD_WORLD_SEED = "trust-leaderboard-world-v1"`). The world ID is deterministic per agent via `createUniqueUuid`.
- **Single LLM call per message.** Relevance checking and recommendation extraction are merged into one `TEXT_LARGE` call (`RELEVANCE_AND_EXTRACTION_TEMPLATE` in `events.ts`). An empty `recommendations` array means "not relevant" — both cases are handled identically.
- **Deduplication window.** Identical token+type recommendations within 30 minutes are dropped (`RECENT_REC_DUPLICATION_TIMEFRAME_MS`).
- **Frontend.** The leaderboard UI is a plugin view (`SocialAlphaView`) served at `/api/views/social-alpha/bundle.js`. Run `bun run build` so `dist/views/bundle.js` exists before the view can load. The view shows a wallet-required empty state until the agent wallet is configured.
- **`typecheck` / `lint` / `format` are skipped** — the package.json scripts intentionally echo release-skip messages. Use the repo-root biome/typecheck commands if you need type checks.
- **`bignumber.js`** is used for precise arithmetic in price calculations (see `clients.ts`).
- See repo root `AGENTS.md` for architecture commandments, logger rules, and ESM conventions.
