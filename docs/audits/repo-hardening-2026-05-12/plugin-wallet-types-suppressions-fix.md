# plugin-wallet type/registry suppressions fix

Date: 2026-05-12

## Scope

Started plugin-wallet `@ts-nocheck` removal on the pure type/registry slice:

- `plugins/plugin-wallet/src/analytics/dexscreener/types.ts`
- `plugins/plugin-wallet/src/analytics/birdeye/types/**/*.ts`
- `plugins/plugin-wallet/src/analytics/token-info/providers.ts`

No LP/DEX services were rewritten.

## Changes

- Removed file-level `@ts-nocheck` from the DexScreener API type declarations.
- Removed file-level `@ts-nocheck` from the Birdeye shared/API type declarations.
- Removed file-level `@ts-nocheck` from the TOKEN_INFO provider registry bridge.
- Added a narrow TOKEN_INFO callback adapter that converts `ActionResult.data` into core `ContentValue` shape for handler callbacks while preserving the original `ActionResult` domain payload.
- Replaced the CoinGecko trending `filter(Boolean)` with an explicit type guard.

## Suppressions

Removed:

- `plugins/plugin-wallet/src/analytics/dexscreener/types.ts`: file-level `@ts-nocheck`
- `plugins/plugin-wallet/src/analytics/birdeye/types/shared.ts`: file-level `@ts-nocheck`
- `plugins/plugin-wallet/src/analytics/birdeye/types/api/common.ts`: file-level `@ts-nocheck`
- `plugins/plugin-wallet/src/analytics/birdeye/types/api/defi.ts`: file-level `@ts-nocheck`
- `plugins/plugin-wallet/src/analytics/birdeye/types/api/pair.ts`: file-level `@ts-nocheck`
- `plugins/plugin-wallet/src/analytics/birdeye/types/api/search.ts`: file-level `@ts-nocheck`
- `plugins/plugin-wallet/src/analytics/birdeye/types/api/token.ts`: file-level `@ts-nocheck`
- `plugins/plugin-wallet/src/analytics/birdeye/types/api/trader.ts`: file-level `@ts-nocheck`
- `plugins/plugin-wallet/src/analytics/birdeye/types/api/wallet.ts`: file-level `@ts-nocheck`
- `plugins/plugin-wallet/src/analytics/token-info/providers.ts`: file-level `@ts-nocheck`

Kept:

- None in the owned slice.

Other plugin-wallet suppressions remain outside this task's requested type/registry ownership set.

## Verification

Commands run and status:

- Pass: `/Users/shawwalters/.bun/bin/bun run --cwd plugins/plugin-wallet check`
- Pass: `/Users/shawwalters/.bun/bin/bun run --cwd plugins/plugin-wallet test src/analytics/dexscreener/search-category.test.ts src/analytics/birdeye/search-category.test.ts src/analytics/birdeye/providers/portfolio-factory.test.ts` (`3` files, `8` tests)

The focused test command emits the existing package export-order warning for `package.json`; tests still pass.
