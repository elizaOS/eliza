# eliza-compactbench

CompactBench harness for elizaOS conversation compactors.

[CompactBench](https://github.com/compactbench/compactbench) v0.1.0 measures
the *compaction layer* of an LLM agent — not the model. It feeds an
adversarial multi-turn transcript into your compactor, replaces the history
with whatever the compactor returned, then probes the resulting context with
scoring questions about facts, locked decisions, deferred items, forbidden
behaviors, and entity integrity. Drift is measured across repeated
compact → continue → compact cycles.

This package wires the four conversation-compactor strategies in
`packages/agent/src/runtime/conversation-compactor.ts` plus our existing
regex-based prompt-stripping baseline into CompactBench, and uses Cerebras
`gpt-oss-120b` (OpenAI-compatible API) as the question-answering judge.

## Why this benchmark matters

It directly targets the OpenClaw-style failure mode tracked in elizaOS issue
**#7477** — when a compactor splits a `tool_call` from its matching
`tool_result`, or drops a locked decision the user issued ten turns ago,
downstream turns hallucinate or repeat themselves. CompactBench's
`elite_practice` suite has templates (`buried_constraint`,
`decision_override`, `entity_confusion`) tuned for exactly that class of
regression.

## Layout

```
packages/benchmarks/compactbench/
  pyproject.toml
  run.sh
  eliza_compactbench/
    __init__.py
    bridge.py                  Python -> bun subprocess bridge
    ts_bridge.ts               TS shim that dispatches to TS strategies
    compactors/__init__.py     Five `compactbench.Compactor` subclasses
    cerebras_provider.py       OpenAI-compatible provider wired at Cerebras
  tests/
    test_bridge.py
    test_compactors.py
    live_test_cerebras.py      Skipped without COMPACTBENCH_LIVE=1
```

## Compactor strategies

| Class                                | Strategy id                     | Expected score                                   |
| ------------------------------------ | ------------------------------- | ------------------------------------------------ |
| `PromptStrippingPassthroughCompactor`| `prompt-stripping-passthrough`  | Near-zero — baseline; no semantic compaction      |
| `NaiveSummaryCompactor`              | `naive-summary`                 | > 0; loses structured facts on drift              |
| `StructuredStateCompactor`           | `structured-state`              | Higher; emits the six-section schema directly     |
| `HierarchicalSummaryCompactor`       | `hierarchical-summary`          | Better than naive on long transcripts             |
| `HybridLedgerCompactor`              | `hybrid-ledger`                 | Highest expected; accumulates across drift cycles |

## Running

```bash
cd packages/benchmarks/compactbench
export CEREBRAS_API_KEY=...      # required
./run.sh
```

`run.sh` creates `.venv`, runs `pip install -e ".[dev]"`, attempts to
register a `cerebras` provider in CompactBench's registry, and falls back
to `--provider groq` (with `COMPACTBENCH_GROQ_API_KEY`) if registration
isn't possible.

To target a different compactor, set `COMPACT_METHOD` (just the class name —
the file path is filled in by the script):

```bash
COMPACT_METHOD=HybridLedgerCompactor ./run.sh
COMPACT_METHOD=PromptStrippingPassthroughCompactor ./run.sh
```

`run.sh` clones the upstream CompactBench repo into
`./external/compactbench-suites` on first run because the public suite YAMLs
ship in the git repo, not on PyPI. Override the location with
`COMPACTBENCH_BENCHMARKS_DIR=/path/to/benchmarks/public`.

## Tests

```bash
cd packages/benchmarks/compactbench
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest tests/                    # excludes live_test_cerebras.py by default
COMPACTBENCH_LIVE=1 pytest tests/live_test_cerebras.py
```

## Implementation notes

- **bun is required** — the bridge spawns `bun run ts_bridge.ts <strategy>`
  and pipes a single JSON payload through stdin/stdout. If `bun` is not on
  `PATH` the bridge raises a `BridgeError` with a clear message.
- **TS module loaded lazily.** If
  `packages/agent/src/runtime/conversation-compactor.ts` does not yet
  export the requested strategy (because another agent is still
  implementing it), the shim writes `{"error": "..."}` to stdout, exits 1,
  and the Python bridge surfaces the underlying error chain to the caller.
- **Cerebras is an OpenAI-compatible endpoint.** Both the TS side
  (summarization model used by the strategies) and the Python side (the
  CompactBench judge) hit `https://api.cerebras.ai/v1/chat/completions`
  with `gpt-oss-120b`.
- **Registry mutation.** CompactBench v0.1.0 has no public provider
  registration API — `register_cerebras_provider()` mutates
  `compactbench.providers._REGISTRY` directly. If a future release seals
  that dict, `run.sh` falls through to `--provider groq` automatically.
