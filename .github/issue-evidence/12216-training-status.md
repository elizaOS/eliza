# Issue #12216 — Part A: training / quant / publish / data-capture hardening

Branch: `fix/12216-training-pipeline-hardening` (off develop tip `03dbd8c501e`).
Scope: Python training/quant/publish + data-capture only
(`packages/training/`, plus one shared test in
`packages/shared/src/local-inference/catalog.test.ts`). The
plugin-local-inference and cloud fixes (C5/C6/C8/C9/C11/C12/C13/C15/C16/C18) are
a separate agent's scope and are NOT touched here.

## Fixes landed (9 commits, per-fix)

| Fix | Commit | Summary |
| --- | --- | --- |
| **C2** (P0) | `7bf49703e19` | Generic post-step finite-weights guard (`assert_finite_step` / `FiniteWeightsCallback`) in `training/instrumentation.py`, wired unconditionally into `train_local.py`. Checks `torch.isfinite()` across trainable params every `logging_steps` and raises `RuntimeError` naming offenders so a divergent run dies within one save interval instead of writing an all-NaN checkpoint. **Also fixed a latent MRO bug**: the existing `make_hf_callback` listed `TrainerCallback` first, so the base's no-op `on_step_end`/`on_train_begin`/`on_train_end` shadowed the instrumentation hooks — the memory-budget breach guard and tokens/sec trace never fired. Reversed base order (mixin first) on both factories. |
| **C1** (P0) | `521f6ae101a` | Ported the gemma4_unified Liger-off NaN-guard from stranded commit `b7e412f41cb` into `train_local.py`: `model_type` / `architectures` containing `gemma4_unified` / `Gemma4Unified*` → force `use_liger=False` + warn. No-op when the arch is absent (develop has no gemma4_unified today) — defensive insurance. |
| **C3** (P1) | `65f2381257f` | Set `use_liger=False` explicitly on `gemma4-12b` and `gemma4-31b` registry entries — registry is now the single source of truth, no code/registry split-brain. |
| **C4** (P1) | `b71392b28dd` | Catalog↔manifest↔publish tier-set agreement test. Python: new `test_catalog_manifest_publish_tiers_agree` mechanically parses `TIERS=(...)` out of `publish_all_eliza1.sh` and asserts == `ELIZA_1_TIERS`. TS: new `catalog.test.ts` case pins `ELIZA_1_TIER_IDS` + bare-tier projection. |
| **C7** (P1) | `8696ff7816d` | Wired `quantization/test_recipes_smoke.py` into `training-stack.yml` `cpu-smoke` pytest list (CI docker image already `uv sync --extra train`, tests skip cleanly without C refs/compiler). Drive-by: fixed stale `eliza/packages/inference/...` + `.../native-plugins/...` path comments in `_kernel_manifest.py` + `test_recipes_smoke.py` → real `packages/native/plugins/{turboquant-cpu,qjl-cpu,polarquant-cpu}/`. |
| **C10** (P2) | `b250717ae55` | Extended `log_environment()` with the AGENTS.md §9 reproducibility manifest: sha256 of dataset files, tokenizer-artifact hash (dir digests combined), base-checkpoint hash, `git rev-parse HEAD` (+ dirty flag). Non-local HF ids skipped, not faked. |
| **C14** (P2) | `dc7d552ff23` | New `eliza-1.manifest.schema.json` (draft 2020-12) backing the `$schema` URL; promoted a real versioned fixture `fixtures/eliza-1-4b.manifest.json` (built via `build_manifest`, not the cache stub); test runs the fixture through BOTH `validate_manifest()` and the JSON Schema, asserts both agree. |
| **C17** (P2) | `6bdc46b51b3` | Content-hash dedup for `eliza_native_v1` rows in `prepare_eliza1_trajectory_dataset.py`, keyed on canonical native `(request, response)` (provenance excluded). On by default; `--no-dedup` escape hatch; count surfaced as `manifest.droppedDuplicateNativeRows`. |
| **doc drift** | `7f500fb7957` | Fixed stale trajectory state-dir path in `AGENTS.md` + mirrored `CLAUDE.md`: was `~/.eliza/state`, code resolves `ELIZA_STATE_DIR` → `$XDG_STATE_HOME/eliza` → `~/.local/state/eliza` (`packages/core/src/utils/state-dir.ts`). Docs kept in lockstep. |

## Real test output (headless, CPU-only, this worktree)

Python (via `uv run --no-project --with pytest --with torch --with numpy --with transformers --with scipy --with jsonschema`):

```
scripts/training/test_finite_guard.py           -> 11 passed
scripts/training/test_model_registry.py         -> 20 passed
scripts/training/test_instrumentation.py        ->  6 passed
scripts/training/test_optimizer_cpu.py          -> (in aggregate) passed / 5 apollo_torch-gated skips
scripts/manifest/test_eliza1_manifest.py        -> passed (incl. C4 agreement + existing canonical test)
scripts/manifest/test_eliza1_manifest_schema.py ->  7 passed
scripts/quantization/test_recipes_smoke.py      -> 29 passed, 6 skipped (C-ref/compiler + GPU-gated)
scripts/test_prepare_eliza1_trajectory_dataset.py -> 8 passed (3 new dedup cases)

Aggregate run of all eight files: 151 passed, 11 skipped in ~28s.
ruff check on every changed .py: All checks passed!
```

TS (via `bunx vitest run` in `packages/shared`):

```
packages/shared/src/local-inference/catalog.test.ts -> 11 passed
```

CI config: `.github/workflows/training-stack.yml` validated as well-formed YAML.

The 11 skips are all clean, load-bearing skips: `apollo_torch`-gated optimizer
tests (package not installed locally) and the C-reference byte-exact
kernel-parity + GPU tests (skip when the C ref files / a C compiler are absent —
verified the skip messages, not silent passes).

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
- **C7 stale-path caveat:** the plan said the functional path resolution in
  `test_recipes_smoke.py` "resolves correctly" and only the comments were wrong.
  In fact the functional `_REF_C`/`_TURBO_C` paths point at
  `packages/training/inference/{verify,reference}/` which does not exist, and the
  named C ref files (`qjl_polar_ref.c` / `turbo_kernels.c`) don't exist anywhere
  in the tree — so those C-parity tests **skip** (they don't fail). I fixed the
  stale *comments* (in C7 scope) to point at the real
  `packages/native/plugins/...` locations; wiring up the actual C references is
  GPU/kernel-repo work outside Part A.
```
