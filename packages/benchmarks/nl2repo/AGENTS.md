# NL2Repo-Bench — Agent Guide

Long-horizon, 0-to-1 repository generation benchmark (arXiv:2512.12730). An
agent receives a natural-language requirements document (`start.md`) and an
empty workspace, and must produce a fully installable, runnable Python library.
104 tasks scored by pytest pass-rate inside per-task Docker eval images. Not
registered in the suite orchestrator; run directly via `adapter_matrix.py`.

## Run

```bash
# From packages/benchmarks/nl2repo — requires Docker + NL2REPO_AGENT_COMMAND_TEMPLATE
pip install -r requirements.txt
python adapter_matrix.py \
  --task-agent elizaos \
  --model-provider cerebras \
  --model gpt-oss-120b \
  --output /tmp/nl2repo-out \
  --max-tasks 1

# Original OpenHands batch runner (requires openhands Docker images + config.json creds)
python main.py
```

## Smoke test (no Docker, no API keys)

```bash
python adapter_matrix.py \
  --task-agent elizaos \
  --model-provider cerebras \
  --model gpt-oss-120b \
  --output /tmp/nl2repo-mock \
  --max-tasks 5 \
  --mock
```

## Test the harness

```bash
pip install -r requirements.txt pytest
pytest packages/benchmarks/nl2repo/tests/test_adapter_matrix.py -v
```

## Layout

| Path | Role |
| --- | --- |
| `adapter_matrix.py` | Adapter-facing CLI and task/scoring harness (main entrypoint for elizaOS suite) |
| `main.py` | Original OpenHands batch runner (reference only) |
| `config.json` | Canonical 104-task list (`startPro[0].proNameList`) + concurrency settings |
| `test_files/<task>/` | Per-task fixtures: `start.md`, `test_commands.json`, `test_files.json`, `test_case_count.txt` |
| `test_files/task_difficulty.csv` | Easy/Medium/Hard labels for all 104 tasks |
| `openhands/post_processor.py` | Docker image build + pytest parse (scoring logic used by `adapter_matrix.py`) |
| `tests/test_adapter_matrix.py` | pytest suite for the adapter harness (no Docker needed) |
| `INTEGRATION.md` | Deep integration notes, dataset description, scoring formula, adapter wiring plan |

## Notes

- Results write to `--output <dir>/result.json` (not in git; gitignored by convention).
- Scoring: `score = passed / test_case_count` per task; aggregate = mean across all 104.
- Eval images: `ghcr.io/multimodal-art-projection/nl2repobench/<task>:1.0` (104 images, multi-GB; pulled lazily).
- Agent command is injected via `NL2REPO_AGENT_COMMAND_TEMPLATE` env var or `--agent-command-template`.
- `--no-docker` skips Docker post-processing (generation-only mode; scores are 0, not release-comparable).
- Dataset source and paper: [INTEGRATION.md](INTEGRATION.md). Upstream repo: [github.com/multimodal-art-projection/NL2RepoBench](https://github.com/multimodal-art-projection/NL2RepoBench).

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
