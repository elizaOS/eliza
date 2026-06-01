# Vision-Language Bench — Agent Guide

Vision-language + UI-grounding eval harness for the eliza-1 model line.
Covers TextVQA, DocVQA, ChartQA, ScreenSpot, and OSWorld via five adapters
sharing a uniform `BenchmarkAdapter` contract. Registered in the suite
registry as `vision_language`.

## Run

```bash
# Direct — all benchmarks, eliza-1-9b tier, 100 samples each
cd packages/benchmarks/vision-language
bun run start -- --tier eliza-1-9b --benchmark textvqa --samples 5000

# Per-benchmark env vars point to dataset roots
TEXTVQA_DATA_DIR=/data/textvqa      bun run start -- --tier eliza-1-9b --benchmark textvqa    --samples 5000
DOCVQA_DATA_DIR=/data/docvqa        bun run start -- --tier eliza-1-9b --benchmark docvqa     --samples 5349
CHARTQA_DATA_DIR=/data/chartqa      bun run start -- --tier eliza-1-9b --benchmark chartqa    --samples 2500
SCREENSPOT_DATA_DIR=/data/screenspot bun run start -- --tier eliza-1-9b --benchmark screenspot --samples 1272
OSWORLD_DATA_DIR=/data/osworld      bun run start -- --tier eliza-1-9b --benchmark osworld    --samples 369

# Through the suite orchestrator
python -m benchmarks.orchestrator run --benchmarks vision_language --provider <p> --model <m>
```

## Smoke test (no model, no dataset download)

```bash
cd packages/benchmarks/vision-language
bun run smoke                                      # all 5 benchmarks, 5 samples each, stub runtime
bun run start -- --smoke --benchmark screenspot    # one benchmark
```

The `--smoke` flag uses checked-in fixtures under `samples/<benchmark>/smoke.json`
and a deterministic stub runtime. Completes in under 2 minutes with no API keys.

## Test the harness

```bash
cd packages/benchmarks/vision-language
bun run test      # vitest run
```

## Layout

| Path | Role |
| --- | --- |
| `src/runner.ts` | CLI entrypoint and main run loop |
| `src/types.ts` | Shared types: `BenchmarkAdapter`, `Sample`, `Prediction`, `BenchReport` |
| `src/runtime-resolver.ts` | Resolves `VisionRuntime` from tier/harness/provider flags |
| `src/adapters/` | Five adapters: textvqa, docvqa, chartqa, screenspot, osworld |
| `src/scorers/index.ts` | Per-benchmark scoring functions |
| `samples/<benchmark>/smoke.json` | Checked-in fixtures used by `--smoke` |
| `baselines.json` | Published Qwen2.5-VL baseline scores keyed by `tier::benchmark` |
| `tests/` | vitest suite: adapters, runner, scorers |

## Notes

- Results write to `results/<tier>-<benchmark>-<date>.json` (gitignored).
- Scored by `_score_from_vision_language_json` in `registry/scores.py`.
- OSWorld full runs require the OSWorld VM image; see `plugins/plugin-computeruse/src/osworld/`.
- `baseline_score` is sourced from `baselines.json`; `delta = score - baseline_score`.
- Full background: [README.md](README.md).
