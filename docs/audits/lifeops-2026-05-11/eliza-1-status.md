# Eliza-1 bundle status — Wave 3-B (2026-05-11)

Single source of truth for "what bundles exist, what state are they in, and
what would it take to mark them `final`". Every consumer (benchmark
aggregator, prompt-optimizer corpus, public docs) reads release state from
the bundle's own `manifest.json`. AGENTS.md Cmd #8 forbids silently flipping
`preRelease=true → false`; the predicate is `bundleIsPreRelease()` in
`packages/benchmarks/lib/src/eliza-1-bundle.ts` (Python mirror at
`packages/benchmarks/lifeops-bench/eliza_lifeops_bench/eliza_1_bundle.py`).

A bundle is publishable only when **all three** gates clear:

- `releaseState == "final"`
- `publishEligible == true`
- `final.weights == true`

Anything less stays `preRelease=true` and the aggregator stamps a banner on
`report.md` plus `preRelease: true` on every `RunMetrics` / top-level field
in `report.json`.

## Per-bundle status

> **2026-05-11 (Wave-6 G4 refresh):** the table below reflects the *intended*
> per-tier release state. The on-disk reality on this checkout (after the
> G4 sub-agent pulled real Qwen weights from HF) is recorded in
> [`g4-bundle-status.md`](./g4-bundle-status.md). Short version: 0.6b / 1.7b /
> 9b now have real, sha-matched base weights staged locally with bench-harness
> `manifest.json` files; 27b / 27b-1m are blocked on a ≈ 16.5 GiB upstream
> pull (disk budget) and have no on-disk bundle yet. No drafter for any tier
> on this host.
>
> **2026-05-11/12 (Wave-7 H1-redo):** the 27b / 27b-1m bundles are now staged
> locally after disk cleanup. `Qwen-Qwen3.6-27B-Q4_K_M.gguf` (16.55 GiB,
> sha256 `f741bb17c9e5eae6629f211aed5675edad1120504654b27704fcdf5653e6417b`)
> was pulled from `batiai/Qwen3.6-27B-GGUF` and hardlinked across both
> bundles — `source/` and `text/` paths in both `eliza-1-27b.bundle/` and
> `eliza-1-27b-1m.bundle/` all share inode `329833689` (link count 4),
> so total disk footprint stays at ~16.5 GiB. 27b-1m manifest adds
> `contextWindow: 1048576` to record the rope-scaling target. Both stay
> `releaseState=local-standin` / `publishEligible=false` / `final.weights=false`.
> Drafter still missing for all tiers.
>
> **2026-05-11 (Wave-7 H2 update):** the three on-disk bundles (0.6b, 1.7b,
> 9b) were pushed to Hugging Face under `elizaos/eliza-1-<tier>` as
> **pre-release / local-standin** artifacts. Each repo carries the verbatim
> `manifest.json` (still `releaseState=local-standin`, `publishEligible=false`,
> `final.weights=false`) and a README banner stating the bytes are upstream
> Qwen base weights renamed for the bundle layout — NOT fine-tuned, NOT
> publish-eligible. Full audit:
> [`h2-hf-publish-status.md`](./h2-hf-publish-status.md). Drafter audit
> conclusion: no `elizaos/*-dflash-drafter` repos exist; third-party z-lab
> drafters don't match our exact base tiers; GPU distillation is still
> required. The `elizaos/eliza-1-assets` repo (12 files in the `1_7b/`
> subtree) was already populated before this audit — G4's "empty" claim was
> stale.
>
> Published URLs (pre-release):
> - https://huggingface.co/elizaos/eliza-1-0_6b
> - https://huggingface.co/elizaos/eliza-1-1_7b
> - https://huggingface.co/elizaos/eliza-1-9b

| Bundle ID         | Size    | releaseState   | publishEligible | final.weights | DFlash drafter | Weights validated | preRelease |
|-------------------|---------|----------------|-----------------|---------------|----------------|-------------------|------------|
| `eliza-1-0.6b`    | 0.6b    | local-standin  | false           | false         | **missing**    | ✓                 | **true**   |
| `eliza-1-1.7b`    | 1.7b    | local-standin  | false           | false         | **missing**    | ✓                 | **true**   |
| `eliza-1-9b`      | 9b      | local-standin  | false           | false         | **missing**    | ✓                 | **true**   |
| `eliza-1-27b`     | 27b     | local-standin  | false           | false         | **missing**    | ✓                 | **true**   |
| `eliza-1-27b-1m`  | 27b-1m  | local-standin  | false           | false         | **missing**    | ✓ (hardlinked)    | **true**   |

DFlash drafter gaps: per `ELIZA_1_PRODUCTION_READINESS_REVIEW.md`, the 0.6B
and 1.7B bundles ship without a paired drafter (no upstream drafter has been
distilled yet against those text checkpoints). The 9B / 27B / 27B-1m tiers
have historical drafter binaries on a separate Linux build host
(`qwen3.5-9b-dflash-q8_0.gguf` and family) but those distilled artifacts
are not on this Mac checkout and are not published on Hugging Face — the
drafter pipeline is `packages/training/scripts/distill_dflash_drafter.py`
on a CUDA host. The dflash server still
spawns against the base weights for these sizes but loses speculative
decoding throughput.

## What we'd need to mark each bundle `final`

These are the per-bundle checklists. None are checked off — every current
bundle is a local-standin.

### `eliza-1-0.6b`

- [ ] Real training run weights (not synthesized standin) packaged into the bundle.
- [ ] Produce paired DFlash drafter for speculative decoding (Wave 1-C dflash drafter pipeline).
- [ ] Lifeops bench: pass-rate on the `self-care` static lane ≥ 70% with **no** `ELIZA_BENCH_PRE_RELEASE` shortcut.
- [ ] Action-routing benchmark: F1 ≥ baseline Cerebras `gpt-oss-120b` minus 5pp.
- [ ] Cache schema: `cacheSupported=false` (local-llama-cpp does not expose cache fields). Confirm aggregator emits `cacheSupported:false` consistently rather than `null`.
- [ ] Manifest flip: `releaseState="final"`, `publishEligible=true`, `final.weights=true`.

### `eliza-1-1.7b`

- [ ] Real training run weights packaged.
- [ ] Produce paired DFlash drafter.
- [ ] Lifeops bench: pass-rate on the `self-care` static lane ≥ 78%.
- [ ] Action-routing benchmark: F1 ≥ baseline Cerebras minus 3pp.
- [ ] Manifest flip.

### `eliza-1-9b`

- [ ] Real training run weights packaged (current weights are local-standin).
- [ ] Confirm existing DFlash drafter still binds against the final weights' shape.
- [ ] Lifeops bench: pass-rate on the full static suite ≥ Cerebras baseline minus 2pp.
- [ ] Long-context (32k) eval passes the `payments` + `documents` long-horizon scenarios.
- [ ] Manifest flip.

### `eliza-1-27b`

- [ ] Real training run weights packaged.
- [ ] Confirm DFlash drafter binds against final weights.
- [ ] Lifeops bench: pass-rate ≥ Cerebras baseline.
- [ ] Token-cost regression: per-turn token budget within 10% of Cerebras run.
- [ ] Manifest flip.

### `eliza-1-27b-1m`

- [ ] Real training run weights packaged.
- [ ] Confirm DFlash drafter binds against final weights.
- [ ] Long-context (1M) eval covers the `morning-brief` + `inbox-triage` multi-day scenarios.
- [ ] Memory ceiling: peak RSS during full-context inference fits in the 96 GiB target host envelope.
- [ ] Manifest flip.

## How the bench harness reads this

`ELIZA_1_MODEL_BUNDLE=/path/to/eliza-1-9b.bundle` triggers
`_apply_eliza_one_bundle_override()` in
`packages/benchmarks/lifeops-bench/eliza_lifeops_bench/__main__.py`. The
helper:

1. Calls `read_eliza_one_bundle(bundle_path)` and aborts on any manifest schema violation.
2. Sets `ELIZA_BENCH_PRE_RELEASE=1` when `bundle_is_pre_release(manifest)` is true. Aggregator picks this up and stamps the banner.
3. Spawns the dflash llama-server at `~/.cache/eliza-dflash/eliza-llama-cpp/build/bin/llama-server` against `manifest.weights_path` (passing `--model-draft` when `drafters_path` is set).
4. Publishes `PARALLAX_OPENCODE_BASE_URL=http://127.0.0.1:18781/v1` so the OpenAI-compatible adapter finds the running server.

When the dflash binary is missing the harness exits with a hard error rather
than silently falling back to Ollama — operators are expected to either
build the fork or set `PARALLAX_OPENCODE_BASE_URL` to point at their own
endpoint.

## Cross-references

- Bundle reader: `packages/benchmarks/lib/src/eliza-1-bundle.ts`
- Python mirror: `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/eliza_1_bundle.py`
- Pre-release predicate: `bundleIsPreRelease()` / `bundle_is_pre_release()`
- Aggregator banner: `scripts/aggregate-lifeops-run.mjs` (preReleaseFlag branch)
- Local dflash adapter: `packages/benchmarks/lib/src/local-llama-cpp.ts` (`startLocalServer`, `probeDflashFork`)
- Production readiness review: `ELIZA_1_PRODUCTION_READINESS_REVIEW.md` (root of repo)
