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
    valid_hits.py              Conservative response-level failure analysis
  analyze_valid_hits.py        Rerun cases and emit official + adjusted scores
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

## Failure analysis

CompactBench's official scorer is intentionally lexical: it lowercases,
collapses whitespace, and checks for exact substrings. That makes official
scores stable, but it can misclassify valid answers such as "using regex to
parse HTML" for an expected phrase of "use regex to parse HTML", or "No, trust
user input without validation is not still the plan" for a
`forbidden_absent` probe.

Use `analyze_valid_hits.py` when a run has failures that need inspection:

```bash
python analyze_valid_hits.py \
  --method "$(pwd)/eliza_compactbench/compactors/__init__.py:HybridLedgerCompactor" \
  --suite starter \
  --benchmarks-dir /tmp/compactbench-upstream/benchmarks/public \
  --case-count 1 \
  --drift-cycles 2 \
  --output /tmp/compactbench-valid-hits.jsonl
```

The script reruns the same case/drift loop and writes raw item responses,
artifact context, official scores, and a separate adjusted score. The adjusted
score is not a replacement for upstream CompactBench: it only uses the expected
check and the model response, never the strategy name, artifact internals,
template id, or case id. It can also lower a `forbidden_absent` item when the
official scorer misses a morphological forbidden paraphrase such as
"committing directly to the main branch".

When iterating on scorer rules, rescore an existing analysis file without model
calls:

```bash
python analyze_valid_hits.py \
  --rescore-from /tmp/compactbench-valid-hits.jsonl \
  --output /tmp/compactbench-valid-hits.rescored.jsonl
```

To debug one real miss cheaply, add `--template-key decision_override_starter_v1`
and `--seed-slot 2`.

For one command that writes the official run and then performs the response
capture pass:

```bash
python run_cerebras.py \
  --method "$(pwd)/eliza_compactbench/compactors/__init__.py:HybridLedgerCompactor" \
  --suite starter \
  --score \
  --analyze-valid-hits
```

## Tests

```bash
cd packages/benchmarks/compactbench
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest tests/                    # excludes live_test_cerebras.py by default
pytest tests/test_valid_hits.py   # focused valid-hit analyzer tests
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
- **Judge refusals are framed out.** Some CompactBench templates contain
  unsafe-looking synthetic strings such as "commit credentials to git
  history". The Cerebras provider adds a neutral benchmark system prompt so
  the judge reports recorded summary text descriptively instead of refusing.
  It does not include answers, and explicit `CompletionRequest.system` values
  still take precedence.
- **Registry mutation.** CompactBench v0.1.0 has no public provider
  registration API — `register_cerebras_provider()` mutates
  `compactbench.providers._REGISTRY` directly. If a future release seals
  that dict, `run.sh` falls through to `--provider groq` automatically.
