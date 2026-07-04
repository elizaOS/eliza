# Issue #12216 — Part A: training / quant / publish / data-capture hardening

Branch: `fix/12216-training-pipeline-hardening` (off develop tip `03dbd8c501e`).
Scope: Python training/quant/publish + data-capture only
(`packages/training/`, plus one shared test in
`packages/shared/src/local-inference/catalog.test.ts`). The
plugin-local-inference and cloud fixes (C5/C6/C8/C9/C11/C12/C13/C15/C16/C18) are
a separate agent's scope and are NOT touched here.

## Adversarial-review follow-ups (3 confirmed issues — all fixed)

A coordinator adversarial review found three real issues. All fixed in this
worktree, committed (not pushed):

1. **[HIGH] New regression tests never ran in CI.** The `cpu-smoke` pytest list
   is hardcoded and only `test_recipes_smoke.py` had been added — the C2 finite-
   guard, C3 registry, C4 manifest-agreement, and C10/C14/C17 tests were never
   executed by CI. **Fix (`855b734ac9b`):** added all seven of my test files to
   the `cpu-smoke` invocation. Verified each is listed in the YAML.
2. **[HIGH] False green from silently-skipping parity tests.** `test_recipes_
   smoke.py`'s C-reference byte-exact parity tests resolved to a NONEXISTENT
   `packages/training/inference/{verify,reference}/` path, so all six silently
   `pytest.skip`'d — coverage theater. The real C refs DO exist, at
   `plugins/plugin-local-inference/native/{verify,reference}/` (directly tracked,
   not a submodule). **Fix (`a30d8383487`):** corrected the path resolution
   (`_HERE.parents[3]`) with an `ELIZA_KERNEL_REF_DIR` override, and the CI step
   now mounts that dir + sets the env so the parity tests **compile-and-run in
   CI** instead of skipping. Verified: the six parity tests now RUN (35 passed,
   0 skipped locally, was 29 passed + 6 skipped). When refs are genuinely absent
   the skip is loud and names the exact missing file — no silent skip.
3. **[MEDIUM] C10 tokenizer hash never captured.** `train_local.py` called
   `log_environment()` without `tokenizer_path`, so the tokenizer artifact hash
   (required by AGENTS.md §9) was missing. **Fix (`4449deaa6d9`):** train_local.py
   now materializes the exact tokenizer (incl. chat-template override) to
   `out_dir/tokenizer` and passes it; a regression test asserts the tokenizer
   sha256 lands in `environment.json`.

## Fixes landed (per-fix commits)

| Fix | Commit | Summary |
| --- | --- | --- |
| **C2** (P0) | `7bf49703e19` | Generic post-step finite-weights guard (`assert_finite_step` / `FiniteWeightsCallback`) in `training/instrumentation.py`, wired unconditionally into `train_local.py`. Checks `torch.isfinite()` across trainable params every `logging_steps` and raises `RuntimeError` naming offenders so a divergent run dies within one save interval instead of writing an all-NaN checkpoint. **Also fixed a latent MRO bug**: the existing `make_hf_callback` listed `TrainerCallback` first, so the base's no-op `on_step_end`/`on_train_begin`/`on_train_end` shadowed the instrumentation hooks — the memory-budget breach guard and tokens/sec trace never fired. Reversed base order (mixin first) on both factories. |
| **C1** (P0) | `521f6ae101a` | Ported the gemma4_unified Liger-off NaN-guard from stranded commit `b7e412f41cb` into `train_local.py`: `model_type` / `architectures` containing `gemma4_unified` / `Gemma4Unified*` → force `use_liger=False` + warn. No-op when the arch is absent (develop has no gemma4_unified today) — defensive insurance. |
| **C3** (P1) | `65f2381257f` | Set `use_liger=False` explicitly on `gemma4-12b` and `gemma4-31b` registry entries — registry is now the single source of truth, no code/registry split-brain. |
| **C4** (P1) | `b71392b28dd` | Catalog↔manifest↔publish tier-set agreement test. Python: new `test_catalog_manifest_publish_tiers_agree` mechanically parses `TIERS=(...)` out of `publish_all_eliza1.sh` and asserts == `ELIZA_1_TIERS`. TS: new `catalog.test.ts` case pins `ELIZA_1_TIER_IDS` + bare-tier projection. |
| **C7** (P1) | `8696ff7816d`, `a30d8383487`, `855b734ac9b` | Wired `quantization/test_recipes_smoke.py` into `training-stack.yml` `cpu-smoke`. **After review**: fixed the C-ref path bug so the six byte-exact parity tests actually COMPILE-AND-RUN (not silently skip), and the CI step mounts `plugins/plugin-local-inference/native` + sets `ELIZA_KERNEL_REF_DIR` so they run for real in CI. Drive-by: fixed stale `eliza/packages/inference/...` path comments → real `packages/native/plugins/{turboquant-cpu,qjl-cpu,polarquant-cpu}/`. |
| **C10** (P2) | `b250717ae55`, `4449deaa6d9` | Extended `log_environment()` with the AGENTS.md §9 reproducibility manifest: sha256 of dataset files, tokenizer-artifact hash (dir digests combined), base-checkpoint hash, `git rev-parse HEAD` (+ dirty flag). Non-local HF ids skipped, not faked. **After review**: `train_local.py` now passes `tokenizer_path` (materialized to `out_dir/tokenizer`) so the tokenizer hash is actually captured. |
| **C14** (P2) | `dc7d552ff23` | New `eliza-1.manifest.schema.json` (draft 2020-12) backing the `$schema` URL; promoted a real versioned fixture `fixtures/eliza-1-4b.manifest.json` (built via `build_manifest`, not the cache stub); test runs the fixture through BOTH `validate_manifest()` and the JSON Schema, asserts both agree. |
| **C17** (P2) | `6bdc46b51b3` | Content-hash dedup for `eliza_native_v1` rows in `prepare_eliza1_trajectory_dataset.py`, keyed on canonical native `(request, response)` (provenance excluded). On by default; `--no-dedup` escape hatch; count surfaced as `manifest.droppedDuplicateNativeRows`. |
| **doc drift** | `7f500fb7957` | Fixed stale trajectory state-dir path in `AGENTS.md` + mirrored `CLAUDE.md`: was `~/.eliza/state`, code resolves `ELIZA_STATE_DIR` → `$XDG_STATE_HOME/eliza` → `~/.local/state/eliza` (`packages/core/src/utils/state-dir.ts`). Docs kept in lockstep. |

## Real test output (headless, CPU-only, this worktree)

Python (via `uv run --no-project --with pytest --with torch --with numpy --with transformers --with scipy --with jsonschema`):

```
scripts/training/test_finite_guard.py             -> 11 passed
scripts/training/test_model_registry.py           -> 20 passed
scripts/training/test_instrumentation.py          ->  7 passed  (+1 tokenizer-hash regression)
scripts/training/test_optimizer_cpu.py            ->  1 passed,  5 skipped (apollo_torch-gated)
scripts/manifest/test_eliza1_manifest.py          -> 69 passed  (incl. C4 agreement)
scripts/manifest/test_eliza1_manifest_schema.py   ->  7 passed
scripts/quantization/test_recipes_smoke.py        -> 35 passed,  0 skipped  (was 29+6; C-ref parity now RUNS)
scripts/test_prepare_eliza1_trajectory_dataset.py ->  8 passed  (3 dedup cases)

Aggregate run of all eight files: 158 passed, 5 skipped in ~7s.
ruff check on every changed .py: All checks passed!
```

TS (via `bunx vitest run` in `packages/shared`):

```
packages/shared/src/local-inference/catalog.test.ts -> 11 passed
```

CI config: `.github/workflows/training-stack.yml` validated as well-formed YAML;
all seven new/modified test files are listed in the `cpu-smoke` pytest
invocation, and the job mounts the kernel-ref dir so the parity tests run there.

**C7 parity-test disclosure (honest):** the six C-reference byte-exact parity
tests in `test_recipes_smoke.py` (`test_qjl_block_layout_packing_matches_c_ref`,
`test_polarquant_block_dequant_parity_against_c_ref`,
`test_qjl_projection_layout_matches_c_ref`,
`test_polarquant_full_block_parity_against_c_ref`,
`test_polarquant_python_sign_vector_pinned`,
`test_kernel_reference_files_exist_and_compile_clean`) **now COMPILE the real C
references and RUN** (they used to silently skip against a nonexistent path). The
remaining 5 skips in the aggregate are only the `apollo_torch`-gated optimizer
tests — that package isn't installed in the minimal local env; it IS present in
the CI `--extra train` image, where those run too. There are no longer any
silent parity skips masquerading as coverage. If the kernel-ref dir is ever
genuinely absent, the skip is loud and names the exact missing file.

## ⚑ C19 — MAINTAINER DECISION REQUIRED (not implemented — do not guess)

`packages/training/scripts/manifest/eliza1_manifest.py::REQUIRED_KERNELS_BY_TIER`
requires `turbo3_tcq` on **all five tiers** (`2b/4b/9b/27b/27b-256k`), but
`packages/training/AGENTS.md` §3 frames Trellis-coded TCQ as
"(long-context-only) ... the largest variant". These disagree. Two possible
reconciliations — a human must pick:

1. **Code is right (TCQ is universal post-Gemma-cutover):** update AGENTS.md §3
   to drop the "long-context-only" framing and document that `turbo3_tcq` is a
   universal required kernel. The TS-side validator comment implies this is the
   deliberate post-cutover behavior, which slightly favors this option — but it
   is not conclusive.
2. **Doc is right (TCQ is long-context-only):** scope
   `REQUIRED_KERNELS_BY_TIER`'s `turbo3_tcq` requirement back to just
   `27b-256k`.

I did **not** change `REQUIRED_KERNELS_BY_TIER` or AGENTS.md §3 — flipping either
side changes the publish gate's required-kernel contract, which is a product
decision, not a mechanical fix. Existing test
`test_eliza1_manifest.py::test_eliza1_tier_ids_are_canonical` currently pins the
all-tiers behavior, so option (2) would also require updating that assertion.

## GPU / HF-gated remainder (out of headless scope — deferred to CI / operator)

Per plan section D. These cannot be exercised in this worktree (no GPU, no
`HF_TOKEN`, no device matrix):

- **GPU-gated (the load-bearing C1/C3 confirmation):** actually re-running the
  12B/31B SFT after C1/C3 land to confirm no NaN divergence. The code fix is in
  place and unit-tested at the guard level (C2), but *live* NaN-prevention needs
  a real 12B/31B run. Recipe: on an FSDP box (e.g. 2×H200),
  `uv run --extra train python scripts/train_local.py --registry-key gemma4-12b
  --train-file data/final/train.jsonl` (or `scripts/train_vast.sh`) and confirm
  the first ~50 steps' loss stays finite + the saved checkpoint's weights pass
  `assert_finite_step`. With C2 wired, a divergent run now dies loudly within one
  `logging_steps` interval instead of saving dead weights.
- **GPU-gated (quant):** the four real-artifact quant runs
  (`test_turboquant.py` / `test_qjl.py` / `test_polarquant.py` /
  `test_fused_turboquant.py`) against real Gemma checkpoints, and measured
  `4b`/`9b`/`27b`/`27b-256k` tier evidence (only `2b` has published numbers
  today). The `--trellis`/TCQ path has zero measured evidence for any tier. C7
  wires the *synthetic CPU* smoke + C-ref parity into CI; the real-artifact runs
  remain GPU-gated by design.
- **HF-gated (corpus durability):** actually invoking
  `scripts/publish_dataset_to_hf.py` to push a real corpus snapshot (code is
  ready; needs `HF_TOKEN` + network). C17 makes the corpus dedup-clean before
  push. Recipe: `HF_TOKEN=hf_xxx uv run python -m scripts.publish.publish_dataset
  --dry-run` first, then without `--dry-run` to push. Nothing invokes this
  automatically today — corpus durability remains operator-run-only (the "lost a
  corpus to a pruned worktree" concern is mitigated by dedup + reproducibility
  hashing here, but automatic durable backup is out of Part-A scope).

## Notes on plan deltas found while implementing

- **C2 uncovered a real adjacent bug** (shadowed `make_hf_callback` MRO — the
  memory-budget guard never fired). Fixed in the same commit since it is the
  same one-line ordering fix in the same module and directly in the spirit of
  "make guards actually fire"; added an MRO regression test.
- **C4 Python half was already partly covered** by the pre-existing
  `test_eliza1_tier_ids_are_canonical`. I added the *three-file* agreement check
  (mechanical parse of `publish_all_eliza1.sh::TIERS`) which was the missing
  piece, plus the TS half.
- **C7 stale-path — corrected after review:** the plan said the functional path
  resolution "resolves correctly" and only the comments were wrong. In fact the
  functional `_REF_C`/`_TURBO_C` paths pointed at a nonexistent
  `packages/training/inference/{verify,reference}/`, so the six C-parity tests
  silently skipped — a false green. The real C refs (`qjl_polar_ref.c` /
  `turbo_kernels.c`) DO exist, at
  `plugins/plugin-local-inference/native/{verify,reference}/` (directly tracked,
  not a submodule). My first pass only fixed the stale prose comments. After the
  adversarial review I fixed the actual path resolution (`_HERE.parents[3]` +
  `ELIZA_KERNEL_REF_DIR` override) so the parity tests **compile-and-run** (35
  passed, 0 skipped), and the CI step mounts that dir so they run in CI too. The
  `packages/native/plugins/{turboquant-cpu,qjl-cpu,polarquant-cpu}/` header/
  centroid comments remain accurate for the *codebook* pins; the compiled
  C-reference sources are the `plugin-local-inference/native/{verify,reference}`
  ones.
```
