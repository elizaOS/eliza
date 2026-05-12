# Plugin Wallet News/Lpinfo Suppressions Fix

Date: 2026-05-12

## Scope

Owned slice:

- `plugins/plugin-wallet/src/analytics/news/**`
- `plugins/plugin-wallet/src/analytics/lpinfo/**`

Excluded by instruction:

- Birdeye/DexScreener analytics
- `plugins/plugin-wallet/src/chains/**`
- `plugins/plugin-wallet/src/lp/**`

## Changes Made

Completed the interrupted suppression-removal follow-up by fixing the real
TypeScript errors in the owned news/lpinfo files without adding `@ts-nocheck`,
`@ts-ignore`, `@ts-expect-error`, or broad `any`.

Key fixes:

- Normalized Kamino and Steer provider return values to core
  `ProviderResult`/`ProviderValue` compatible objects.
- Made Kamino and Steer service constructors compatible with the core
  `ServiceClass` contract while preserving typed runtime use in `start`.
- Exported and reused Kamino service DTOs instead of stale duplicated provider
  shapes.
- Added a narrow Kamino account extraction helper for DM-only lending reports.
- Added Steer SDK response guards for paginated vault/pool edges and GraphQL
  vault responses before reading nested external fields.
- Isolated Steer SDK/viem version-skew at constructor boundaries with concrete
  `ConstructorParameters` casts through `unknown`.
- Added EVM address guards before passing Steer single-asset deposit contract
  and pool addresses to SDK calls.
- Fixed the CoinGecko market-cap-rank read to use the coin-level field.
- Converted logger calls that passed arbitrary objects/errors as message
  arguments into string/object-compatible calls for the resolved logger type.

## Suppressions

Verification:

```sh
rg -n "@ts-nocheck|@ts-ignore|@ts-expect-error" plugins/plugin-wallet/src/analytics/news plugins/plugin-wallet/src/analytics/lpinfo
```

Result: no matches.

Broad-`any` type scan:

```sh
rg -n "(:| as |<)any\b|\bany\[\]" plugins/plugin-wallet/src/analytics/news plugins/plugin-wallet/src/analytics/lpinfo
```

Result: no matches.

## Validation

Full plugin-wallet check:

```sh
PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-wallet check
```

Result: passed (`tsc --noEmit`, exit code 0).

No remaining plugin-wallet TypeScript blockers were observed after the owned
news/lpinfo fixes.
