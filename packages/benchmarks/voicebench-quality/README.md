# elizaOS VoiceBench (quality)

Vendored implementation of VoiceBench (Chen et al. 2024) — a quality
benchmark for voice-input language assistants across 8 task suites
covering 6,783 spoken instructions.

* Upstream:  https://github.com/MatthewCYM/VoiceBench
* Paper:     https://arxiv.org/abs/2410.17196
* Dataset:   https://huggingface.co/datasets/hlt-mt/VoiceBench
* License:   Apache-2.0 (upstream + this port)

This package is the quality counterpart to the existing latency
benchmark at `packages/benchmarks/voicebench/`. The two are kept
separate on purpose: they measure orthogonal axes (latency in ms vs.
response quality in [0, 1]) and the latency benchmark is implemented in
TypeScript against the runtime, while the quality benchmark is Python
and treats the agent as an adapter under test.

## Suites

| Suite        | What it measures                              | Scoring         |
| ------------ | --------------------------------------------- | --------------- |
| `alpacaeval` | Open-ended instruction following              | LLM judge       |
| `commoneval` | Open-ended common-knowledge QA                | LLM judge       |
| `sd-qa`      | Spoken-dialect QA (10 English dialects)       | LLM judge       |
| `ifeval`     | Verifiable instruction following              | Deterministic   |
| `advbench`   | Safety / harmful-prompt refusal               | Deterministic   |
| `openbookqa` | Multiple-choice elementary science            | Deterministic   |
| `mmsu`       | MMLU-Pro spoken, 12 academic domains, MCQ     | Deterministic   |
| `bbh`        | Big Bench Hard, mixed reasoning               | LLM judge       |

The judged suites are scored by `gpt-oss-120b` on Cerebras — the same
model LifeOpsBench uses as a simulated user, reused via
`eliza_lifeops_bench.clients.cerebras` so retry / pricing / rate-limit
policy is one canonical implementation in the repo.

## Audio input

VoiceBench is a speech-in, text-out task. The Eliza, Hermes, and
OpenClaw text adapters currently in this repo don't speak audio. For
the cascaded baseline we transcribe each sample with Groq Whisper (the
same STT provider the latency benchmark uses), then hand the transcript
to the text adapter. A native voice-in model can plug in directly by
implementing `elizaos_voicebench.adapters.VoiceAdapter` without going
through STT.

## CLI

```bash
# Run against a live adapter.
python -m elizaos_voicebench \
    --agent eliza \
    --suite all \
    --limit 20 \
    --output ./results
```

Arguments:

* `--agent {eliza,hermes,openclaw}` — adapter under test.
* `--suite {all,alpacaeval,commoneval,sd-qa,ifeval,advbench,openbookqa,mmsu,bbh}`
* `--limit N` — cap samples per suite.
* `--stt-provider groq` — STT for cascaded voice→text input.
* `--judge-model` — Cerebras model for the LLM judge.
* `--output` — directory for the results JSON.

## Output

```
<output>/voicebench-quality-results.json
```

Schema (top-level fields):

```json
{
    "agent": "eliza",
    "suites_run": ["openbookqa", "mmsu", ...],
    "score": 0.62,
    "per_suite": {"openbookqa": 0.81, "mmsu": 0.55, ...},
    "n": 160,
    "elapsed_s": 412.3,
    "judge_model": "gpt-oss-120b",
    "stt_provider": "groq",
    "suite_details": [...]
}
```

`score` is the unweighted mean of `per_suite` (each suite contributes
equally regardless of sample count, matching upstream).

## Environment

* `CEREBRAS_API_KEY` — required for the LLM judge on judged suites.
* `GROQ_API_KEY` — required for cascaded STT (live adapters).
* `CEREBRAS_MODEL` — override the judge model (default `gpt-oss-120b`).
* `VOICEBENCH_STT_MODEL` — override the STT model (default
  `whisper-large-v3-turbo`).

## Tests

```bash
cd packages/benchmarks/voicebench-quality
python -m pytest tests/ -x
```

## Citation

```bibtex
@article{chen2024voicebench,
  title  = {VoiceBench: Benchmarking LLM-Based Voice Assistants},
  author = {Chen, Yiming and others},
  journal= {arXiv preprint arXiv:2410.17196},
  year   = {2024}
}
```
