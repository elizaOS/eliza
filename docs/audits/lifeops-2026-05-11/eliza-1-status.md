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

All bundles validated SHA256 ✓ under
`~/.eliza/local-inference/models/eliza-1-<size>.bundle/`.

| Bundle ID         | Size    | releaseState   | publishEligible | final.weights | DFlash drafter | Weights validated | preRelease |
|-------------------|---------|----------------|-----------------|---------------|----------------|-------------------|------------|
| `eliza-1-0.6b`    | 0.6b    | local-standin  | false           | false         | **missing**    | ✓                 | **true**   |
| `eliza-1-1.7b`    | 1.7b    | local-standin  | false           | false         | **missing**    | ✓                 | **true**   |
| `eliza-1-9b`      | 9b      | local-standin  | false           | false         | present        | ✓                 | **true**   |
| `eliza-1-27b`     | 27b     | local-standin  | false           | false         | present        | ✓                 | **true**   |
| `eliza-1-27b-1m`  | 27b-1m  | local-standin  | false           | false         | present        | ✓                 | **true**   |

DFlash drafter gaps: per `ELIZA_1_PRODUCTION_READINESS_REVIEW.md`, the 0.6B
and 1.7B bundles ship without a paired drafter. The dflash server still
spawns against the base weights for these sizes but loses speculative
decoding throughput.

## What we'd need to mark each bundle `final`

These are the per-bundle checklists. None are checked off — every current
bundle is a local-standin.

### `eliza-1-0.6b`

- [ ] Real training run weights (not synthesized standin) packaged into the bundle.
- [ ] Produce paired DFlash drafter for speculative decoding (Wave 1-C dflash drafter pipeline).
- [ ] Lifeops bench: pass-rate on the `self-care` static lane ≥ 70% with **no** `MILADY_BENCH_PRE_RELEASE` shortcut.
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
2. Sets `MILADY_BENCH_PRE_RELEASE=1` when `bundle_is_pre_release(manifest)` is true. Aggregator picks this up and stamps the banner.
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
