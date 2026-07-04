# eliza-adapter — Agent Guide

Python bridge that connects benchmark runners (Python) to the elizaOS agent
runtime (TypeScript) over HTTP. Not a standalone benchmark — imported as a
library by every benchmark that needs to talk to the eliza benchmark server.
Not registered in the orchestrator registry; consumers depend on it directly.

## Install (one-time)

```bash
pip install -e packages/benchmarks/eliza-adapter/
```

Or from within this directory:

```bash
pip install -e .
```

## Use as a library

```python
from eliza_adapter import ElizaServerManager

mgr = ElizaServerManager()
mgr.start()          # spawns node --import tsx packages/lifeops-bench/src/server.ts
client = mgr.client  # ready-to-use ElizaClient (HTTP to localhost:3939)

resp = client.send_message("hello", context={"benchmark": "agentbench", "task_id": "1"})
print(resp.text, resp.params)

mgr.stop()
```

Or point `ElizaClient` at an already-running server:

```bash
# Start the TypeScript server manually (in the repo root)
node --import tsx packages/lifeops-bench/src/server.ts
```

```python
from eliza_adapter import ElizaClient
client = ElizaClient("http://localhost:3939")
client.wait_until_ready()
```

## Smoke / mock mode

`run_osworld_mock.py` drives a single-turn OSWorld-style mock session using a
real server subprocess (requires Node.js and compiled TS dependencies):

```bash
python run_osworld_mock.py
```

To suppress API calls server-side, set `ELIZA_BENCH_MOCK=true` before starting
`ElizaServerManager` — the manager will blank all provider API keys in the
subprocess environment.

## Test the harness

```bash
pip install -e .
pytest packages/benchmarks/eliza-adapter/tests/ -v
```

Tests are pure-Python (no Node.js, no live server) — they monkeypatch HTTP and
subprocess calls.

## Layout

| Path | Role |
| --- | --- |
| `eliza_adapter/client.py` | `ElizaClient` — HTTP client for `/api/benchmark/*` endpoints; telemetry writer |
| `eliza_adapter/server_manager.py` | `ElizaServerManager` — spawns and manages the Node.js benchmark server subprocess |
| `eliza_adapter/agentbench.py` | AgentBench harness adapter |
| `eliza_adapter/context_bench.py` | context-bench LLM query adapter |
| `eliza_adapter/mind2web.py` | Mind2Web agent adapter |
| `eliza_adapter/tau_bench.py` | tau-bench agent adapter |
| `eliza_adapter/replay_eval.py` | Offline scorer for normalized Eliza replay artifacts |
| `eliza_adapter/vllm_provider.py` | vLLM provider bridge |
| `eliza_adapter/*.py` | One module per benchmark; loaded lazily or on-demand |
| `fixtures/replay/smoke.replay.json` | Fixture used by replay_eval tests |
| `run_osworld_mock.py` | Single-turn OSWorld mock smoke driver |
| `tests/` | pytest suite (pure-Python, no live server) |
| `conftest.py` | Adds `packages/` to `sys.path` so `import benchmarks.*` resolves the top-level namespace package |

## Notes

- The TypeScript server lives at `packages/lifeops-bench/src/server.ts`.
  `ElizaServerManager` auto-locates it by walking up from `__file__`.
- Default port is `3939`; override with `ELIZA_BENCH_PORT`.
- `BENCHMARK_HARNESS` / `ELIZA_BENCH_HARNESS` routes `ElizaClient` through
  Hermes, Smithers, or OpenClaw backends instead of the eliza HTTP server.
- Per-turn telemetry writes to `BENCHMARK_TELEMETRY_JSONL` or
  `$BENCHMARK_RUN_DIR/telemetry.jsonl` (auto-fallback to a tmp dir).
- This package is not registered in `registry/commands.py`; no orchestrator
  `run_command` applies — see consumers in `agentbench/`, `context-bench/`,
  `mind2web/`, and `tau-bench/`.
- Full architecture: [README.md](README.md).

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

Artifacts → `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — benchmark / eval suite:**
- A **real-model** run (not the mock/smoke fixture) producing the score-report JSON, with the numbers inspected and the provider/model recorded.
- The per-item trajectories the harness captured, spot-reviewed for correctness — a green harness run over mock fixtures is not a result.
- The provider matrix actually exercised, and the scoring math validated against a known case.
- Failure / timeout / partial-output handling in the harness itself.
<!-- END: evidence-and-e2e-mandate -->
