# elizaOS LOCA Harness

This directory vendors [LOCA-bench](https://github.com/hkust-nlp/LOCA-bench)
and adds a small elizaOS/Cerebras wrapper under `eliza_loca/`.

## Setup

```bash
cd packages/benchmarks/loca-bench
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
export CEREBRAS_API_KEY=...
```

## Debug Run

```bash
python -m eliza_loca.run_cerebras \
  --config task-configs/debug.json \
  --strategy react \
  --model gpt-oss-120b \
  --max-workers 1 \
  --max-tool-uses 25 \
  --max-tokens 4096 \
  --max-context-size 131072 \
  --context-awareness \
  --context-summary \
  --output-dir outputs/eliza_debug_gptoss120b
```

The wrapper writes normal LOCA artifacts plus `eliza_loca_audit.json`:

- `results.json`
- `all_trajectories.json`
- `tasks/<TaskName>/stateN/trajectory.json`
- `tasks/<TaskName>/stateN/eval.json`
- `tasks/<TaskName>/stateN/token_stats.json`

## Trajectory Audit

```bash
python -m eliza_loca.trajectory_audit \
  --output-dir outputs/eliza_debug_gptoss120b \
  --include-previews \
  --write outputs/eliza_debug_gptoss120b/eliza_loca_audit.json
```

The audit fails non-zero if trajectories are missing, aggregate counts do not
match per-task files, token usage is missing, or tool call/result pairs are
unbalanced.

The audit also writes capped `review_records` for manual inspection. Each record
contains the last model input/output previews, expected answer or long-context
target summary, scoring reason, compaction event counts, and token usage.

## OpenClaw Harness Status

`BENCHMARK_HARNESS=openclaw` now fails closed by default. The documented
OpenClaw CLI accepts a single `--message` turn, so it cannot preserve LOCA's
full OpenAI `messages` plus `tools` payload and should not be scored as native
agent parity. For a clearly labeled provider-level smoke path only, set
`LOCA_OPENCLAW_MODE=direct-openai-compatible`; that path preserves messages and
tools through the OpenAI-compatible request body but is not an OpenClaw CLI
compaction/runtime comparison.

## Synthetic Long-Context Fixture

Use this when changing compaction logic. It creates a LOCA-shaped trajectory
with deterministic needles buried across a long history, realistic distractors,
conflicting updates, rescinded decisions, and tool-like observations. It then
compacts the trajectory into a summary plus recent tail and fails if any
audited exact value is lost.

The `perfect` summary mode is a fixture sanity check: it writes every audited
value into the synthetic summary so the audit can prove the generated fixture is
well-formed. It is not a real summarizer benchmark. Use `lossy` or `corrupt`
mode when you need a deterministic negative case that proves the audit catches
dropped or mutated facts.

```bash
python -m eliza_loca.long_context \
  --output-dir outputs/long_context_1m \
  --tier 1m \
  --turns 400 \
  --needle-count 32 \
  --tail-messages 16 \
  --summary-mode perfect
```

Supported tiers are `128k`, `256k`, `512k`, and `1m`. You can override the
preset with `--target-tokens` for an exact synthetic size. The audit also
enforces compacted-current-context thresholds with `--max-current-token-ratio`
and `--max-current-tokens`; defaults are tuned so the tiered perfect fixtures
pass while unreasonably large current tails fail.

Examples:

```bash
python -m eliza_loca.long_context \
  --output-dir outputs/long_context_128k \
  --tier 128k \
  --turns 400 \
  --needle-count 16

python -m eliza_loca.long_context \
  --output-dir outputs/long_context_lossy \
  --tier 256k \
  --summary-mode lossy
```

Artifacts:

- `outputs/long_context_1m/tasks/LongContextNeedles/state0/trajectory.json`
- `outputs/long_context_1m/long_context_audit.json`
- standard LOCA `results.json`, `all_trajectories.json`, `eval.json`, and
  `token_stats.json`

## Context Strategy Comparisons

Run the same config with different LOCA strategies and context controls:

```bash
python -m eliza_loca.run_cerebras --strategy react --output-dir outputs/react
python -m eliza_loca.run_cerebras --strategy memory_tool --output-dir outputs/memory_tool
python -m eliza_loca.run_cerebras --strategy ptc --output-dir outputs/ptc
python -m eliza_loca.run_cerebras --context-reset --output-dir outputs/context_reset
python -m eliza_loca.run_cerebras --context-summary --output-dir outputs/context_summary
```

Compare `avg_accuracy`, `avg_api_tokens`, context event counts, and max prompt
tokens in each run's `eliza_loca_audit.json`.

## Strategy Notes

The debug Canvas task is sensitive to compaction quality:

- Low reasoning effort tends to stop early or under-use Canvas tools.
- Pure summary compaction can corrupt exact CSV field values, infer that
  unqueried sources are absent, or preserve placeholder rows as if they were
  final data.
- Summary generation failures must be non-destructive. The runner records
  `summary_generation_failed` in `summary_skip` and keeps the existing context.
- Summary+tail is the current default lesson: summarize old context, preserve a
  bounded recent raw tail, and never split tool-call/tool-result pairs. This
  keeps exact source records available while still shrinking long histories.
- Static tool schemas can dominate token use. When fixed tool/schema overhead is
  the reason a request exceeds `reset_size`, summarization is deferred until the
  hard context edge because summarizing conversation text cannot shrink schemas.
