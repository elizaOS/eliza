# `@elizaos/bench-vision-language`

Vision-language + UI-grounding eval harness for the eliza-1 model line.

The package exposes one runner (`src/runner.ts`) and five adapters that
share a uniform contract (`BenchmarkAdapter`). Each adapter knows how to
load samples, drive the runtime, and score predictions for one benchmark.
The runner picks a tier, loads the requested benchmark, and writes a
single JSON report to `results/<tier>-<benchmark>-<date>.json` — the
exact path the HF model-card pipeline (Task 11) reads from.

## Benchmarks

| Benchmark   | What it measures                                         | Dataset source                                                        | License                  |
| ----------- | -------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------ |
| TextVQA     | Visual Q&A that requires reading scene text              | <https://textvqa.org/dataset/>                                        | Apache-2.0 / CC-BY (imgs) |
| DocVQA      | Q&A over document images (forms, invoices, reports)      | <https://www.docvqa.org/>                                             | Research-only            |
| ChartQA     | Q&A over bar/line/pie charts (numeric + compositional)   | <https://github.com/vis-nlp/ChartQA>                                  | GPL-3.0                  |
| ScreenSpot  | UI grounding (click coordinate → target widget bbox)     | <https://github.com/njucckevin/SeeClick>                              | Apache-2.0               |
| OSWorld     | End-to-end CUA tasks scored on final environment state   | <https://github.com/xlang-ai/OSWorld>                                 | Apache-2.0               |

Per-benchmark scorers:

- TextVQA — VQA soft-score `min(matches/3, 1)` over 10 references.
- DocVQA  — ANLS (Average Normalized Levenshtein Similarity, τ = 0.5).
- ChartQA — relaxed numeric (±5%) for numeric answers, normalised
  exact-match for categorical answers.
- ScreenSpot — `1` when the predicted click lies inside the target bbox.
  Region predictions fall back to IoU > 0.5.
- OSWorld — smoke runs use `osworldStepMatch` (action-trace agreement);
  full runs delegate to `plugins/plugin-computeruse/src/osworld/` and
  score on success rate.

Adapter contract (`src/types.ts`):

```ts
interface BenchmarkAdapter<TPayload = unknown> {
  readonly name: BenchmarkName;
  loadSamples(n: number, opts: { smoke: boolean }): Promise<Sample<TPayload>[]>;
  scoreOne(sample: Sample<TPayload>, prediction: Prediction):
    { score: number; detail?: Record<string, unknown> };
}
```

Same shape across all five benchmarks.

## Smoke vs. full

`--smoke` runs **5 samples per benchmark** using the checked-in fixtures
under `samples/<benchmark>/smoke.json` and a deterministic stub runtime.
No model load, no dataset download, end-to-end in well under 2 minutes:

```bash
cd packages/benchmarks/vision-language
bun run smoke                       # all 5 benchmarks, stub runtime
bun run start -- --smoke --benchmark screenspot  # one benchmark
```

Full runs need the upstream datasets on disk (locations passed via env
vars; the runner errors out if they are missing). Per benchmark:

```bash
TEXTVQA_DATA_DIR=/data/textvqa     bun run start -- --tier eliza-1-9b --benchmark textvqa    --samples 5000
DOCVQA_DATA_DIR=/data/docvqa       bun run start -- --tier eliza-1-9b --benchmark docvqa     --samples 5349
CHARTQA_DATA_DIR=/data/chartqa     bun run start -- --tier eliza-1-9b --benchmark chartqa    --samples 2500
SCREENSPOT_DATA_DIR=/data/screenspot bun run start -- --tier eliza-1-9b --benchmark screenspot --samples 1272
OSWORLD_DATA_DIR=/data/osworld     bun run start -- --tier eliza-1-9b --benchmark osworld    --samples 369
```

The OSWorld full eval also requires the OSWorld VM image
(see `plugins/plugin-computeruse/src/osworld/README` for setup).

## Code-Agent Harness Labels

For matched ElizaOS/OpenCode comparison wiring, the runner accepts
`--harness elizaos` and `--harness opencode` in addition to the existing
`eliza`, `hermes`, and `openclaw` labels:

```bash
bun run start -- --harness elizaos --model-provider openai --model gpt-4o-mini \
  --benchmark screenspot --samples 5 --output elizaos-vision.json
bun run start -- --harness opencode --model-provider openai --model gpt-4o-mini \
  --benchmark screenspot --samples 5 --output opencode-vision.json
```

These labels route through `scripts/vision_harness_runtime.py` and the same
Eliza benchmark bridge used by the code-agent wrappers. They are a driver
surface for promoting `vision_language` into the code-agent matrix once real
VLM credentials, non-stub inputs, and token/call telemetry are available.

## Outputs

Reports land at `results/<tier>-<benchmark>-<date>.json` with shape:

```json
{
  "schemaVersion": "vision-language-bench-v1",
  "tier": "eliza-1-9b",
  "benchmark": "screenspot",
  "generatedAt": "2026-05-14T12:00:00.000Z",
  "sample_count": 100,
  "score": 0.81,
  "baseline_score": 0.876,
  "delta": -0.066,
  "runtime_seconds": 274.3,
  "error_count": 0,
  "input_tokens": 12345,
  "output_tokens": 678,
  "total_tokens": 13023,
  "cached_tokens": 4567,
  "cache_creation_tokens": 0,
  "cached_token_percent": 36.99,
  "llm_call_count": 100,
  "samples": [{ "sampleId": "...", "score": 1, "prediction": { ... } }]
}
```

`baseline_score` is sourced from `baselines.json` (the published Qwen2.5-VL
numbers at the matching parameter count). `delta = score - baseline_score`.
The HF model-card pipeline (Task 11) consumes this directory.

## Runtime entrypoint

The runner uses `runtime.useModel(IMAGE_DESCRIPTION, ...)` (mediated by
`plugin-local-inference`) for VQA/Doc/Chart, the same call with a
grounding prompt for ScreenSpot, and (for OSWorld full runs) the
action-loop wrapper from `plugins/plugin-computeruse/src/osworld/`.
When the plugin can't be imported or the GGUF isn't on disk the runner
falls back to the deterministic stub runtime so harness CI keeps passing.
