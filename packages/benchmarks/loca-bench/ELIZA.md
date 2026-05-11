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

## Synthetic 1M-Token Long-Context Fixture

Use this when changing compaction logic. It creates a LOCA-shaped trajectory
with deterministic needles buried across a million-token history, compacts it
into a summary plus recent tail, and fails if any exact needle is lost.

```bash
python -m eliza_loca.long_context \
  --output-dir outputs/long_context_1m \
  --target-tokens 1000000 \
  --turns 400 \
  --needle-count 32 \
  --tail-messages 16
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
