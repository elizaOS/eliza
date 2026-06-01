# @elizaos/plugin-training

`@elizaos/plugin-training` adds fine-tuning, trajectory management, and
prompt-optimization infrastructure to an Eliza agent. Capabilities:

- **Auto-training** — `TrainingTriggerService` counts completed trajectories per
  task and fires prompt optimization automatically when the configured threshold
  is reached (default 100 trajectories, 12-hour cooldown).
- **Native optimizer** — in-process prompt optimization via
  `instruction-search`, `prompt-evolution`, `gepa`, `bootstrap-fewshot`, and
  DSPy-native variants (COPRO, MIPRO). Writes artifacts to
  `<stateDir>/optimized-prompts/` for live pickup by `OptimizedPromptService`.
- **Vast.ai GPU training** — orchestrates remote training jobs via
  `/api/training/vast/*` routes and the `VastTrainingService`.
- **Fine-tuning dashboard** — developer-only UI view at `/training` showing
  jobs, datasets, models, evals, benchmarks, and trajectory management.
- **Data collection CLI** — collects Eliza harness benchmark evidence into
  inspectable HTML+JSON run folders. The dashboard and CLI share the same APIs.

## Data collection

Run a dry collection first. It writes artifacts, summaries, and viewers without
requiring live model endpoints:

```bash
bun run --cwd plugins/plugin-training src/core/cli.ts run-collection \
  -o /tmp/eliza-training-run \
  --tiers 0_8b,2b
```

Useful live-readiness checks:

```bash
bun run --cwd plugins/plugin-training src/core/cli.ts run-collection \
  --live \
  --preflight-only \
  --probe-endpoints
```

The collection runner pulls together:

- Hugging Face Eliza-1 training data ingest.
- Feed-generated trajectories from `packages/feed`.
- Natural app trajectories from existing sanitized or raw JSONL exports.
- Scenario runner exports and native scenario trajectory JSONL.
- App-core test trajectory artifacts.
- Local base-vs-trained eval comparison artifacts.
- Eliza harness action benchmark pairs across Eliza-1 tiers.
- Benchmark matrix artifacts with Cerebras reference comparisons when enabled.
- Eliza-1 model registry and bundle-stage metadata.

## Inputs

Natural trajectory imports can be pointed at existing files:

```bash
bun run --cwd plugins/plugin-training src/core/cli.ts run-collection \
  -o /tmp/eliza-training-run \
  --natural-sanitized-jsonl /path/to/trajectories.sanitized.jsonl \
  --natural-raw-jsonl /path/to/trajectories.raw.jsonl \
  --natural-run-id app-run-2026-05-24
```

Benchmark tiers accept a comma-separated list or `all`:

```bash
--tiers all
```

`all` expands to the Eliza-1 tier list used by the benchmark recipe.

## Outputs

Each collection folder contains:

- `collection-manifest.json` with provenance, recipe, step results, evidence
  summaries, readiness gaps, model inventory, benchmark comparisons, and source
  sample previews.
- `README.md` with a markdown summary of sources, samples, models, evals,
  benchmarks, readiness gaps, and step artifacts.
- `analysis/index.html` for per-run browsing of trajectories, datasets,
  scenario turns, evals, benchmark rows, model stats, and collection evidence.
- A parent `collection-index.html` and `collection-index.json` that list saved
  runs with source, eval, benchmark, model, readiness-gap, and viewer links.

Open the generated HTML files directly from the CLI output or from the
fine-tuning dashboard. Saved run cards expose the same source/eval/benchmark/model
artifact links as the collection index.

## Listing saved runs

```bash
bun run --cwd plugins/plugin-training src/core/cli.ts list-collections \
  --root /tmp \
  --limit 5
```

The listing includes:

- `sources=` counts for Hugging Face, feed, natural, scenario, test, and JSONL
  artifacts.
- `benchmarks=` plus baseline progression across Eliza-1 tiers.
- `evals=` with the first base-vs-trained improvement when available.
- `models=` with model inventory and first tracked model.
- `artifact-links=` counts for source and evidence links.
- `gaps=` recommended next actions such as
  `feed_generation:missing->terminal-training-feed-generate`. When an action
  needs options, the summary includes `params={...}`, for example
  `all_eliza1_tiers_benchmark:missing->terminal-training-run-collection params={"actionBenchmarkPairs":"all"}`.

The same recommended params are stored in `collection-manifest.json`, rendered
in `README.md`, shown in the per-run HTML viewer, surfaced in
`plugin-dash-fine-tuning`, and preserved by the `/api/training/collect` client
path. This keeps terminal, API, and dashboard continuation paths aligned.

## Live benchmarks and evals

Dry runs prove artifact wiring and viewer coverage. Live model evaluation needs
the selected provider endpoints and secrets available before running with
`--live`. Use `--preflight-only --probe-endpoints` first; missing checks are also
stored in the run manifest and shown in the HTML viewers and dashboard.

The collection is Eliza-harness oriented. It does not use MMLU as the success
metric; base and trained models are compared on Eliza action/eval artifacts and
reported as percentage improvements, including Cerebras reference deltas when a
reference benchmark is present.
