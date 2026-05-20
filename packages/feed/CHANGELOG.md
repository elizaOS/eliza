# Changelog

All notable changes to the Feed project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

### Added

- **Documentation: Vercel Speed Insights (gated RUM)**
  - **Why (docs)**: Sampling and route gating are operational choices; without written rationale, the next engineer disables “unused” env vars or removes `beforeSend` and accidentally restores 100% RUM volume or loses regressions on core surfaces.
  - **Artifacts**: `docs/observability/speed-insights.md` (design, env semantics 0–100, default 50%, route allowlist, minimal-layout behavior, migration from legacy fractional env values, roadmap); `docs/observability/README.md` (index); `apps/web/README.md` (web app entry + link to observability docs); root `README.md` (Observability section + env table row).
  - **Code**: `apps/web/src/components/observability/GatedSpeedInsights.tsx` (file-level and inline **why** comments); wired from `apps/web/src/app/layout.tsx` and `apps/web/src/components/layout/FullAppShellClient.tsx`; `.env.example` cross-links to the doc.

### Changed

- **Markets trending screener — display formatting & org avatars**
  - **Why (OI / 24h vol column width)**: Compact formatters stopped at **billions** (`B`). When open interest or volume exceeded ~1e12, the UI still divided by 1e9 and printed a huge mantissa (e.g. `ƀ81309980567587.61B`), blowing table layout. **T** (trillion) and **Q** (quadrillion) tiers in `formatVolume`, `formatCompactCurrency`, `formatCompactNumber`, and the terminal’s local `formatCompactNumber` keep strings short and comparable across rows.
  - **Why (guards on Price / 24h % / Fund.)**: Raw `.toFixed()` on non-finite or extreme API values produced `NaN%`, `Infinity%`, or multi-hundred-character strings. `formatPrice`, `formatChange24h`, and `formatFundingApr` in `apps/web/src/app/markets/_lib/formatters.ts` use `Number.isFinite` and display clamps so bad data never widens columns; sorting still uses raw numbers in `sortPerpsForScreener`.
  - **Why (org image in Asset column)**: Initials-only tiles looked like missing logos; static org art already lives at `/images/organizations/{organizationId}.jpg`. `TrendingScreenerTable` uses `Avatar` with `type="business"` and `organizationId` so real logos show when files exist; `Avatar` falls back to initials when the image fails or the id is numeric-only (no static file convention).
  - **Why (`formatBalance` guard)**: Same class of bug as price — `toLocaleString` on `NaN` is user-visible garbage; non-finite balances now show `ƀ—`.
  - **Docs**: `docs/markets/trending-screener.md` — section **Display & formatting**; tests in `packages/testing/unit/markets/market-cards.test.ts` and `packages/testing/unit/shared/format.test.ts`.

### Added

- **Markets API caching and real-time updates (Terminal performance)**
  - **Why (latency)**: `GET /api/markets/perps` and `GET /api/markets/predictions` hit the database on every request. Under burst traffic (page load, multiple tabs, bot crawlers) this created unnecessary DB load and p95 latency spikes. Redis cache-aside with short TTLs (8s perps, 12s predictions, 30s positions) eliminates redundant reads while SSE + invalidation keep data fresh.
  - **Why (SSE on predictions)**: `PredictionMarketService` already broadcasts `prediction_trade`, `prediction_resolution`, and `prediction_cancellation` to the `markets` SSE channel, but the screener/dashboard didn't consume them — it relied entirely on periodic fetches. Now `useMarketsPageData` patches local prediction rows from SSE events so probability and share count updates appear instantly, matching how perps already work via `usePerpMarketsRealtime`.
  - **Why (invalidation topology)**: Cache invalidation fires from API route handlers (not from `packages/engine` or `packages/core`) because domain packages must not depend on `@feed/api`. Each mutation point — perp open/close/price-impact, prediction buy/sell, admin resolve/void/extend — calls a targeted invalidation helper. User-trade invalidation drops both the global list cache and the trading user's positions cache; admin mutations drop all position caches because every user's P&L changes on resolve.
  - **Why (pagination opt-in, not mandatory)**: The screener loads all markets in one shot (fits in one request, client-side sort). External integrations or future dashboards may want pages. Adding `?page=N&limit=M` activates pagination (returns `page`, `limit`, `total` in the response) without breaking existing callers who omit those params.
  - **Why (perp polling on trending)**: `usePerpMarketsPolling(30_000)` on `/markets` ensures the screener refreshes even when SSE events are sparse (quiet markets, SSE reconnection gap).
  - **Cache helpers** in `@feed/api`: `invalidateMarketsApiPerpsSnapshot`, `invalidateMarketsApiPredictionsList`, `invalidateMarketsApiPredictionsAfterUserTrade`, `invalidateMarketsApiPredictionsListAndAllPositions`, `invalidateMarketsApiPredictionsPositionsForUser`.
  - **Domain pagination** in `@feed/core`: `PerpMarketService.countMarkets()` / `.getMarketsSnapshot({ limit, offset })`, `PredictionMarketService.countUnresolvedMarkets()` / `.listMarkets({ limit, offset })`, with Drizzle adapter and in-memory test implementations.
  - **Docs**: `docs/markets/markets-api-caching.md` (design, cache topology, invalidation map, known caveats, roadmap).

- **Markets trending screener (`/markets`)**
  - **Why (product)**: Sending users straight into `MarketsTradingTerminal` put chart and order UI first; many users need a **scannable list** of what is moving before committing attention. A DEX-style screener matches that mental model without pretending Feed perps are on-chain tokens.
  - **Why (navigation)**: Shell **Terminal** now opens the screener; **Open terminal** and row **Trade** deep-link to `/markets` with `marketKind` / `marketId` / `filter` so selection matches `parseSelected()` in the unified terminal—one URL contract, no duplicate state machines.
  - **Why (data honesty)**: Reference screeners show mcap, pool liquidity, buy/sell txn splits, and listing “paid” flags. Those fields do not exist on our `PerpMarket` model; we map to **OI**, **24h volume**, **funding APR**, and **24h %**, with header tooltips explaining that **chart timeframe ≠ 24h % window**.
  - **Why (performance)**: Per-row price history is expensive. `PerpSparklineCell` uses **IntersectionObserver** before mounting `usePerpHistory`, and tables cap visible rows (100 perps / 100 predictions) to bound API fan-out.
  - **Why (search)**: A single debounced filter (`useMarketsPageData` `deferredSearchQuery`) applies to **both** perpetuals and predictions so behavior is predictable when switching tabs.
  - **Why (sort modes)**: **Top** (volume) and **A–Z** (`all`) are distinct—early versions both sorted by volume, which duplicated UX; A–Z gives a stable directory ordering for “find ticker X”.
  - **Docs**: `docs/markets/README.md` (index), `docs/markets-screener.md` (architecture, roadmap, mapping, persistence keys); `apps/web/src/app/markets/README.md` (dev entry).
  - **Tests**: `packages/testing/unit/markets/sort-perps-screener.test.ts`; Synpress `ROUTES.MARKETS_TRENDING` + screener visibility.
- **Terminal screener — persistence, predictions UX, resilience**
  - **Why (persistence)**: Users treat the screener as a workspace; resetting tab and sort on every visit feels broken. **localStorage** keys `screener:assetTab`, `screener:perpSort`, `screener:predSort` restore last choices with validated keys only (corrupt JSON falls back to defaults). **Why validated**: Prevents a bad deploy or manual edit from bricking the page via `JSON.parse`.
  - **Why (prediction sort client-only)**: After `/api/markets/predictions` loads once, reordering rows is pure `useMemo` in `PredictionsScreenerTable` — no extra public-read calls, so sorting never competes with the rate limiter.
  - **Why (429 retry)**: Tiered `publicRateLimit` caps anonymous bursts; without backoff, a single 429 left predictions empty or stuck loading. `useMarketsPageData` retries up to 3× with exponential backoff and honors `Retry-After` when present.
  - **Why (Strict Mode fetch)**: React 18 dev double-mount aborted the first predictions fetch; a ref gate that never reset skipped the second fetch, leaving `predictionsLoading === true` forever. Cleanup now resets `hasMountedRef` so the remount always schedules a fresh request.
  - **Why (copy)**: Page title **Terminal** matches the nav label; prediction row CTA **Predict** avoids implying a perp-style **Trade**; docs live under `docs/markets/` with `README.md` index and `trending-screener.md` roadmap.
- **Agent skills generation and docs integration**
  - **Why**: We expose A2A and MCP; agents (Cursor, Claude Code, ClawHub, etc.) need a single, up-to-date reference. Hand-maintained docs drift from code; generating from source keeps skills and endpoints in sync.
  - **Script** `scripts/generate-skills-md.ts`: Reads `packages/a2a` (feed-agent-card, executor operations) and `packages/mcp` (tool list); writes a full Agent Skills package to `skills/feed/` (SKILL.md with frontmatter, claw.json, README).
  - **npm scripts** `skills:generate` (skills markdown), `skills:package` (full package).
  - **docs:generate** now runs the skills generator after vendor doc pulls.
- **Outbound RSS feeds**
  - **Why**: Let users and tools subscribe to Feed content (hot posts, breaking news) in standard RSS readers without duplicating feed logic.
  - **GET /feed/rss**: RSS 2.0 feed of hot posts. Reuses `/api/feed/hot` internally so scoring, caching, and filtering stay in one place; this route only converts JSON → XML.
  - **GET /feed/breaking-news/rss**: RSS 2.0 feed of breaking news (world events, org updates, actor posts). Reuses `/api/feed/widgets/breaking-news` the same way.
  - Shared RSS builder in `apps/web/src/lib/rss.ts` (RSS 2.0 XML with escaping, RFC 1123 dates, 5‑min cache headers). **Why single helper**: Consistent escaping and cache semantics across endpoints.
  - Feed layout exposes both feeds via `<link rel="alternate" type="application/rss+xml" ...>` and Next.js `metadata.alternates` so readers and crawlers can discover them.
- **Inbound RSS config (default sources)**
  - **Why**: "Where do we put RSS feed URLs?" should have one answer; runtime enable/disable should stay in the DB so we can turn feeds off without a deploy.
  - Default list moved from `game-bootstrap-service.ts` to `packages/engine/src/config/rss-sources.ts` as `DEFAULT_RSS_SOURCES`. Bootstrap seeds `rssFeedSources` from it; engine continues to read only from DB. Add or edit default feed URLs in that config file.

- **Public API tiered rate limiting**
  - **Why**: Public GET endpoints (feeds, markets, profiles, etc.) were previously unrate-limited. That allowed unbounded anonymous traffic, increasing cost and abuse risk. We now apply tiered limits so anonymous callers are capped per IP while authenticated users and API keys get higher quotas.
  - New configs in `@feed/api` rate limiting:
    - **Read endpoints**: 20 req/min per IP (unauthenticated), 60 req/min per user (authenticated or API key), 10 req/min shared when IP cannot be determined.
    - **Firehose (SSE)**: 5 connections/min per IP (unauthenticated), 20/min per user, 2/min shared when IP unknown.
  - New helper `publicRateLimit(request, kind?)` in `@feed/api`: runs optional auth, then rate limits by `userId` (if authed) or by client IP (otherwise), or by shared anonymous bucket if IP is missing. Returns `{ error, user, rateLimitInfo }` so handlers can avoid double-auth and attach standard headers on success.
  - New helper `addPublicReadHeaders(response, rateLimitInfo)`: sets `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` and `Cache-Control: public, s-maxage=5, stale-while-revalidate=10` on successful public read responses. **Why**: Clients can respect limits before hitting 429; CDNs can cache and reduce origin load.
  - All public read-only GET routes (posts, markets, trending, reputation, registry, NFT, NPC, stats, SSE stats, onboarding check-username, questions dynamics, etc.) now call `publicRateLimit()` at the top and attach rate limit + cache headers on success. Auth-only routes (e.g. user search) still use `authenticate()` but apply `publicRateLimit()` first so unauthenticated attempts are rate limited by IP before returning 401.
  - **Null-user safety**: Endpoints that allow unauthenticated access were audited so that `user` is never dereferenced without a null check and query parameters (e.g. `userId`, `following`) are not trusted for authorization—only the authenticated identity from the token/API key is used for user-scoped data.
- **Public firehose token**
  - **GET /api/realtime/public-token**: Issues a short-lived token scoped only to public SSE channels (`feed`, `markets`, `breaking-news`, `upcoming-events`). No authentication required. **Why**: Enables read-only clients (dashboards, embeds) to subscribe to the public firehose without logging in, while keeping DMs and notifications behind the authenticated token endpoint. Rate limited with the firehose tier (5/min per IP) to prevent abuse of token issuance.

### Changed

- **GET /api/posts**: Enters the “following” feed branch only when the authenticated user matches the query `userId`; block/mute filters use `authUser?.userId` from auth, not from query params, so unauthenticated callers cannot leak or guess other users’ moderation state.
- **GET /api/registry** and **GET /api/registry/all**: Use `publicRateLimit()` instead of `optionalAuth()` alone; successful responses include rate limit and cache headers.
- **GET /api/onboarding/check-username**: Same pattern—`publicRateLimit()` supplies optional auth and rate limit info; headers attached on success.

### Developer notes

- When adding new public GET endpoints, call `publicRateLimit(request)` (or `publicRateLimit(request, 'firehose')` for SSE/token endpoints) at the start of the handler and use the returned `user` instead of calling `optionalAuth()` again. Always guard on `user` being null and call `addPublicReadHeaders(res, rateLimitInfo)` on successful responses when `rateLimitInfo` is present. See `packages/api/src/rate-limiting/README.md` for full usage and rationale.
