# VoiceAgentBench — Agent Guide

Vendored from [Patil et al., arXiv:2510.07978](https://arxiv.org/abs/2510.07978).
5,757 voice queries across six suites measuring voice-in → tool-call-out accuracy:
single, parallel, sequential, multi-turn state threading, safety refusal, and multilingual.
Registered in the suite registry as `voiceagentbench`. Headline metric: `pass_at_1`.

## Run

```bash
# Direct, from this directory
python -m elizaos_voiceagentbench \
    --agent {eliza,hermes,openclaw} \
    --suite {single,parallel,sequential,multi-turn,safety,multilingual,all} \
    --limit 50 --seeds 1 --output ./results [--no-judge]

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks voiceagentbench --provider <p> --model <m>
```

## Smoke test (no API keys)

```bash
# Uses bundled fixtures/mock_tasks.jsonl + deterministic mock agent; no GROQ/CEREBRAS keys needed
python -m elizaos_voiceagentbench --mock --suite single --no-judge --output /tmp/vab-smoke
```

## Test the harness

```bash
pip install -e ".[test]"
PYTHONPATH=/home/shaw/milady/eliza/packages/benchmarks/voiceagentbench:/home/shaw/milady/eliza/packages/benchmarks/lifeops-bench \
  pytest packages/benchmarks/voiceagentbench/tests -v
```

## Layout

| Path | Role |
| --- | --- |
| `elizaos_voiceagentbench/cli.py` | CLI entrypoint (`main()`) |
| `elizaos_voiceagentbench/__main__.py` | Module entry (`python -m elizaos_voiceagentbench`) |
| `elizaos_voiceagentbench/runner.py` | Async task execution loop |
| `elizaos_voiceagentbench/evaluator.py` | Scoring axes + LLM coherence judge |
| `elizaos_voiceagentbench/scorer.py` | Report compilation (`pass_at_1`, `pass^k`) |
| `elizaos_voiceagentbench/dataset.py` | JSONL task loader and suite filter |
| `elizaos_voiceagentbench/stt.py` | STT backends (Groq Whisper, eliza1, faster-whisper) |
| `elizaos_voiceagentbench/adapters/` | Agent adapters: eliza, hermes, openclaw |
| `elizaos_voiceagentbench/types.py` | `MessageTurn`, `Suite`, `VoiceBenchmarkReport` |
| `fixtures/mock_tasks.jsonl` | Hermetic fixture dataset for smoke/CI |
| `fixtures/test_tasks.jsonl` | Task fixtures for pytest |
| `tests/` | pytest suite |

## Notes

- Results write to `./results/voiceagentbench_<agent>_<suite>_<timestamp>.json` (gitignored).
- Scored by `_score_from_voiceagentbench_json` in `registry/scores.py`.
- STT defaults: auto-detects eliza1 binary → `GROQ_API_KEY` → faster-whisper. Override with `--stt-provider`.
- Required env vars for real runs: `GROQ_API_KEY` (STT), `CEREBRAS_API_KEY` (coherence judge). Skip judge with `--no-judge`.
- `VOICEAGENTBENCH_STT_PROVIDER` overrides STT backend selection.
- Full background and scoring formula: [README.md](README.md).
