# Voice Speaker Validation — Agent Guide

W3-6 multi-speaker audio validation benchmark: diarization accuracy, speaker ID
cosine thresholds, entity creation (Jill scenario), owner LRU cache latency, and
async profile search. The #12494 lifecycle gate additionally covers enrollment,
naming/correction provenance, merge/split/delete/revoke/export/bind-unbind,
short utterance bins, spoof/replay, similar-voice confusion, and metrics math
with deterministic synthetic embeddings. Not registered in the suite
orchestrator — run directly via pytest.

## Run

```bash
# From this directory — runs the full test suite
pip install -e .
python fixture_generator.py
pytest tests/ -v
```

## Test the harness

```bash
pip install -e .
python fixture_generator.py
pytest tests/ -v
```

Individual test modules:

```bash
pytest tests/test_diarization.py -v         # DER and speaker-count assertions
pytest tests/test_single_stream_gate.py -v  # #12493 artifact gate, no WAV fixtures
pytest tests/test_speaker_id.py -v          # intra/inter cosine thresholds
pytest tests/test_entity_creation.py -v    # Jill scenario end-to-end
pytest tests/test_owner_lru_cache.py -v    # hot-profile latency < 50 ms
pytest tests/test_async_search.py -v       # async profile search
pytest tests/test_voice_profile_lifecycle.py -v # #12494 no-audio lifecycle gate
python voice_profile_lifecycle.py          # write artifacts/voice-profile-lifecycle.json
```

## Layout

| Path | Role |
| --- | --- |
| `tests/conftest.py` | SpeechBrain ECAPA-TDNN encoder, energy-VAD diarizer, InMemoryVoiceProfileStore fixtures |
| `tests/test_diarization.py` | DER ≤ 0.45 and speaker-count correctness across all 5 fixtures |
| `tests/test_single_stream_gate.py` | Single-platform-participant room-mic gate for 2/3/5/8 speaker artifacts; no WAV fixtures required |
| `tests/test_speaker_id.py` | Intra-cluster cosine ≥ 0.40, inter-cluster ≤ 0.46 (ECAPA-TDNN on TTS) |
| `tests/test_entity_creation.py` | Full Jill scenario: 2 entities, partner_of edge, no duplicates |
| `tests/test_owner_lru_cache.py` | Owner hot-profile lookup latency < 50 ms |
| `tests/test_async_search.py` | Async profile search correctness |
| `tests/test_voice_profile_lifecycle.py` | #12494 lifecycle and metrics gate without audio fixtures |
| `tests/test_diarization_production.py` | Production-stack diarization tests (needs live stack) |
| `tests/production_stack.py` | Production stack helpers |
| `voice_profile_lifecycle.py` | Deterministic lifecycle report writer |
| `fixtures/manifest.json` | Ground-truth segment boundaries for 5 audio fixtures (f1–f5) |
| `pyproject.toml` | Package definition and pytest config |

## Notes

- Fixtures (f1–f5 WAV files) are **not committed** — they must be generated or
  provided before running. Use `python fixture_generator.py` or let the pytest
  manifest fixture create missing WAVs automatically. The manifest defines
  expected paths and ground-truth boundaries.
- `tests/test_single_stream_gate.py` is an artifact-level smoke/gate for #12493
  and does not require WAV fixtures or model downloads.
- The diarizer in tests uses energy-VAD + ECAPA-TDNN clustering (no Hugging Face
  token required). Production uses pyannote; thresholds differ.
- Artifacts are written to `artifacts/<W3_6_RUN_ID>/` (set env var to name the
  run; defaults to `run-<epoch>`). This directory is gitignored.
- Not registered in `registry/commands.py` — no orchestrator invocation.
- Full background: [README.md](README.md).

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — benchmark / eval suite:**
- A **real-model** run (not the mock/smoke fixture) producing the score-report JSON, with the numbers inspected and the provider/model recorded.
- The per-item trajectories the harness captured, spot-reviewed for correctness — a green harness run over mock fixtures is not a result.
- The provider matrix actually exercised, and the scoring math validated against a known case.
- Failure / timeout / partial-output handling in the harness itself.
<!-- END: evidence-and-e2e-mandate -->
