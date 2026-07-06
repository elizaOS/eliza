# Three-Agent Dialogue — Agent Guide

End-to-end benchmark that spawns three Eliza agents (Alice, Bob, Cleo), each
with a distinct Groq TTS voice, runs a scripted turn-taking scenario through a
shared AudioBus, and verifies diarization, emotion detection, ASR transcripts,
and non-blank audio output. Not registered in the suite orchestrator — run
directly.

## Run

```bash
# From this directory
bun run bench

# With explicit scenario and output path
bun run runner/run-dialogue.ts --scenario=canonical --output=/tmp/run-out

# From the repo root
bun run --cwd packages/benchmarks/three-agent-dialogue bench
```

Set `GROQ_API_KEY` for real TTS + ASR. Without it the harness falls back to
synthetic sine-wave audio automatically; all verification assertions still pass.

## Smoke test (no API key required)

```bash
# Via npm script (sets THREE_AGENT_SMOKE=1, runs first 4 turns only)
bun run bench:smoke

# Or manually
THREE_AGENT_SMOKE=1 bun run runner/run-dialogue.ts
# or
bun run runner/run-dialogue.ts --smoke
```

## Test the harness

```bash
# From this directory
bun run test

# Watch mode
bun run test:watch
```

The test suite in `__tests__/smoke.test.ts` covers AudioBus unit tests,
scenario/character file validation, and a synthetic-fallback integration run
(no API key needed). Integration tests against real Groq TTS + ASR are skipped
unless `GROQ_API_KEY` is set.

## Layout

| Path | Role |
| --- | --- |
| `runner/run-dialogue.ts` | CLI entrypoint and main execution loop |
| `runner/audio-bus.ts` | Shared AudioBus (publish, mix, flush to WAV) |
| `verify/verify-run.ts` | Post-run artefact verifier |
| `scenarios/canonical.json` | Scripted turn scenario (turns, smoke subset, thresholds) |
| `characters/alice.json` | Alice character + Groq TTS voice config |
| `characters/bob.json` | Bob character + Groq TTS voice config |
| `characters/cleo.json` | Cleo character + Groq TTS voice config |
| `__tests__/smoke.test.ts` | vitest suite (unit + integration smoke) |
| `vitest.config.ts` | vitest configuration |

## Notes

- Artifacts write to `artifacts/three-agent-dialogue/<run-id>/` at the repo
  root (gitignored). Each run produces: `turns/<idx>-<speaker>.wav`, `mix.wav`,
  `transcripts.json`, `emotion.json`, `turn-events.json`, `verification.json`.
- Not registered in `registry/commands.py` — no orchestrator invocation.
- Full background: [README.md](README.md).

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../../AGENTS.md)**. Read it.
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
