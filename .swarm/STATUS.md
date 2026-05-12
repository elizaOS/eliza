# Swarm status — Eliza-1 "grind it down"

_Updated: 2026-05-12 (resumed director run, has `Agent` tool)._

## Where we are
- **Phase 1 (research):** DONE — `.swarm/plans/cluster-{1..5}.md` + `.swarm/done/cluster-{1..5}` committed.
- **Phase 2 (synthesis):** DONE — `.swarm/IMPLEMENTATION_PLAN.md` (WS-1..WS-6, cross-cutting decisions resolved, H200/Cerebras job list).
- **Phase 3 (implement):** IN PROGRESS.
- **Phase 4 (verify/cleanup):** not started.
- **Phase 5 (finalize):** not started.

## Merged on `develop` (this director session — single-agent, no `Agent`/`Task` tool)
- `ea05f7606b` — plugin-sql biome format fix (`isDuplicateKeyError`) + added `bun run verify` / `bun run check` scripts (= `turbo run typecheck lint`).
- `7fca7ae565` — plugin-wallet: declare `@meteora-ag/dlmm` + `uuid` deps (Docker CI smoke `build:client`); re-synced stale `bun.lock`.
- `bd5ee1e180` — agent: pin `drizzle-orm` tsconfig path to app-core's copy (fixes the 56 `@elizaos/agent#typecheck` errors).
- `119f6151ce` — ui/test: stub `@capacitor/app` + `@elizaos/{capacitor-llama,app-wallet}` for vitest (fixes Tests workflow Client Tests).
- `326c415a49` — biome: exclude vendored `packages/inference/llama.cpp` from `biome check .` (−773 errors).
- `0c6b199475` — biome format + safe lint over `scripts/` (89 files, mechanical, no behavior change).
- `2bf9b38803` — repaired `cerebras-nightly.yml` YAML (broken block scalar made GitHub fail to parse the workflow on every event).

## In flight / open (no sub-agents available — director works directly)
- `Tests` workflow Plugin Tests: `Cannot find package 'ethers'` from `packages/agent/src/api/registry-service.ts` when `plugins/app-training`'s test pulls in the `@elizaos/agent` barrel. May be fixed by the `bun.lock` re-sync; verifying on the next run.
- `Docker CI Smoke` was timing out at 40min — plugin-wallet build was one cause (fixed); watch the next run.
- Repo-wide `bunx biome check .` still ~822 errors (after llama.cpp ignore + scripts/ sweep) — `benchmarks/`, `test/`, plugins, test fixtures, machine-JSON. Stretch goal per WS-1; doing it in safe scoped batches (avoid colliding with concurrent automation; never the mass `--write` over 1.2k files).
- The big implementation workstreams (WS-2 kernel parity / build matrix, WS-3 fork builds / model bundles / 0.6b fine-tune, WS-4 guided structured decode fast-forward / W7 streaming, WS-5 the duet harness / latency grind / emotion) — these need GPU + sub-agent capacity; the 0.6b APOLLO SFT was launched by a prior session (commit `37f94a1307`). Director cannot drive these without sub-agents; concurrent automation sessions are carrying them.

## Known-red CI (targets)
- `Tests` workflow — Client/Plugin Tests fail: `@elizaos/capacitor-llama` / `@elizaos/app-wallet` / `@capacitor/app` resolution → root cause is the CI postinstall cascade ("No bun/install.js found" → `bun run postinstall` aborts before `ensure-workspace-symlinks.mjs`). Fix: make `.github/actions/setup-bun-workspace/action.yml` run `node scripts/ensure-workspace-symlinks.mjs && node scripts/ensure-native-plugins-linked.mjs` explicitly after postinstall (and tolerate a partial postinstall).
- `@elizaos/agent#typecheck` — 56 errors from a split `drizzle-orm@0.45.2+<hash>` install (two physical dirs). Fix: dedup via root `overrides`/`resolutions`.
- `Docker CI Smoke` — failing (investigate).
- `Quality (Extended)` Format Check — was plugin-sql (fixed `ea05f7606b`); re-check.
- `.github/workflows/cerebras-nightly.yml` — needs `CEREBRAS_API_KEY` secret; not a code fix.
- Repo-wide `bunx biome check .` (~2.3k non-`src` errors) — stretch goal per WS-1.

## Credentials available (operator, 2026-05-12)
- `HF_TOKEN` (write to `elizaos`) — provided by the operator out-of-band; do not commit it.
- `CEREBRAS_API_KEY` (gpt-oss-120b, OpenAI-compatible) — provided by the operator out-of-band; do not commit it.
- Nebius H200: needs interactive `nebius` CLI browser-SSO login (operator completes the browser step).
- Local: RTX 5080 Laptop (sm_120, CUDA 12.8), Intel ANV iGPU (Vulkan), x86-64 AVX2/AVX-VNNI.

## Director session 2026-05-12 — additional CI fixes (this run)
- `01054138cd` — ui: removed duplicate `./events` export entry (`bun install` in the docker-ci-smoke container warned on it; biome `noDuplicateObjectKeys`).
- `13e18fc036` — ui: biome-formatted `tsconfig.json` + `tsconfig.build.json`.
- `c46f41be14` — biome format + safe lint over `test/` (350 files, mechanical).
- `84a96d2d40` — biome format + safe lint over `packages/benchmarks/` + ignore vendored upstream benchmark trees (OSWorld, HyperliquidBench, loca-bench/gem+vis_traj, *.html).
- Verified locally: `bun install --frozen-lockfile` is clean & stable under bun 1.3.13 (the repo's `packageManager`); installed bun 1.3.13 locally for parity. The committed `bun.lock` (re-synced in `7fca7ae565`) does not drift under 1.3.13 — the CI "bun.lock changed during dependency install" / docker-ci-smoke "bun install failed after 3 attempts" failures are CI-infra (stale `~/.bun/install/cache` restored via `restore-keys: bun-Linux-`, apt-mirror flakes, the bun npm-package placeholder binary) plus the now-fixed duplicate `./events` key — not a bad lockfile.
- Verified: `@elizaos/agent#typecheck` and `@elizaos/app-core#typecheck` and `@elizaos/ui#typecheck` all pass clean locally after the drizzle-orm tsconfig pin.

## Known-remaining (honest)
- Repo-wide `bunx biome check .` ≈ 800 diagnostics left, mostly `noNonNullAssertion`/`noExplicitAny` warnings + a few `format`/`organizeImports` in `plugins/app-lifeops` (140), `plugins/plugin-social-alpha` (vendor code, lint deliberately skipped, its `biome.json` is missing `"extends": "//"` so it formats with tabs — needs a 1-line fix), `packages/inference/**` (102 — deferred per the plan: C2/C3/C4 are rewriting it, sweep last), `packages/app-core` (81), various small plugins. The per-package `turbo run lint` (the CI contract) is green. Repo-wide-clean is a documented WS-1 stretch goal.
- The big implementation workstreams (WS-2 kernel parity / build matrix, WS-3 fork-built GGUFs + model bundles + 0.6b APOLLO fine-tune + drafters, WS-4 guided structured-decode fork fast-forward + W7 fused streaming decoders, WS-5 the two-agents duet harness + scientific latency grind + emotion fidelity) are GPU- and sub-agent-bound; the 0.6b APOLLO SFT was launched by a prior session (`37f94a1307`). This director run has no `Agent`/`Task` tool — it can only work directly; concurrent automation sessions on `develop` are carrying the heavy lanes.
- CI runs on `develop` are frequently `cancelled` by the high commit rate from concurrent automation (concurrency groups) — clean terminal-state reads require a quiet window.
