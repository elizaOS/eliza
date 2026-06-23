# Hand-off — M8 / M9 / M10 (+ M6 RAM defaults) for the M1/M2 agent

> These milestones touch files in the **active M1/M2 uncommitted set**
> (`plugins/plugin-local-inference/src/services/*`, `packages/shared/src/
> local-inference/*`, `downloader.ts`). Editing them from a parallel worktree
> would collide, so this is a precise gap-list for whoever owns that working
> tree to land. Compiled from a read-only audit on fork `c849143c9`, 2026-06-22.
> Canonical tiers are `eliza-1-2b / 4b / 9b / 27b (/27b-256k)`.

## Already done — do NOT redo

- Catalog/registry are Gemma-only (`ELIZA_1_TIER_IDS`), `tokenizerFamily='gemma4'`,
  vocab 262144, EOT/KV/manifest schema cut over (commit `969ae0aa2b`, #9033).
- `hf-search` is already stubbed `disabled=true` at every endpoint (M9 = *delete*,
  not disable).
- HF hub-auth host-gating + integrity + disk preflight done (`de3cfe03a2`) — the
  integrity half of M10.
- M8 catalog purge mostly done; the `not.toContain('eliza-1-0_8b')` / `/0_8b/`
  tests already pass.

## ✅ Done this session (collision-free, already committed)

- **M8 straggler** `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/model_tiers.py`
  — `small` → `eliza-1-2b`, `mid` → `eliza-1-4b` (was `qwen3.5-0.8b` / `qwen3.5-2b`
  + `eliza-1-0_8b.bundle`).
- **M7/M6 evidence** — `reports/M7-cpu-sweep-2026-06-22.md`,
  `M6-gemma-kv-geometry-and-fa.md`, per-tier `reports/cpu-*.json`.

## M8 — remaining straggler (1 file, in the dirty set)

- `plugins/plugin-local-inference/src/services/voice/voice-budget.test.ts:370`
  references `eliza-1-1_7b` → change to `eliza-1-2b` or drop the case.
- `plugins/plugin-local-inference/__tests__/vl-cross-eviction.test.ts` — line 252
  `qwen3-vl-0_8b` is a **purged size tier**, but the test's whole scenario (l.233
  "0_8b → 2b within the vision-describe capability") is built on evicting 0_8b.
  This is **structural**, not a sed: decide the post-purge vision-eviction scenario
  (smallest vision tier is now `…-2b`) and rewrite the case. (`qwen3-vl` is still
  the vision *family* key across the codebase — don't blindly rename that.)

## M9 — remove the generic-GGUF / arbitrary-model machinery (closes #8808)

All in the dirty `src/services/*` + `runtime-class.ts` set. Grouped:

- **Delete files:** `services/generic-gguf-backend.ts`, `services/hf-search.ts`,
  `services/hf-search.test.ts`.
- **`services/backend.ts`:** remove the `generic-gguf` branch in `decideBackend()`,
  the `BackendDispatcher.load()` generic-gguf block + `genericGguf` param,
  `GenericRuntimeUnavailableError`, and `'generic-gguf'` from the
  `LocalInferenceBackend.id` / `BackendDecision.backend` / `.reason` unions.
- **`services/engine.ts`:** drop the `GenericGgufBackend` import + instantiation.
- **`services/assignments.ts`:** remove `AssignmentNotServableError` +
  `canServeRuntimeClassOnHost()`; fix the import/usage in
  `routes/local-inference-compat-routes.ts`.
- **Routes:** delete the hf-search handlers (`local-inference-routes.ts`,
  `routes/local-inference-compat-routes.ts`).
- **`packages/ui`:** remove `searchHuggingFaceGguf()` from
  `api/client-local-inference.ts`; delete `services/local-inference/hf-search.ts(+test)`
  and `custom-search.ts` if unused; drop the re-exports from
  `services/local-inference/index.ts`.
- **`packages/shared/src/local-inference/runtime-class.ts`:** drop `'generic-gguf'`
  from `RuntimeClass`; simplify `classify{Catalog,Installed}ModelRuntimeClass()`.
- **Tests:** update `backend-runtime-class.test.ts`, `assignment-validation.test.ts`.
- **Suggested clean guard test** (additive, `__tests__/`, can be authored against
  mocks ahead of the deletion): `m9-eliza1-only.test.ts` asserting `decideBackend()`
  only returns `llama-cpp` for `fused-eliza1`, the two error types are gone, and
  hf-search 404s.

## M10 — HF downloads via Eliza Cloud proxy (re-scopes #8807; #8809)

`downloader.ts` is dirty. To land:

- Cloud API endpoint that streams model files with auth delegation (**the cloud
  holds the HF token**).
- `downloader.ts`: on gated/unavailable repo → cloud fallback; **remove the local
  `HF_TOKEN` injection** in `resolveHubAuthHeaders()`.
- Remove any local HF-token Settings UI (no local token on desktop/mobile).
- Integration test: `downloader.start(eliza-1-*)` completes with `HF_TOKEN` unset.
- (#8809) memory LRU / dynamic-fit / bench — the `packages/benchmarks/memperf/`
  harness is clean and ready to produce real co-residency / peak-RSS gates.

## M6 — Gemma-aware RAM defaults (TS, dirty set)

Land in `services/active-model.ts` + `services/kv-spill.ts` once committed:
`swa_full=false`, bounded `ctx-checkpoints` (≤1), `mmap` ON, PLE
(`per_layer_tok_embd`) pinned to CPU on GPU backends. Rationale + measured
geometry: [`M6-gemma-kv-geometry-and-fa.md`](M6-gemma-kv-geometry-and-fa.md).
FA is already correct (`AUTO` default) — the one open item is the GPU FA-engage
check for the 512 global head dim (needs CUDA 13.x / Apple Silicon).
