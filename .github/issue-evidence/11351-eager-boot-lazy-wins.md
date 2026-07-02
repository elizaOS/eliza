# 11351 — eager-boot lazy-load wins: residuals + measured delta

Branch `perf/11351-eager-boot-lazy-wins` (base `2a856dde86b`). The two core
wins (settings-section registry `lazy()` + Streamdown lazy stack) shipped in
merged PR #11471; this change lands the two residual eager paths its review
found, plus the broken budget ratchet fix.

## Bundle KPI — before/after (`node packages/benchmarks/loadperf/bundle-kpi.mjs`)

Both runs: clean `bun run --cwd packages/app build:web`, same machine
(macOS arm64, M4 Max), same config, stable dist.

| Metric | Before (2a856dde86b) | After | Delta |
| --- | --- | --- | --- |
| **eager first-paint graph (brotli)** | 3,211,887 B (3136.6 KB / 39 chunks) | 3,144,115 B (3070.4 KB / 57 chunks) | **−67,772 B (−66.2 KB)** |
| initial entry (brotli) | 3,025,994 B (2955.1 KB) | 2,938,909 B (2870.0 KB) | −87,085 B (−85.0 KB) |
| total assets (brotli) | 5,230,367 B | 5,266,611 B | +36,244 B (chunk-split overhead) |
| assets | 379 | 408 | +29 lazy chunks |

Budget checks after the ratchet fix (`bundle-kpi.mjs` exit 0):

```
PASS  initialEntryBrotli: 2870.0 KB / budget 2929.7 KB
PASS  totalAssetsBrotli: 5143.2 KB / budget 15625.0 KB
PASS  largestChunkBrotli: 1248.2 KB / budget 2246.1 KB
PASS  maxDuplicateLibBytes: 351.7 KB / budget 1171.9 KB
PASS  eagerGraphBrotli: 3070.4 KB / budget 3125.0 KB
```

`eagerGraphBrotliBytes` 1,374,505 → 3,200,000 and `initialEntryBrotliBytes`
2,300,000 → 3,000,000: both old values sat *below* the actual measurement
(stale 2026-06-02-era baselines + the broken #11471 ratchet), i.e. gates that
could only fail once #11467 wires them into CI. The new values sit below the
pre-change measurements, so reverting the lazy-loads fails the gate.

## Runtime proof (production dist via the ui-smoke live stack)

Playwright (chromium) against the built `packages/app/dist` served by
`packages/app-core/scripts/playwright-ui-live-stack.ts` (the `audit:app`
webServer), desktop 1440×900 + mobile 390×844. Full-view `audit:app` was not
run (no per-view filter; 349-view walk); this targeted capture covers every
surface the change touches. All 62 checks passed:

- **All 19 settings sections** (`/settings#<id>`) render their lazy body —
  the `aria-busy` Suspense fallback settles on every section, desktop + mobile
  (38/38). Screenshots: `11351-settings-*.png`.
- **Vault modal**: the `SecretsManagerSection-*.js` chunk is **not** fetched at
  boot; after dispatching the open event the chunk loads
  (`SecretsManagerSection-DBRenqH2.js`) and the dialog renders
  (`11351-vault-modal-lazy-open-desktop.png`).
- **Detached-shell windows** (`?shell=settings&tab=ai-model|permissions|updates`,
  `?shell=surface&tab=triggers|chat`) all render past the new
  `DetachedLazyBoundary` edges (10/10). Screenshots: `11351-detached-*.png`.
  (The red "Unhandled UI smoke API route: GET /api/triggers" note in the
  triggers shot is the smoke-stub API lacking that route — stub-lane artifact,
  not a rendering failure.)
- **Chat surface** renders normally (`11351-chat-*.png`); the streamdown chunk
  is not requested until a rich message renders (0 requests on the empty
  transcript — the #11471 laziness is intact).

## Tests

- `packages/ui` full vitest: 5,440 passed / 15 failed — the same 15 fail with
  sources flipped to the base commit (verified by swap-run:
  `widget-coverage.test.ts` ×2 + `chat-stories-smoke.test.tsx` ×13 are
  pre-existing/environmental; `ios-local-agent-transport.test.ts` is
  load-flaky and passes in isolation). Zero new failures.
- Targeted: the 3 App tests whose mocks changed (18 tests), SettingsView +
  settings smoke (14 tests) — all pass.
- `packages/app-core` `src/runtime/desktop` (DetachedShellRoot's package):
  3 files / 13 tests pass.
- `packages/app` unit lane: 296 passed / 4 failed — same 4 coverage-gate
  failures on the base commit (untracked postinstall plugin dirs), zero new.
- Typecheck: `packages/ui` clean; `packages/app-core` error set byte-identical
  to base (8 pre-existing unbuilt-native-dist resolution errors).
- Biome: clean on all touched files.
- `verify-chunk-safety.mjs` (crypto-chunk gate): OK on the after build.
