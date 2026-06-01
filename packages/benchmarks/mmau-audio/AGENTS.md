# MMAU Audio — Agent Guide

Audio MMAU (Sakshi et al., ICLR 2025): 10,000 audio clips across speech,
sound, and music domains, 27 reasoning skills, all multiple-choice. Scoring is
deterministic exact match — no LLM-judge required. Registered in the suite as
`mmau`.

## Run

```bash
# Direct, from this directory
python -m elizaos_mmau_audio --agent eliza --split test-mini --output ./results --json

# Subset by category
python -m elizaos_mmau_audio --agent eliza --split test-mini \
    --category speech --limit 100 --output ./results

# Through the suite orchestrator (resolves provider/model, stores results)
python -m benchmarks.orchestrator run --benchmarks mmau --provider eliza --model <m>
```

## Smoke test (no API keys)

```bash
python -m elizaos_mmau_audio --mock --limit 2
```

`--mock` uses the bundled `fixtures/smoke.jsonl` (8 samples, all categories)
and the oracle agent. Zero credentials required.

## Test the harness

```bash
pip install -e .[dev]
pytest tests/ -x
```

## Layout

| Path | Role |
| --- | --- |
| `elizaos_mmau_audio/cli.py` | argparse CLI; also `__main__.py` entry |
| `elizaos_mmau_audio/runner.py` | Load → dispatch → score → persist |
| `elizaos_mmau_audio/agent.py` | `OracleMMAUAgent`, `CascadedSTTAgent`, `AgentFn` type |
| `elizaos_mmau_audio/dataset.py` | Bundled fixture + Hugging Face streaming loader |
| `elizaos_mmau_audio/evaluator.py` | Deterministic MCQ scoring + per-skill aggregation |
| `elizaos_mmau_audio/types.py` | `MMAUSample`, `MMAUConfig`, `MMAUReport`, enums |
| `fixtures/smoke.jsonl` | 8-sample offline fixture (all 3 categories) |
| `tests/` | pytest suite (evaluator, dataset, runner) |

## Notes

- Results write to `benchmark_results/mmau/<timestamp>/` (gitignored).
  The orchestrator result file is `mmau-results.json`.
- Scored by `_score_from_mmau_json` in `registry/scores.py` (line 805).
- Real runs (`--agent eliza|hermes|openclaw`) stream audio from Hugging Face
  (`gamma-lab-umd/MMAU-test-mini` 1k or `gamma-lab-umd/MMAU-test` 9k) and
  use Groq Whisper as a cascaded STT step (needs `GROQ_API_KEY`). The `sound`
  and `music` categories are lossy under this pipeline; treat them as a floor.
- `AgentFn` in `agent.py` receives raw `audio_bytes`, so a future
  direct-audio adapter can bypass the STT step.
- Full background: [README.md](README.md).
