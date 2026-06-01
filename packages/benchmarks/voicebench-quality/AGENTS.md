# VoiceBench (quality) — Agent Guide

Vendored implementation of VoiceBench (Chen et al. 2024): 8 task suites covering
6,783 spoken instructions, measuring response quality (score in [0, 1]) for
voice-input language assistants. Registered in the suite registry as `voicebench_quality`.

Separate from `packages/benchmarks/voicebench/` (that one is TypeScript and measures
latency in ms; this one is Python and measures response quality).

## Run

```bash
# Direct, from this directory
python -m elizaos_voicebench \
    --agent eliza \
    --suite all \
    --output ./results

# Through the suite orchestrator
python -m benchmarks.orchestrator run --benchmarks voicebench_quality --provider <p> --model <m>
```

Agent choices: `eliza`, `hermes`, `openclaw`. STT provider is auto-detected
(prefers local eliza1 binary > `GROQ_API_KEY` > `faster-whisper`); override with
`--stt-provider {groq,eliza-runtime,eliza1,faster-whisper,local-whisper}`.

## Smoke test (no API keys)

```bash
# --mock uses bundled fixtures with a deterministic no-cost adapter and judge
python -m elizaos_voicebench --mock --suite openbookqa --limit 5 --output /tmp/vbq-smoke
```

Note: mock results are rejected by the real scorer (`_score_from_voicebench_quality_json`).

## Test the harness

```bash
pip install -e ".[test]"
pytest tests/ -x
```

## Layout

| Path | Role |
| --- | --- |
| `elizaos_voicebench/__main__.py` | CLI entry point (`python -m elizaos_voicebench`) |
| `elizaos_voicebench/runner.py` | Execution loop — resolves suites, drives adapter + judge |
| `elizaos_voicebench/adapters.py` | `VoiceAdapter` base + eliza/hermes/openclaw/echo impls |
| `elizaos_voicebench/clients/` | Groq STT, eliza-1 ASR, Cerebras LLM judge, say TTS |
| `elizaos_voicebench/fixtures/` | Bundled JSONL task fixtures (8 suites) used in mock mode |
| `elizaos_voicebench/types.py` | `SUITES` tuple and shared type definitions |
| `tests/` | pytest suite |
| `pyproject.toml` | Package metadata; `elizaos-voicebench` console script |

## Notes

- Results write to `<output>/voicebench-quality-results.json`. Registry expects it at
  `<output_dir>/voicebench-quality-results.json` (`_voicebench_quality_result`).
- Scored by `_score_from_voicebench_quality_json` in `registry/scores.py` (line 755).
  Score is the unweighted mean of the 8 per-suite scores.
- Required env vars for live runs: `CEREBRAS_API_KEY` (LLM judge), `GROQ_API_KEY` or
  `VOICEBENCH_QUALITY_STT_PROVIDER` (STT).
- Judged suites (`alpacaeval`, `commoneval`, `sd-qa`, `bbh`) use `gpt-oss-120b` on
  Cerebras; deterministic suites (`ifeval`, `advbench`, `openbookqa`, `mmsu`) need no judge key.
- Full background: [README.md](README.md).
