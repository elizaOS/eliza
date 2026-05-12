# MMAU — Massive Multi-task Audio Understanding

Vendored Python implementation of MMAU (ICLR 2025) for the elizaOS
benchmark suite.

- Source: https://mmaubench.github.io/
- Paper:  https://arxiv.org/abs/2410.19168
- Upstream code: https://github.com/Sakshi113/MMAU (Apache-2.0)
- Dataset on HF:
  - `gamma-lab-umd/MMAU-test-mini` (1,000 samples)
  - `gamma-lab-umd/MMAU-test` (9,000 samples)

## What MMAU Measures

10,000 audio clips across three domains, 27 reasoning skills (12
information retrieval, 15 reasoning), expert-level multiple choice.

| Category | What it covers |
| --- | --- |
| `speech` | Spoken utterances: speaker identification, emotion, language ID, dialogue reasoning, paralinguistic cues. |
| `sound`  | Environmental / non-speech audio: source inference, temporal event ordering, scene reasoning. |
| `music`  | Musical clips: instrument ID, tempo, key, genre, music-theory knowledge. |

Every sample is pure MCQ. Scoring is exact match on the parsed answer
letter — **no LLM-judge is ever required**.

## Layout

```
packages/benchmarks/
  elizaos_mmau/        Distribution-name shim so `python -m elizaos_mmau` works
    __init__.py
    __main__.py
  mmau/
    __init__.py
    __main__.py
    cli.py             argparse CLI (`python -m benchmarks.mmau`)
    types.py           MMAUSample / MMAUPrediction / MMAUResult / MMAUReport / MMAUConfig
    dataset.py         JSONL fixture + Hugging Face streaming loader
    evaluator.py       Deterministic MCQ scoring + per-skill aggregation
    agent.py           OracleMMAUAgent, CascadedSTTAgent, AgentFn / SttFn types
    runner.py          load -> dispatch -> score -> report -> persist
    fixtures/
      smoke.jsonl      8-sample bundled fixture (covers all 3 categories)
    tests/             pytest suite — exercises evaluator, dataset, runner, CLI
```

## Run

Two equivalent invocations work — pick whichever fits the calling
context. Run from the `packages/` root or with that on `PYTHONPATH`:

```bash
# canonical module path (preferred from scripts / the registry)
python -m benchmarks.mmau --mock --limit 2

# distribution-name shim (matches the README + task spec)
python -m elizaos_mmau --mock --limit 2
python -m elizaos_mmau --mock --output ./results --json
```

Run through the elizaOS bridge (cascaded STT -> text agent baseline):

```bash
python -m elizaos_mmau --agent eliza --split test-mini --limit 100 \
    --output ./results
python -m elizaos_mmau --agent hermes --split test --category speech \
    --output ./results
python -m elizaos_mmau --agent openclaw --split test --category sound,music
```

The CLI accepts `--category {speech,sound,music,all}` (or a
comma-separated subset) and `--split {test-mini,test}`. Pass `--hf` to
stream from Hugging Face instead of the bundled fixture; the audio bytes
are pulled along with each record, so the dataset cache eats real disk
space for full runs.

## Cascaded STT baseline (and its limitation)

The default `eliza` / `hermes` / `openclaw` adapters run a cascaded
pipeline: Groq Whisper (`whisper-large-v3-turbo`) transcribes the clip,
then the text agent reasons over the transcript plus the MCQ choices.

This baseline is **lossy** on the `sound` and `music` categories — the
STT throws away non-speech semantic information. Treat cascaded numbers
on those two categories as a floor, not a ceiling. A future
direct-audio-input adapter (Gemini-style audio-in, native audio models,
etc.) should supersede this baseline; the `AgentFn` callable in
`agent.py` already accepts the raw `audio_bytes` so a richer adapter can
ignore the transcript and consume the audio directly.

## Environment

| Variable | Purpose |
| --- | --- |
| `GROQ_API_KEY` | Whisper STT (cascaded baseline only). |
| `HF_TOKEN` | Optional — needed only if the upstream dataset becomes gated. |

The mock / oracle run path needs no credentials.

## Verification

```bash
cd packages/benchmarks/mmau
python -m pytest tests/ -x
python -m elizaos_mmau --mock --limit 2
```

Both must pass before publishing run results.

## Registry entry

`mmau` is registered in `packages/benchmarks/registry.py` with a
deterministic score extractor that reports overall accuracy plus
per-category breakdown. No LLM-judge dispatch is wired up — MCQ scoring
is enough.

## License & citation

- Code (this package): Apache-2.0, matching the upstream MMAU repo.
- Project site (mmaubench.github.io): CC-BY-SA-4.0.
- Dataset itself: per the upstream HF dataset card — verify before
  publishing benchmark scores, as the upstream maintainers may change
  terms.

```bibtex
@inproceedings{sakshi2025mmau,
  title     = {MMAU: A Massive Multi-Task Audio Understanding and Reasoning Benchmark},
  author    = {Sakshi, S. and others},
  booktitle = {International Conference on Learning Representations (ICLR)},
  year      = {2025},
  url       = {https://arxiv.org/abs/2410.19168}
}
```
