# Markets trending screener (`/markets`)

Browse-first markets surface: perpetuals and predictions in a table layout, with a path into the full trading terminal. Shell navigation label **Terminal** routes here instead of opening the split-panel terminal immediately.

The page title is **Terminal** so it matches the nav item users tap to arrive here (shared vocabulary between chrome and page).

---

## Why this exists

| Problem | Approach |
|--------|----------|
| **Cognitive load** — Landing users on `MarketsTradingTerminal` forces chart + order UI before they know *what* is moving. | **Browse-first**: screener lists momentum and liquidity signals; **Trade** (perps) / **Predict** (predictions) opens `/markets` with the instrument pre-selected. |
| **DEX-style expectations** — Traders expect a scannable grid (sortable columns, sparklines, many columns). | **Visual parity where honest**: same *density* as external screeners; **no fake** on-chain fields (pool liq, buy/sell tx split, “paid” badges). |
| **Data truth** — Synthetic Feed perps are not ERC-20s; inventing mcap/tax would mislead. | Columns map to real `PerpMarket` / prediction fields; tooltips explain **OI**, **24h %** vs **chart range**, and **funding**. |
| **Performance** — Dozens of rows × full history would DDoS our own API. | **IntersectionObserver** before `usePerpHistory`; cap rows (100 perps / 100 predictions). |
| **Search consistency** — Split filters per tab would double-fetch or diverge. | **Single** search bar, **debounced** via `useMarketsPageData`’s `deferredSearchQuery`, applies to whichever tab is active. |
| **Sort without backend churn** — Re-sorting a table should not hit `/api/markets/predictions` or perp APIs again; data is already in memory. | **Client-side sort** for both tables after the initial load: perps via `sortPerpsForScreener`, predictions via column sort inside `PredictionsScreenerTable` (`useMemo` over the row list). |
| **Rate limits** — Public read tier returns **429** under burst traffic; a single failed fetch should not strand the UI in “loading” forever. | **429 retries** with backoff + `Retry-After` in `useMarketsPageData` `fetchData`; **Strict Mode** mount cleanup resets `hasMountedRef` so the second mount still fetches predictions (see code comments there). |
| **Remember UX choices** — Users expect the screener to feel like a tool, not reset every visit. | **localStorage** for last **asset tab**, **perp sort**, and **prediction sort** (validated keys only; corrupt values fall back to defaults). **Why not session-only:** return visits and refresh should preserve intent without requiring accounts. |

---

## User flows

1. **Terminal** (sidebar / bottom nav) → `/markets`.
2. **Perpetuals** — Click column headers to sort (trending composite, asset A–Z, price, 24h %, OI, volume, funding); filter string debounced; **Trade** on a row.
3. **Predictions** — Same filter bar; click **Market**, **YES %**, or **Volume** headers to sort (all client-side); **Predict** opens the terminal for that market.
4. **Deep link to terminal** — `/markets?marketKind=…&marketId=…&filter=…` (see below).

---

## Deep links into the terminal

Must stay aligned with `parseSelected()` in `MarketsTradingTerminal`:

| Asset | Query |
|-------|-------|
| Perp | `?marketKind=perp&marketId=<TICKER>&filter=perp` |
| Prediction | `?marketKind=prediction&marketId=<id>&filter=prediction` |

**Why `filter`:** Keeps the unified market list in the same “universe” (perp vs prediction) as the selection.

---

## localStorage keys (screener persistence)

| Key | Value | Default if missing/invalid |
|-----|--------|----------------------------|
| `screener:assetTab` | `perps` \| `predictions` | `perps` |
| `screener:perpSort` | JSON `{ key, dir }` per `ScreenerSortKey` | `{ key: 'trending', dir: 'desc' }` |
| `screener:predSort` | JSON `{ key, dir }` (`market` \| `yesPercent` \| `volume`) | `{ key: 'volume', dir: 'desc' }` |

**Why separate keys:** Perp and prediction sort dimensions differ; merging into one object would complicate validation and migrations.

---

## Code map

| Path | Role |
|------|------|
| `apps/web/src/app/markets/page.tsx` | Route shell: tabs, shared search, `localStorage` restore/write, row builders. |
| `apps/web/src/app/markets/_components/TrendingScreenerTable.tsx` | Perp table: sortable column headers, sparklines, tooltips. |
| `apps/web/src/app/markets/_components/PredictionsScreenerTable.tsx` | Prediction table: client-side column sort, empty/loading states, **Predict** CTA. |
| `apps/web/src/app/markets/_components/PerpSparklineCell.tsx` | Lazy sparkline from `usePerpHistory`. |
| `apps/web/src/app/markets/_lib/sortPerpsForScreener.ts` | Pure perp sort + cap; trending weights mirror dashboard logic. |
| `apps/web/src/app/markets/_hooks/useMarketsPageData.ts` | Perp store, debounced filter, **one** predictions fetch, 429 retry, Strict Mode–safe mount effect. |
| `packages/testing/unit/markets/sort-perps-screener.test.ts` | Unit tests for perp sort. |

---

## Data mapping (perps vs DEX reference UI)

Reference UIs show mcap, pool liquidity, txn splits, etc. We intentionally **do not** show those unless the backend exposes them.

- **OI** — Open interest (notional in app points).
- **24h vol** — `volume24h`.
- **24h %** — Snapshot field; **not** recomputed for the chart’s timeframe (tooltips clarify).
- **Chart** — Driven by `usePerpHistory` after the row enters the viewport.

---

## Navigation

- **Terminal** `href`: `/markets`.
- **Active** when path is trending, root `/markets`, or legacy `/markets/perps/*` / `/markets/predictions/*` so the item stays highlighted across the markets journey.

---

## Testing

- **Unit**: `sortPerpsForScreener` modes.
- **E2E**: Synpress `ROUTES.MARKETS_TRENDING`, `data-testid="markets-trending-screener"` / `markets-trending-predictions`.

---

## Roadmap (intended next steps)

Prioritized by impact and dependency on backend work.

1. ~~**Redis cache-aside for list APIs + SSE predictions patching**~~ — **Shipped.** See [`markets-api-caching.md`](./markets-api-caching.md).
2. ~~**`usePerpMarketsPolling` on trending**~~ — **Shipped.** 30 s polling ensures perps refresh even during SSE reconnect gaps.
3. ~~**Optional server-side pagination**~~ — **Shipped.** `?page=N&limit=M` on both endpoints for external consumers.
4. **Batch / server sparklines** — **Why**: N visible rows still means N history streams; a single batch endpoint reduces fan-out and stabilizes p95 under scroll.
5. **Intraday list stats** — **Why**: If product needs list columns to match short time windows, the API must expose windowed aggregates (avoid client-side lies).
6. **Virtualized rows** — **Why**: When market count grows past ~100, DOM + observers cost rises; virtualization keeps scroll smooth.
7. **Column visibility (“eye” tool)** — **Why**: Power users on small laptops can hide OI or funding; low priority vs correctness.
8. **Org avatars** — **Why**: Replace initials when a stable image URL exists on org/perp metadata (no fabricated token art).
9. **Prediction sort tests** — **Why**: Pure sort comparators for predictions could mirror `sort-perps-screener.test.ts` for regression safety.

Items we are **not** planning without domain support: DEX-style “paid listing”, tax %, buy/sell txn ratios, chain social links.

---

## Changelog (feature history)

See the root [`CHANGELOG.md`](../../CHANGELOG.md) **[Unreleased]** / dated sections for release notes. This file is the **design + rationale** source; the changelog is the **what shipped** log.

---

## Related

- Dev entry: `apps/web/src/app/markets/README.md`
- Full trading UI: `apps/web/src/app/markets/page.tsx` → `MarketsTradingTerminal`
- Public read rate limits: `packages/api/src/rate-limiting/README.md`
- Agent rules: [`CLAUDE.md`](../../CLAUDE.md) at repo root
