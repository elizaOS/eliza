# Smithers Adapter — Agent Guide

Harness bridge that lets the benchmark orchestrator run benchmarks against the
**Smithers** agent (`smithers-orchestrator`, a Bun + JSX durable workflow engine).
API-compatible with `hermes-adapter` and `openclaw-adapter`; select it with
`--agent smithers`. Not registered as a standalone benchmark — it wraps other
benchmarks (BFCL, action-calling, etc.) run against the Smithers harness.

Each turn spawns a one-shot `bun` process running `smithers_turn.mjs` inside
the Smithers install directory. The script drives Smithers' `OpenAIAgent`
(ToolLoopAgent on the Vercel `ai` SDK) for one turn against an OpenAI-compatible
endpoint (Cerebras `gemma-4-31b` by default) and emits one JSON line.

## Install

Requires `bun` on PATH and `smithers-orchestrator` installed:

```bash
mkdir -p ~/.eliza/agents/smithers/0.22.0 && cd $_
bun add smithers-orchestrator@0.22.0 @ai-sdk/openai ai zod
```

Install the Python package (from `packages/benchmarks/`):

```bash
pip install -e smithers-adapter/
```

## Run

```bash
# Run BFCL against the Smithers harness (from packages/benchmarks/)
CEREBRAS_API_KEY=... python -m orchestrator.cli run \
  --model-profile cerebras-gemma-4-31b \
  --benchmarks bfcl \
  --agent smithers
```

Override the install directory with `SMITHERS_DIR` env if not using the default
`~/.eliza/agents/smithers/` location.

## Test the harness

```bash
pip install -e smithers-adapter/[dev]
pytest smithers-adapter/tests/ -v
```

Tests are offline (no API keys or real Smithers install required).

## Layout

| Path | Role |
| --- | --- |
| `smithers_adapter/client.py` | `SmithersClient` — one-shot turn via `bun` subprocess |
| `smithers_adapter/smithers_turn.mjs` | Bun script materialized next to `node_modules` |
| `smithers_adapter/server_manager.py` | `SmithersManager` — lifecycle (health check + script materialization) |
| `smithers_adapter/bfcl.py` | `SmithersBFCLAgent` — BFCL-runner-compatible wrapper |
| `smithers_adapter/agentbench.py` | AgentBench adapter |
| `smithers_adapter/tau_bench.py` | Tau-bench adapter |
| `smithers_adapter/swe_bench.py` | SWE-bench adapter |
| `smithers_adapter/terminal_bench.py` | Terminal-bench adapter |
| `smithers_adapter/context_bench.py` | Context-bench adapter |
| `smithers_adapter/clawbench.py` | ClawBench adapter |
| `smithers_adapter/woobench.py` | WooBench adapter |
| `tests/` | Offline pytest suite |

## Notes

- Not a registered benchmark — used as `--agent smithers` alongside any
  compatible benchmark in the orchestrator.
- Install resolution: `SMITHERS_DIR` env → `~/.eliza/agents/smithers/manifest.json`
  → newest versioned subdir → `~/.eliza/agents/smithers/0.22.0`.
- The harness script (`smithers_turn.mjs`) is copied from the Python package into
  the Smithers install dir at runtime so Bun can resolve bare imports from
  `node_modules`.
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
