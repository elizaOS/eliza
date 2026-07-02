# 11351 — eager-boot lazy-load wins: residuals + measured delta

Branch `perf/11351-eager-boot-lazy-wins`, rebased onto `develop` `0140a4fcb9e`
(post #11467, whose `test:client -> check:loadperf-bundle` gate is live). The
two core wins (settings-section registry `lazy()` + Streamdown lazy stack)
shipped in merged PR #11471; this change lands the two residual eager paths its
review found, and ratchets the live gate by the realized saving.

## Bundle KPI — before/after (`node packages/benchmarks/loadperf/bundle-kpi.mjs`)

Both runs: clean `bun run --cwd packages/app build:web`, same machine
(macOS arm64, M4 Max), same config, stable dist. Before = rebase base
`0140a4fcb9e`; after = this branch.

| Metric | Before | After | Delta |
| --- | --- | --- | --- |
| **eager first-paint graph (brotli)** | 3,210,097 B (3135.0 KB / 39 chunks) | 3,142,732 B (3069.1 KB / 57 chunks) | **-67,365 B (-65.8 KB)** |
| initial entry (brotli) | 3,024,127 B (2953.2 KB) | 2,937,470 B (2868.6 KB) | -86,657 B (-84.6 KB) |
| total assets (brotli) | 5,233,041 B | 5,268,874 B | +35,833 B (chunk-split overhead) |
| assets | 379 | 408 | +29 lazy chunks |

Budget checks after the ratchet (`eagerGraphBrotliBytes` 3,400,000 -> 3,330,000;
`initialEntryBrotliBytes` 3,350,000 -> 3,260,000): `eagerGraphBrotli` PASS
(3,142,732 / 3,330,000) and `initialEntryBrotli` PASS (2,937,470 / 3,260,000).
`maxDuplicateLibBytes` FAILS locally on BOTH before (364,286 B) and after
(369,293 B) builds — environmental: this worktree's postinstall-added plugin
dirs create extra app-window HTML entries, each duplicating the per-entry
`index-*` stub; CI's clean checkout measures 219.8 KB max vs the 350,000 B
budget (see BASELINE.md note). Pre-existing, not introduced here.

An earlier pre-rebase measurement against base `2a856dde86b` showed the same
delta (eager -67,772 B, entry -87,085 B), so the saving is stable across the
53-commit rebase.

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
