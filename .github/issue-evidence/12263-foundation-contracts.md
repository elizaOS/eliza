# #12263 foundation contracts evidence

Chunk: policy docs, `ElizaError`, `EventType.ERROR_REPORTED`, and
`runtime.reportError(scope, error, context)`.

## Commands run

```bash
bun run --cwd packages/core prebuild
bun run --cwd packages/cloud/routing build
bunx biome check AGENTS.md CLAUDE.md packages/core/src/errors.ts packages/core/src/errors.test.ts packages/core/src/index.node.ts packages/core/src/index.browser.ts packages/core/src/index.edge.ts packages/core/src/runtime.ts packages/core/src/types/events.ts packages/core/src/types/runtime.ts
bun run --cwd packages/core test -- errors.test.ts
bun run --cwd packages/core typecheck
bun run verify
bun run --cwd packages/cloud/shared typecheck
bun run --cwd packages/cloud/api typecheck
```

## Results reviewed

- Biome touched-file check: passed, no fixes pending.
- Focused core test: passed, 1 file / 4 tests.
- Core typecheck: passed.
- Root verify: failed outside this chunk in cloud typecheck. The first failed
  lane was `@elizaos/cloud-shared#typecheck` while build artifacts were still
  being produced; rerunning `bun run --cwd packages/cloud/shared typecheck`
  passed after the build lane completed.
- Remaining unrelated failure: `bun run --cwd packages/cloud/api typecheck`
  fails in `packages/cloud/shared/src/lib/services/market-preview.ts` because
  `@elizaos/shared` does not currently export `CoinGeckoMarketRecord`,
  `buildCoinGeckoMarketsUrl`, `buildMarketMovers`, `buildMarketPriceSnapshots`,
  `COINGECKO_MARKET_PROVIDER`, `POLYMARKET_MARKET_PROVIDER`, or
  `parseCoinGeckoMarkets`.

## Evidence rows

- Backend logs: N/A - this chunk introduces the diagnostic API and validates the
  emitted typed payload in-process; follow-up chunks will attach runtime logs
  from an induced live failure.
- Real-LLM trajectory: N/A - no prompt/provider/action behavior is registered in
  this chunk; the `RECENT_ERRORS` provider PR will include live trajectory
  evidence.
- Screenshots/video: N/A - no UI surface changes.
- Domain artifacts: typed `ERROR_REPORTED` payload is asserted in
  `packages/core/src/errors.test.ts`.
