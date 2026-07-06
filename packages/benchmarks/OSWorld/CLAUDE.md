# OSWorld — Agent Guide

Multimodal desktop agent benchmark: 369 real computer tasks spanning Chrome,
LibreOffice, GIMP, VS Code, and more — arXiv:2404.07972. Vendored from
[xlang-ai/OSWorld](https://github.com/xlang-ai/OSWorld) with an elizaOS
TypeScript bridge agent layered on top. Registered in the suite registry as
`osworld`.

## Run

```bash
# Direct — single task via Docker provider (from this directory)
python scripts/python/run_multienv_eliza.py \
    --provider_name docker \
    --observation_type screenshot_a11y_tree \
    --model gemma-4-31b \
    --max_steps 15 \
    --result_dir ./results/eliza \
    --task_id 030eeff7-b492-4218-b312-701ec99ee0cc

# Direct — all tasks, 5 parallel VMs
python scripts/python/run_multienv_eliza.py \
    --provider_name docker \
    --observation_type screenshot_a11y_tree \
    --model gemma-4-31b \
    --max_steps 15 \
    --num_envs 5 \
    --result_dir ./results/eliza

# VMware on macOS
python scripts/python/run_multienv_eliza.py \
    --provider_name vmware \
    --path_to_vm ~/Virtual\ Machines.localized/Ubuntu.vmwarevm/Ubuntu.vmx \
    --observation_type screenshot_a11y_tree \
    --model gemma-4-31b \
    --max_steps 15 \
    --result_dir ./results/eliza

# Through the suite orchestrator
python -m benchmarks.orchestrator run --benchmarks osworld --provider <p> --model <m>
```

## Smoke test (no VM required)

```bash
# Runs one synthetic in-process task; does not start VMs or the Eliza server
python scripts/python/run_multienv_eliza.py \
    --provider_name docker \
    --observation_type screenshot_a11y_tree \
    --model gemma-4-31b \
    --max_steps 1 \
    --dry_run \
    --result_dir /tmp/osworld-smoke

# Via orchestrator (passes extra.dry_run=true)
python -m benchmarks.orchestrator run --benchmarks osworld --provider mock --model mock \
    --extra '{"dry_run": true}'
```

## Test the harness

```bash
# From the OSWorld directory
pip install -e .
pytest tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `scripts/python/run_multienv_eliza.py` | Primary entrypoint (elizaOS bridge agent, multi-env) |
| `run.py` | Legacy single-env runner (almost deprecated) |
| `desktop_env/` | VM provider abstractions (Docker, VMware, VirtualBox, AWS, Azure, GCP) |
| `desktop_env/evaluators/` | Per-app task evaluators (Chrome, GIMP, LibreOffice, VLC, VS Code, etc.) |
| `mm_agents/` | Reference agent implementations (upstream; not used by elizaOS path) |
| `evaluation_examples/` | 369 task config JSON files, organised by domain |
| `tests/test_run_multienv_eliza.py` | pytest suite for the elizaOS bridge harness |
| `lib_run_single.py` | Per-task execution loop (shared by all runners) |
| `lib_results_logger.py` | Structured result/error logging helpers |
| `pyproject.toml` | Package metadata and dependencies |

## Notes

- Requires a VM provider: Docker (with KVM), VMware, or VirtualBox. No API
  keys are needed for the benchmark itself, but the agent model needs an LLM key.
- The elizaOS bridge routes all decisions through the TypeScript benchmark
  server (`packages/lifeops-bench/src/server.ts`). Set `ELIZA_BENCH_URL`
  to skip auto-starting it and point at an already-running instance.
- Results write to `./results/eliza/` by default (gitignored). The orchestrator
  writes to its own `output_dir` and locates `osworld-eliza-results-*.json`.
- Scored by `_score_from_osworld_json` in `registry/scores.py`.
- Observation types: `screenshot`, `a11y_tree`, `screenshot_a11y_tree` (default), `som`.
- Full setup (VM provisioning, GCP auth, proxy): [SETUP_GUIDELINE.md](SETUP_GUIDELINE.md).
- Upstream paper and data: [README.md](README.md).

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
