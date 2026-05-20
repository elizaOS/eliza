# Markets API caching & real-time updates

Redis cache-aside layer for `GET /api/markets/perps` and `GET /api/markets/predictions`, with SSE-driven client-side patching and write-time invalidation.

---

## Why this exists

| Problem | Approach |
|---------|----------|
| **DB hit on every request** — Both endpoints run unindexed-ish full-table reads on every call. Under burst traffic (page load, multi-tab, bots) this wastes DB capacity and inflates p95. | **Redis cache-aside** (`getCacheOrFetch`) with short TTLs. Thundering-herd protection via probabilistic early expiration prevents stampedes at TTL boundary. |
| **Stale reads after trades** — A short TTL alone means up to N seconds of stale data after a write. | **Write-time invalidation**: every mutation (open, close, buy, sell, resolve, cancel, price-impact) fires a targeted `invalidate*` call, so the next read sees fresh data immediately. |
| **Prediction screener has no real-time updates** — `PredictionMarketService` already broadcasts `prediction_trade`, `prediction_resolution`, `prediction_cancellation` on the `markets` SSE channel, but the screener ignored them. | **SSE patching** in `useMarketsPageData`: the hook subscribes to the `markets` channel and patches local prediction rows in-place (shares, probabilities, status). This matches how perps already work via `usePerpMarketsRealtime` / `usePerpPriceSubscription`. |
| **No pagination for external consumers** — The screener loads all markets at once (client-side sort), but future dashboards or third-party integrations need bounded pages. | **Opt-in pagination**: `?page=N&limit=M` activates server-side pagination and adds `page`, `limit`, `total` to the response. Omitting those params keeps the old behavior (full list, cached). |

---

## Cache topology

### Keys and TTLs

| Namespace (`CACHE_KEYS.*`) | Key | TTL | What it caches |
|----------------------------|-----|-----|----------------|
| `MARKETS_API_PERPS` | `snapshot` | 8 s | Full `PerpMarketRecord[]` from `getMarketsSnapshot()` |
| `MARKETS_API_PREDICTIONS_LIST` | `all` | 12 s | Full `PredictionMarketRecord[]` from `listMarkets()` |
| `MARKETS_API_PREDICTIONS_POSITIONS` | `{userId}` | 30 s | `Record<marketId, UserPositionSnapshot[]>` for one user |

**Why these TTLs:**

- **Perps 8 s**: Price-impact and SSE broadcasts push real-time updates to the client; the cache only serves the "cold" path (first load, SSE reconnect). 8 s is short enough that a missed invalidation doesn't matter.
- **Predictions list 12 s**: Prediction markets change less frequently than perp prices (trades are sparser). 12 s reduces DB load without visible staleness.
- **Positions 30 s**: Position snapshots are per-user and computed against market state. Longer TTL is acceptable because the trading user's cache is always invalidated on their own trade, and other users' positions only drift by the amount the market moved — bounded by the list TTL.

**When pagination is requested** (`?page=N&limit=M`), the cache is bypassed entirely. Paginated requests always hit the DB. WHY: caching every (page, limit) combination creates key explosion with low hit rates; the screener (the hot path) doesn't paginate.

### Invalidation map

| Mutation | Fires | WHY |
|----------|-------|-----|
| **Perp open** (`POST /api/markets/perps/open`) | `invalidateMarketsApiPerpsSnapshot` | OI changes; cached snapshot becomes stale. |
| **Perp close** (`POST /api/markets/perps/position/[id]/close`) | `invalidateMarketsApiPerpsSnapshot` | OI changes. |
| **Perp price impact** (`applyUserTradePriceImpact` in `_adapters.ts`) | `invalidateMarketsApiPerpsSnapshot` | Price changes are applied directly to the DB; the cached snapshot has the old price. Note: this fires in addition to the route-level invalidation — double-invalidation is idempotent but redundant. |
| **Prediction buy** (`POST /api/markets/predictions/[id]/buy`) | `invalidateMarketsApiPredictionsAfterUserTrade(userId)` | Market shares change (global list stale); this user's positions change. |
| **Prediction sell** (`POST /api/markets/predictions/[id]/sell`) | `invalidateMarketsApiPredictionsAfterUserTrade(userId)` | Same as buy. |
| **Admin resolve** (`POST /api/admin/markets/[marketId]` action=resolve) | `invalidateMarketsApiPredictionsListAndAllPositions` | Resolved market drops from list; every user's P&L changes (winning/losing). |
| **Admin void/cancel** (action=void) | `invalidateMarketsApiPredictionsListAndAllPositions` | Cancelled market drops from list; all positions refunded. |
| **Admin extend** (action=extend) | `invalidateMarketsApiPredictionsList` | endDate changed; positions unaffected. |

**WHY invalidation lives in `apps/web` route handlers, not in `packages/core`:**
Domain packages (`packages/core`, `packages/engine`) must stay framework-agnostic and must not depend on `@feed/api`. Cache is infrastructure; invalidation is wiring. The route handler is the boundary where domain results meet infra side-effects.

---

## SSE client-side patching

`useMarketsPageData` subscribes to `useSSEChannel('markets', callback)` and handles three event types:

| SSE event | Client action | WHY |
|-----------|---------------|-----|
| `prediction_trade` | Patch `yesShares`, `noShares`, `yesProbability`, `noProbability` on the matching row. If `trade.actorId` matches the current user, throttle-refresh user positions (2 s debounce). | Instant probability updates without waiting for the next fetch. Position refresh is throttled because rapid consecutive trades would spam the positions API. |
| `prediction_resolution` | Set `status: 'resolved'`, `resolvedOutcome`, probabilities to 0/1, copy `resolutionProofUrl` / `resolutionDescription`. | Resolved markets should immediately show as resolved in the screener — no stale "active" badge. |
| `prediction_cancellation` | Set `status: 'cancelled'`. | Same reasoning — instant status update. |

**WHY `useCallback(…, [])`:** The callback closes over `setPredictions` (stable identity from `useState`), `userIdRef`, `refreshPositionsRef`, and `lastPredictionPositionsRefreshAtRef` (all refs, read at call time). No reactive dependencies needed. `useSSEChannel` also keeps a ref to the latest callback internally, so even a stale closure would be harmless.

**Known race:** If an SSE event arrives during an in-flight `fetchData` call, the fetch completion will overwrite the SSE patch. The window is small and the next SSE event will re-apply. Not worth adding sequence numbers for this.

---

## Pagination

Both endpoints support optional server-side pagination via `?page=N&limit=M`:

```
GET /api/markets/perps?page=2&limit=10
→ { success, markets, count, page: 2, limit: 10, total: 42 }

GET /api/markets/predictions?page=1&limit=5
→ { success, questions, count, page: 1, limit: 5, total: 18 }
```

**Without** those params, the response is the same as before (full list, no `page`/`limit`/`total` fields). Backward compatibility is preserved.

**WHY opt-in, not default:** The screener loads all markets and sorts client-side. Forcing pagination would break existing callers and add complexity (cursor management, sort parity) without benefit — there are ~20–50 markets today. The pagination path exists for future dashboards, third-party integrations, or mobile list views that need bounded payloads.

**Perps:** `countMarkets()` counts all rows in `perpMarketSnapshots` (matches what unpaginated `listMarkets()` returns). Sorted by `ticker ASC` for stable page boundaries.

**Predictions:** `countUnresolvedMarkets()` counts `WHERE resolved = false` (matches what `listMarkets()` returns — also filters `resolved = false`). Sorted by `createdAt DESC` so newest markets appear first.

---

## Known caveats

1. **Positions TTL (30 s) > list TTL (12 s):** A cached position snapshot was computed against market share counts that may be 12–30 s old. The trading user's cache is always invalidated, but other users see stale `currentValue` / `unrealizedPnL` until their position cache expires. Acceptable for now; could reduce positions TTL or always recompute positions against fresh market data.

2. **In-memory cache pattern invalidation is broken:** `invalidateCachePattern` uses `key.includes(pattern)` for the in-memory fallback, but `pattern` is `'*'` (literal), which never matches real keys. When Redis is unavailable, invalidation is silently no-op and data is stale until TTL expires. This is a pre-existing bug in `cache-service.ts`, not introduced here.

3. **Double invalidation on perp trades with price impact:** Both the route handler and `applyUserTradePriceImpact` call `invalidateMarketsApiPerpsSnapshot`. This is idempotent but redundant (two Redis SCAN operations per trade).

4. **Paginated count is not cached:** `countMarkets()` / `countUnresolvedMarkets()` hit the DB on every paginated request. At current scale (~50 markets) this is negligible.

---

## Code map

| Path | Role |
|------|------|
| `packages/api/src/cache/cache-service.ts` | `CACHE_KEYS.*`, `DEFAULT_TTLS.*`, `getCacheOrFetch` |
| `packages/api/src/cache/markets-api-cache.ts` | Invalidation helpers (5 functions) |
| `packages/api/src/cache/index.ts` | Re-exports |
| `packages/api/src/index.ts` | Public API exports |
| `apps/web/src/app/api/markets/perps/route.ts` | GET with cache-aside + opt-in pagination |
| `apps/web/src/app/api/markets/predictions/route.ts` | GET with cache-aside + per-user positions cache + opt-in pagination |
| `apps/web/src/app/api/markets/perps/open/route.ts` | Invalidation after open |
| `apps/web/src/app/api/markets/perps/position/[id]/close/route.ts` | Invalidation after close |
| `apps/web/src/app/api/markets/perps/_adapters.ts` | Invalidation after price impact |
| `apps/web/src/app/api/markets/predictions/[id]/buy/route.ts` | Invalidation after buy |
| `apps/web/src/app/api/markets/predictions/[id]/sell/route.ts` | Invalidation after sell |
| `apps/web/src/app/api/admin/markets/[marketId]/route.ts` | Invalidation after resolve/void/extend |
| `apps/web/src/app/markets/_hooks/useMarketsPageData.ts` | SSE subscription for prediction events |
| `apps/web/src/app/markets/page.tsx` | `usePerpMarketsPolling(30_000)` |
| `packages/core/markets/perps/types.ts` | `PerpDbPort.countMarkets`, `listMarkets` options |
| `packages/core/markets/perps/PerpMarketService.ts` | `countMarkets()`, `getMarketsSnapshot(options?)` |
| `packages/core/markets/perps/adapters/drizzle/PerpDbAdapter.ts` | Drizzle `count()` + paginated `listMarkets` |
| `packages/core/markets/prediction/types.ts` | `PredictionDbPort.countUnresolvedMarkets?`, `listMarkets?` options |
| `packages/core/markets/prediction/PredictionMarketService.ts` | `countUnresolvedMarkets()`, `listMarkets(options?)` |
| `packages/core/markets/prediction/adapters/drizzle/PredictionDbAdapter.ts` | Drizzle `count()` + paginated `listMarkets` |

---

## Roadmap

Prioritized by impact on data freshness and DB load.

1. **Reduce positions cache TTL or recompute on the fly** — WHY: eliminates the stale-position-against-fresh-market window (caveat 1 above).
2. **Fix in-memory `invalidateCachePattern` glob matching** — WHY: makes the cache layer work correctly when Redis is unavailable (caveat 2 above). Replace `key.includes(pattern)` with a proper glob or prefix match.
3. **Cache paginated count** — WHY: when pagination traffic grows, `countMarkets()` / `countUnresolvedMarkets()` will become a hot query. A 5–10 s cached count eliminates it.
4. **Deduplicate perp invalidation** — WHY: removes the double-SCAN per trade (caveat 3). Either remove the route-level call (price-impact already covers it) or skip invalidation inside `applyUserTradePriceImpact`.
5. **Add pagination unit tests** — WHY: `getMarketsSnapshot({ limit, offset })` and `countMarkets()` have no coverage; the in-memory mocks are implemented but never exercised.

---

## Related

- [Trending screener docs](./trending-screener.md) — browse-first UI, sort modes, persistence
- [Markets docs index](./README.md)
- [Cache service](../../packages/api/src/cache/cache-service.ts) — `getCacheOrFetch`, thundering herd protection
- [CHANGELOG](../../CHANGELOG.md) — shipped features with WHY bullets
- [CLAUDE.md](../../CLAUDE.md) — agent and developer rules
