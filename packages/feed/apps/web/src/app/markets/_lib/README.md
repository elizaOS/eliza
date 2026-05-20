# Markets `_lib` — shared helpers for the markets routes

## `formatters.ts`

**Purpose:** Format Babylon points, volumes, and percentages for **dense tables** (trending screener, prediction volume column, etc.).

**WHY not only `@babylon/shared`:**

- Screener-specific rules: **ƀ** prefix, **T/Q** volume tiers (so OI and 24h vol never print 15-digit `…B` strings), and **em dash** for non-finite API values.
- Shared `formatCompactCurrency` / `formatCompactNumber` serve **engine and prompts** with slightly different defaults (e.g. decimal places). Keeping web table rules here avoids coupling every UI tweak to NPC context.

**Documentation:** [`docs/markets/trending-screener.md`](../../../../../../docs/markets/trending-screener.md) → **Display & formatting**.

**Tests:** [`packages/testing/unit/markets/market-cards.test.ts`](../../../../../../packages/testing/unit/markets/market-cards.test.ts).

## Other exports

- **`getDaysLeft`**, **`calculateSharePercentages`** — prediction UI helpers; documented inline in `formatters.ts`.
