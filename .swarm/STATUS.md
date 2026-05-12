# Swarm status — Eliza-1 "grind it down"

_Updated: 2026-05-12 (resumed director run, has `Agent` tool)._

## Where we are
- **Phase 1 (research):** DONE — `.swarm/plans/cluster-{1..5}.md` + `.swarm/done/cluster-{1..5}` committed.
- **Phase 2 (synthesis):** DONE — `.swarm/IMPLEMENTATION_PLAN.md` (WS-1..WS-6, cross-cutting decisions resolved, H200/Cerebras job list).
- **Phase 3 (implement):** IN PROGRESS.
- **Phase 4 (verify/cleanup):** not started.
- **Phase 5 (finalize):** not started.

## Merged on `develop` (this director session)
- `ea05f7606b` — plugin-sql biome format fix (`isDuplicateKeyError`) + added `bun run verify` / `bun run check` scripts (= `turbo run typecheck lint`).

## In flight (sub-agent workstreams)
- _(populated as agents are spawned/merged)_

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
