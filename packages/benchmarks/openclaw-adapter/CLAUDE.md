# openclaw-adapter — Agent Guide

Python bridge that runs benchmark turns through OpenClaw's embedded agent and
native plugin loop. Benchmarks import this package through the shared
`ElizaClient` surface; each turn gets an isolated OpenClaw state directory and
a generated plugin exposing only that turn's benchmark tools. The adapter is a
library, not a standalone registry benchmark.

## Run

This package is a library adapter, not a standalone benchmark runner. Import it
from a benchmark that supports the openclaw agent:

```python
from openclaw_adapter import OpenClawClient

client = OpenClawClient(
    provider="claude-subscription",
    model="claude-opus-4-6",
    base_url="http://127.0.0.1:43123/v1",
    api_key="ephemeral-gateway-token",
)
client.wait_until_ready(timeout=60)
print(client.send_message("Reply with the single word: PONG").text)
```

The underlying embedded-runtime invocation is equivalent to:

```bash
openclaw agent --local --json --agent benchmark \
    --model eliza-benchmark-gateway/claude-opus-4-6 \
    --thinking medium \
    --timeout 600 \
    --message "Reply with the single word: PONG"
```

## Test the harness

```bash
# From the adapter directory (unit tests need no provider credentials)
pip install -e .
pytest tests/ -v

# Installed-runtime contract: real OpenClaw + generated plugin, local model stub
OPENCLAW_E2E_BIN=/path/to/openclaw pytest tests/test_native_openclaw_e2e.py -v

# Or from the benchmarks root
pytest openclaw-adapter/tests/ -v
```

## Layout

| Path | Role |
| --- | --- |
| `openclaw_adapter/client.py` | `OpenClawClient` — orchestrates one isolated embedded-runtime turn |
| `openclaw_adapter/native_runtime.py` | Isolated config and generated native benchmark-tool plugin |
| `openclaw_adapter/server_manager.py` | `OpenClawCLIManager` — lifecycle (start = validate binary; stop = clear started state) |
| `openclaw_adapter/clawbench.py` | `build_clawbench_agent_fn` — ClawBench factory |
| `openclaw_adapter/bfcl.py` | `build_bfcl_agent_fn` — function-call benchmark factory |
| `openclaw_adapter/lifeops_bench.py` | `build_lifeops_bench_agent_fn` — LifeOpsBench factory |
| `openclaw_adapter/swe_bench.py` | `build_swe_bench_agent_fn` — SWE-bench factory |
| `openclaw_adapter/terminal_bench.py` | `OpenClawTerminalAgent`, `build_terminal_bench_agent_fn` |
| `openclaw_adapter/_retry.py` | Shared retry logic |
| `tests/` | Offline unit coverage plus an opt-in installed-runtime/local-stub contract |
| `pyproject.toml` | Package definition; `pip install -e .` to develop |

## Notes

- Binary resolution order: `OPENCLAW_BIN` env → `~/.eliza/agents/openclaw/manifest.json` → an `openclaw` on `PATH` → the packaged fallback.
- Publishable runs require a loopback completion gateway. The generated config rejects remote base URLs and references the bearer token by env var rather than persisting it.
- `OPENCLAW_DIRECT_OPENAI_COMPAT=1` and `direct_openai_compatible=True` exist only for parser/retry tests. Their telemetry sets `publishable_native=false`, so the orchestrator quarantines those results.
- Full message history is canonicalized into the isolated turn prompt. Benchmark tools remain structured native plugin tools and only plugin-captured executions become scored tool calls.
- The bridge never executes tools. Callers whose env executes captured calls itself (e.g. the hermes-native env proxy, one chat-completions step per turn) declare `context["capture_stop"] = True`: the embedded loop then ends after the first captured tool batch instead of iterating on placeholder acknowledgements (one billed completion per fake round). Default off — ack-loop benchmarks (orchestrator lifecycle) score reply text written after the ack.
- Provenance records identify `openclaw.agent.embedded`, the generated config hash, native plugin bridge, model, provider, and transport on every turn.
- No results are written by this package — results are the responsibility of the benchmark that consumes it.
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
