# wave-6-g1 — Cerebras rebench + DSPy-MIPRO planner optimization

Date: 2026-05-11
Branch: `develop`
Cerebras key: rotated 2026-05-11 (`csk-8c9hf68jf...`), 52 chars, verified loaded from `eliza/.env`.
Provider: `cerebras` / `gpt-oss-120b` (judge `claude-opus-4-7` declared but no LIVE scenarios in `--suite core` → judge never invoked).
Concurrency: 2 (per `cerebras-backoff.md`).

## 1. Multi-tier smoke

`bun run lifeops:multi-tier:smoke` (tiers=large,frontier).

| tier     | harness  | pass@1 | cost     | notes                                                   |
|----------|----------|-------:|---------:|---------------------------------------------------------|
| large    | hermes   | 0.600  | $0.0103  | 5 scenarios, Cerebras 200s end-to-end                   |
| large    | openclaw | OK     | —        | runs to completion                                      |
| large    | eliza    | FAIL   | —        | `@elizaos/plugin-workflow/dist/index.js` not built; rename in flight |
| frontier | *        | SKIP   | —        | no `ANTHROPIC_API_KEY` in `eliza/.env`                  |

Aggregate step fails on every cell: `Cannot find module '@elizaos-benchmarks/lib'` (workspace symlink missing — out of scope for this rebench, the underlying bench JSONs are intact and parseable). `lifeops:delta` fails for the same reason.

## 2. Hermes core sweep — pre-optimization baseline

Per-domain output dir: `/tmp/lifeops-g1/runs/hermes-core-pre-20260511-201526/<domain>/lifeops_gpt-oss-120b_*.json`.

| domain    | pass@1 | n | cost      | latency (ms) | cache_hit_pct |
|-----------|-------:|--:|----------:|-------------:|---------------|
| calendar  | 0.500  | 4 | $0.0089   | 8739         | null          |
| mail      | 0.667  | 3 | $0.0088   | 8694         | null          |
| reminders | 0.000  | 3 | $0.0049   | 4871         | null          |
| contacts  | 0.000  | 2 | $0.0037   | 3687         | null          |
| finance   | 0.000  | 2 | $0.0047   | 3391         | null          |
| travel    | 0.500  | 2 | $0.0028   | 2005         | null          |
| health    | 0.333  | 3 | $0.0063   | 4462         | null          |
| sleep     | 0.000  | 2 | $0.0037   | 2597         | null          |

**Overall: pass@1 = 0.286, n=21, cost=$0.0437, latency=38446ms.**

`cache_hit_pct` is `null` because Cerebras does not return that field. `cache_read_input_tokens` is recorded per turn (e.g. calendar turn 0 reported 1408 tokens read from cache) — AGENTS.md cmd #8 honored: not loaded → null, not `0`.

Rate-limit incidents: **0**. No `429`, no `RetryExhaustedError`, no `ProviderError`, no `Traceback`. Total wall-clock for the 8-domain sweep: ~1m35s.

## 3. Optimizer artifact

Dataset built from the hermes JSONs via `/tmp/lifeops-g1/build-dataset.mjs` (21 `eliza_native_v1` rows, dataset path checked into the repo):
`plugins/app-training/datasets/lifeops_action_planner_from_hermes-core-pre-20260511-201526.jsonl`.

Optimizer invocation:

```
cd plugins/app-training
TRAIN_MODEL_PROVIDER=cerebras TRAIN_MODEL=gpt-oss-120b \
  bun run train -- --backend native --optimizer dspy-mipro \
  --task action_planner --dataset <dataset>
```

Result line:

> `[train] native dspy-mipro task=action_planner dataset=21 baseline=0.000 optimized=0.190`

Artifact: `~/.eliza/optimized-prompts/action_planner/v1.json`. Optimizer's internal exact-match score on its held-out fold: baseline=0.000 → optimized=0.190 (+19.0pp).

Side-fix: `plugins/app-training/src/cli/train.ts` previously crashed at artifact-write time with `BuildMessage: ENOENT reading "packages/core/node_modules/drizzle-orm"` (bun resolved drizzle-orm to the workspace `.bun` store but `packages/core/node_modules/drizzle-orm` is not symlinked). Added a fallback path that writes the raw `OptimizedPromptArtifact` JSON to disk when `@elizaos/core` import fails. Honoured the parallel rename agent's contract — no env-var or source name was renamed.

## 4. Re-bench with the optimized planner

Loaded via a small env-var override added to `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/agents/hermes.py`:
`LIFEOPS_PLANNER_PROMPT_FILE=<artifact path>` swaps the in-process Hermes system prompt at agent-build time. No rename collisions.

Per-domain pre vs post-opt:

| domain    | pre pass@1 | post pass@1 | Δ        | pre cost  | post cost | pre lat (ms) | post lat (ms) |
|-----------|-----------:|------------:|---------:|----------:|----------:|-------------:|--------------:|
| calendar  | 0.500      | 0.000       | -0.500   | $0.0089   | $0.0034   | 8739         | 2668          |
| mail      | 0.667      | 0.000       | -0.667   | $0.0088   | $0.0024   | 8694         | 1336          |
| reminders | 0.000      | 0.000       |  0.000   | $0.0049   | $0.0024   | 4871         | 1912          |
| contacts  | 0.000      | 0.000       |  0.000   | $0.0037   | $0.0015   | 3687         |  949          |
| finance   | 0.000      | 0.000       |  0.000   | $0.0047   | $0.0016   | 3391         |  936          |
| travel    | 0.500      | 0.000       | -0.500   | $0.0028   | $0.0016   | 2005         |  983          |
| health    | 0.333      | 0.000       | -0.333   | $0.0063   | $0.0025   | 4462         | 1827          |
| sleep     | 0.000      | 0.000       |  0.000   | $0.0037   | $0.0014   | 2597         | 1134          |

**Overall:** pass@1 0.286 → **0.000** (Δ -0.286). Cost -61.7%. Latency -69.5%.

## 5. Interpretation

Negative result, but a real and useful one:

1. **The optimizer's internal score (+19pp) does not transfer.** DSPy-MIPRO scored the candidate on its own exact-match metric over the 21-row dataset, where the "expected" output was the bench's previously-recorded `agent_actions`. Out of 21 rows only ~6 had `reward=1.0`, so the candidate was rewarded for matching mostly-broken outputs.
2. **The candidate prompt regresses hermes hard.** Cost and latency both drop ~3x, suggesting the planner emits fewer/no tool calls — the few-shot demonstrations baked into the optimized prompt steer the model toward terse natural-language replies instead of structured tool dispatch.
3. **The hermes adapter system prompt is short by design** (single sentence). Replacing it with a multi-paragraph optimized prompt + JSON few-shots collides with the Hermes XML tool-call template that lives downstream in `hermes_adapter`. The optimizer optimized for the wrong boundary.

Practical next step (out of scope for g1): rebuild the dataset using actual planner trajectories from the elizaOS runtime (which records `request.system` + `request.messages` per call) rather than synthesizing from scenario instructions, then re-run dspy-mipro. The elizaOS eliza-bench-server path is currently failing on `@elizaos/plugin-workflow` (in-flight rename), so this is blocked on the parallel agent finishing.

## 6. Artifacts written

- `plugins/app-training/datasets/lifeops_action_planner_from_hermes-core-pre-20260511-201526.jsonl` — 21-row optimizer training set (tracked).
- `~/.eliza/optimized-prompts/action_planner/v1.json` — optimizer output (not in repo, lives in user state dir; included here as evidence path).
- `/tmp/lifeops-g1/runs/hermes-core-pre-20260511-201526/` — pre-opt raw bench JSONs.
- `/tmp/lifeops-g1/runs/hermes-post-20260511-202523/` — post-opt raw bench JSONs.
- `/tmp/lifeops-g1/*.log` — full run logs.

## 7. Source changes

- `plugins/app-training/src/cli/train.ts` — added fallback artifact writer when `@elizaos/core` import fails (handles `drizzle-orm` resolution edge case).
- `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/agents/hermes.py` — added `LIFEOPS_PLANNER_PROMPT_FILE` env-var override so operators can swap in an optimized planner prompt at bench time.

Both changes are additive; no env-var or source name was renamed (parallel rename agent's contract honored).

## 8. Open items

- `@elizaos-benchmarks/lib` is unresolved → `lifeops:aggregate` and `lifeops:delta` fail. Likely a workspace symlink that's been removed during the in-flight rename. Aggregation was done inline (this report).
- `lifeops:multi-tier:smoke` reports `[multi-tier] FAIL large/eliza` — the eliza in-process bench server depends on `@elizaos/plugin-workflow/dist/index.js` which is not built (`ERR_MODULE_NOT_FOUND`). Out of scope per the coordination note.
- The bundled `lifeops-benchmark-to-training-dataset.mjs` expects `runDir/trajectories/` + `benchmark-report*.json`, neither of which the hermes adapter produces. The custom converter under `/tmp/lifeops-g1/build-dataset.mjs` worked for this run but is throwaway; a permanent path would either (a) teach the bench to emit trajectory JSON in the existing format, or (b) port the converter into `scripts/` with hermes JSON support.
