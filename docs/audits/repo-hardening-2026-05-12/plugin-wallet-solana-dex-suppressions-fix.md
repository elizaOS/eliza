# plugin-wallet Solana DEX Suppressions Fix

Date: 2026-05-12

Scope:

- `plugins/plugin-wallet/src/chains/solana/dex/meteora/**`
- `plugins/plugin-wallet/src/chains/solana/dex/orca/**`
- `plugins/plugin-wallet/src/chains/solana/dex/raydium/**`

## Summary

Removed broad file-level TypeScript suppressions across the Solana DEX slice where the installed package surface could be typed locally. The wallet package typecheck now passes with only the Meteora DLMM adapter still suppressed because it imports an undeclared runtime package.

No ambient declarations were added.

## Suppressions

Removed `@ts-nocheck` from:

- `plugins/plugin-wallet/src/chains/solana/dex/meteora/e2e/scenarios.ts`
- `plugins/plugin-wallet/src/chains/solana/dex/meteora/e2e/test-utils.ts`
- `plugins/plugin-wallet/src/chains/solana/dex/meteora/index.ts`
- `plugins/plugin-wallet/src/chains/solana/dex/meteora/providers/positionProvider.ts`
- `plugins/plugin-wallet/src/chains/solana/dex/meteora/services/MeteoraLpService.ts`
- `plugins/plugin-wallet/src/chains/solana/dex/meteora/utils/loadWallet.ts`
- `plugins/plugin-wallet/src/chains/solana/dex/meteora/utils/sendTransaction.ts`
- `plugins/plugin-wallet/src/chains/solana/dex/orca/index.ts`
- `plugins/plugin-wallet/src/chains/solana/dex/orca/providers/positionProvider.ts`
- `plugins/plugin-wallet/src/chains/solana/dex/orca/services/srv_orca.ts`
- `plugins/plugin-wallet/src/chains/solana/dex/orca/types.ts`
- `plugins/plugin-wallet/src/chains/solana/dex/orca/utils/loadWallet.ts`
- `plugins/plugin-wallet/src/chains/solana/dex/orca/utils/sendTransaction.ts`
- `plugins/plugin-wallet/src/chains/solana/dex/raydium/index.ts`
- `plugins/plugin-wallet/src/chains/solana/dex/raydium/providers/positionProvider.ts`
- `plugins/plugin-wallet/src/chains/solana/dex/raydium/services/srv_raydium.ts`
- `plugins/plugin-wallet/src/chains/solana/dex/raydium/types.ts`

Removed `@ts-expect-error` from:

- `plugins/plugin-wallet/src/chains/solana/dex/meteora/utils/dlmm.ts`

Kept `@ts-nocheck` in:

- `plugins/plugin-wallet/src/chains/solana/dex/meteora/utils/dlmm.ts`

Reason kept: the file statically imports and re-exports `@meteora-ag/dlmm`, but `@elizaos/plugin-wallet` does not declare that package, the root lockfile does not contain it, and it is not installed under root or wallet `node_modules`. Removing the file-level suppression exposes the missing package boundary. The correct fix requires adding `@meteora-ag/dlmm` as a direct `plugins/plugin-wallet` dependency and updating the lockfile, which is outside this pass's write set.

## Boundary Findings

- Meteora DLMM: `utils/dlmm.ts` depends on `@meteora-ag/dlmm` without a package dependency. This remains a blocker. I did not add an ambient module declaration because that would hide the missing runtime dependency.
- Orca positions: the old provider used legacy SDK helpers (`getUserPositions`, `getWhirlpool`, `PoolUtil.sqrtPriceX64ToPrice`, `PoolUtil.tickIndexToPrice`) that are not present on the installed Orca SDK surface. The provider now typechecks and degrades explicitly to no positions with a warning. Restoring live Orca position discovery likely requires a rewrite against `@orca-so/whirlpools` v2 plus its required `@solana/kit` API boundary.
- Raydium positions: the installed Raydium SDK does not expose the legacy `Clmm.getPool`/`Position.getPositionsByOwner` helper pair assumed by the absorbed provider. The provider now guards that dynamic SDK shape, returns no positions when unavailable, and validates returned position records before use.

## Validation

- `PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-wallet check`
  - Result: passed.
- `PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-wallet test src/lp/services/LpManagementService.test.ts`
  - Result: passed, 1 test file / 4 tests. Vitest emitted the existing package export ordering warning for `package.json`.
- `rg -n "@ts-expect-error|@ts-nocheck|@ts-ignore" plugins/plugin-wallet/src/chains/solana/dex/meteora plugins/plugin-wallet/src/chains/solana/dex/orca plugins/plugin-wallet/src/chains/solana/dex/raydium`
  - Result: only `plugins/plugin-wallet/src/chains/solana/dex/meteora/utils/dlmm.ts:1` remains.
- `git diff --check -- plugins/plugin-wallet/src/chains/solana/dex/meteora plugins/plugin-wallet/src/chains/solana/dex/orca plugins/plugin-wallet/src/chains/solana/dex/raydium`
  - Result: passed.

## Remaining Blockers

- Add `@meteora-ag/dlmm` to `plugins/plugin-wallet/package.json` and update `bun.lock`, then remove the remaining `@ts-nocheck` from `meteora/utils/dlmm.ts`.
- Replace the Orca position fallback with a current SDK implementation. Do not import `@solana/kit` transitively; declare it if the v2 Orca API is used directly.
- Confirm whether Raydium LP position discovery should be removed, replaced with current SDK/API calls, or kept as an explicit unavailable capability for this plugin version.
