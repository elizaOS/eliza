# plugin-wallet analytics suppressions fix

Date: 2026-05-12

Status: owned Birdeye/DexScreener suppression removal completed. Full
`plugin-wallet` typecheck is still blocked by external `lpinfo`/`news` errors.

## Scope

Owned files completed in this pass:

- `plugins/plugin-wallet/src/analytics/birdeye/service.ts`
- `plugins/plugin-wallet/src/analytics/birdeye/search-category.ts`
- `plugins/plugin-wallet/src/analytics/birdeye/birdeye-task.ts`
- `plugins/plugin-wallet/src/analytics/birdeye/birdeye.ts`
- `plugins/plugin-wallet/src/analytics/birdeye/utils.ts`
- `plugins/plugin-wallet/src/analytics/birdeye/providers/trending.ts`
- `plugins/plugin-wallet/src/analytics/birdeye/providers/market.ts`
- `plugins/plugin-wallet/src/analytics/birdeye/providers/agent-portfolio-provider.ts`
- `plugins/plugin-wallet/src/analytics/birdeye/providers/portfolio-factory.ts`
- `plugins/plugin-wallet/src/analytics/birdeye/providers/wallet.ts`
- `plugins/plugin-wallet/src/analytics/dexscreener/service.ts`
- `plugins/plugin-wallet/src/analytics/dexscreener/search-category.ts`

No files under `analytics/lpinfo`, `analytics/news`, `chains`, or `lp` were
edited.

## Suppressions

- Removed the file-level `@ts-nocheck` comments from the owned analytics files.
- Added no `@ts-nocheck`, `@ts-ignore`, `@ts-expect-error`, or broad `any`.
- Final suppression scan over the owned files found no TypeScript ignore
  suppressions.

## Repairs

- Guarded `fetchWalletTxList` returning `false` before wallet history mapping.
- Replaced widened token-search filter strings with literal-safe local
  normalizers.
- Typed Birdeye service response paths for token search, overview, market data,
  security, trade data, wallet portfolio, and wallet transaction history.
- Added local guards/defaults for optional Birdeye multi-price numeric fields.
- Split market data and symbol promises so the provider no longer mixes
  incompatible promise result types.
- Typed market/trending output rows instead of relying on empty-array inference.
- Normalized portfolio provider settings through string guards and returned
  provider `data` as a record-shaped payload.
- Kept DexScreener files suppression-free; they did not produce focused
  TypeScript diagnostics after the removal.

## Validation

Passed:

```sh
PATH="$HOME/.bun/bin:$PATH" bunx tsc --ignoreConfig --noEmit --target ES2022 --module Preserve --moduleResolution Bundler --lib ES2022,DOM,DOM.Iterable --strict --noImplicitAny false --strictNullChecks true --noUncheckedIndexedAccess false --noImplicitOverride false --skipLibCheck --allowImportingTsExtensions --allowSyntheticDefaultImports --esModuleInterop --types node,bun src/analytics/birdeye/service.ts src/analytics/birdeye/search-category.ts src/analytics/birdeye/birdeye-task.ts src/analytics/birdeye/birdeye.ts src/analytics/birdeye/utils.ts src/analytics/birdeye/providers/trending.ts src/analytics/birdeye/providers/market.ts src/analytics/birdeye/providers/agent-portfolio-provider.ts src/analytics/birdeye/providers/portfolio-factory.ts src/analytics/birdeye/providers/wallet.ts src/analytics/dexscreener/service.ts src/analytics/dexscreener/search-category.ts
```

Passed formatting on the owned files:

```sh
PATH="$HOME/.bun/bin:$PATH" bunx @biomejs/biome format --write plugins/plugin-wallet/src/analytics/birdeye/service.ts plugins/plugin-wallet/src/analytics/birdeye/search-category.ts plugins/plugin-wallet/src/analytics/birdeye/birdeye-task.ts plugins/plugin-wallet/src/analytics/birdeye/birdeye.ts plugins/plugin-wallet/src/analytics/birdeye/utils.ts plugins/plugin-wallet/src/analytics/birdeye/providers/trending.ts plugins/plugin-wallet/src/analytics/birdeye/providers/market.ts plugins/plugin-wallet/src/analytics/birdeye/providers/agent-portfolio-provider.ts plugins/plugin-wallet/src/analytics/birdeye/providers/portfolio-factory.ts plugins/plugin-wallet/src/analytics/birdeye/providers/wallet.ts plugins/plugin-wallet/src/analytics/dexscreener/service.ts plugins/plugin-wallet/src/analytics/dexscreener/search-category.ts
```

Passed focused analytics tests:

```sh
PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-wallet test src/analytics/birdeye/providers/portfolio-factory.test.ts src/analytics/birdeye/search-category.test.ts src/analytics/dexscreener/search-category.test.ts
```

Result: 3 test files passed, 8 tests passed. Vitest also emitted the existing
package export-order warning about the `types` condition following `default`.

Full check still fails outside ownership:

```sh
PATH="$HOME/.bun/bin:$PATH" bun run --cwd plugins/plugin-wallet check
```

The final full check output contained no diagnostics under the owned
Birdeye/DexScreener files.

## External Blockers

Remaining top-level diagnostics from the final full package check are outside
the owned write set:

```text
src/analytics/lpinfo/kamino/providers/kaminoProvider.ts(54,5): error TS2322: Type 'MetadataValue[] | undefined' is not assignable to type '{ keypairs?: Record<string, { publicKey?: unknown; }> | undefined; }[] | undefined'.
src/analytics/lpinfo/kamino/services/kaminoLiquidityService.ts(656,11): error TS2322: Type 'TokenInfo | null' is not assignable to type 'null'.
src/analytics/lpinfo/steer/index.ts(19,14): error TS2322: Type 'typeof SteerLiquidityService' is not assignable to type 'ServiceClass'.
src/analytics/lpinfo/steer/providers/steerLiquidityProvider.ts(26,3): error TS2322: Type '(runtime: IAgentRuntime, message: Memory, _state: State) => Promise<...>' is not assignable to type '(runtime: IAgentRuntime, message: Memory, state: State) => Promise<ProviderResult>'.
src/analytics/lpinfo/steer/providers/steerLiquidityProvider.ts(503,79): error TS18048: 'vault.token0' is possibly 'undefined'.
src/analytics/lpinfo/steer/providers/steerLiquidityProvider.ts(503,92): error TS2339: Property 'toLowerCase' does not exist on type 'SteerVaultTokenSide'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(161,12): error TS2339: Property 'steerClient' does not exist on type 'SteerLiquidityService'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(166,62): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(233,11): error TS2345: viem client type is not assignable to the expected client type.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(241,11): error TS2352: viem client conversion may be a mistake because neither type sufficiently overlaps.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(251,57): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(331,15): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(360,71): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(405,38): error TS2345: Argument of type '{ [key: number]: number; }' is not assignable to parameter of type 'string'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(430,60): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(457,9): error TS2322: Type 'SteerResponse<VaultsConnection>' is not assignable to type 'VaultSdkList'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(459,63): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(475,68): error TS2345: diagnostic object is not assignable to parameter of type 'string'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(500,70): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(510,66): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(536,9): error TS2322: Type 'SteerResponse<VaultsConnection>' is not assignable to type 'VaultSdkList'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(538,63): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(560,68): error TS2345: vault debug object is not assignable to parameter of type 'string'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(589,66): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(600,9): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(669,25): error TS2339: Property 'isActive' does not exist on type 'RawSteerVault'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(671,24): error TS2339: Property 'createdAt' does not exist on type 'RawSteerVault'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(672,21): error TS2339: Property 'createdAt' does not exist on type 'RawSteerVault'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(673,28): error TS2339: Property 'createdAt' does not exist on type 'RawSteerVault'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(674,39): error TS2339: Property 'createdAt' does not exist on type 'RawSteerVault'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(676,29): error TS2339: Property 'protocol' does not exist on type 'RawSteerVault'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(676,47): error TS2339: Property 'strategyType' does not exist on type 'RawSteerVault'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(677,26): error TS2339: Property 'positions' does not exist on type 'RawSteerVault'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(679,24): error TS2339: Property 'ammType' does not exist on type 'RawSteerVault'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(680,43): error TS2339: Property 'singleAssetDepositContract' does not exist on type 'RawSteerVault'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(682,25): error TS2339: Property 'protocol' does not exist on type 'RawSteerVault'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(683,27): error TS2339: Property 'beaconName' does not exist on type 'RawSteerVault'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(684,33): error TS2339: Property 'protocolBaseType' does not exist on type 'RawSteerVault'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(685,31): error TS2339: Property 'targetProtocol' does not exist on type 'RawSteerVault'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(691,23): error TS2339: Property 'feeApr' does not exist on type 'RawSteerVault'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(692,27): error TS2339: Property 'stakingApr' does not exist on type 'RawSteerVault'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(693,25): error TS2339: Property 'merklApr' does not exist on type 'RawSteerVault'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(751,13): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(770,11): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(775,64): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(834,72): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(866,17): error TS2345: edge mapper type is not assignable to VaultEdge mapper type.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(872,9): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(891,72): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(951,11): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(965,9): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(1000,9): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(1047,55): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(1076,9): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(1109,60): error TS2345: diagnostic object is not assignable to parameter of type 'string'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(1121,25): error TS2345: edge mapper type is not assignable to VaultEdge mapper type.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(1145,72): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(1163,55): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(1274,62): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(1289,61): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(1321,40): error TS2339: Property 'singleAssetDepositContract' does not exist on type 'SteerVaultDetailInput | RawSteerVault'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(1338,45): error TS2339: Property 'singleAssetDepositContract' does not exist on type 'SteerVaultDetailInput | RawSteerVault'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(1340,9): error TS2345: Argument of type 'string' is not assignable to parameter of type '`0x${string}`'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(1347,9): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(1377,18): error TS2339: Property 'singleAssetDepositContract' does not exist on type 'SteerVaultDetailInput | RawSteerVault'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(1392,43): error TS2339: Property 'singleAssetDepositContract' does not exist on type 'SteerVaultDetailInput | RawSteerVault'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(1399,9): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(1427,9): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(1453,9): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(1479,70): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(1555,43): error TS2345: formatted vault row object is not assignable to parameter of type 'string'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(1574,9): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(1597,62): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(1655,64): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/lpinfo/steer/services/steerLiquidityService.ts(1685,60): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string | undefined'.
src/analytics/news/providers/defiNewsProvider.ts(618,14): error TS2551: Property 'market_cap_rank' does not exist on type CoinGecko market data.
src/analytics/news/providers/defiNewsProvider.ts(619,49): error TS2551: Property 'market_cap_rank' does not exist on type CoinGecko market data.
```
