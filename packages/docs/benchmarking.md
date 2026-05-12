# Benchmarking elizaOS, Hermes, and OpenClaw

The lifeops benchmark runs your changes against three agent types in parallel
so you can see where elizaOS leads, lags, or stalls. One command, no flags.

## Quick start

```sh
bun run lifeops:full
```

That's it. The runner:

1. Boots every Mockoon environment under `test/mocks/mockoon/` so connectors hit `localhost:<port>` instead of real APIs.
2. Verifies the Cerebras eval helper is reachable (`bun run lifeops:verify-cerebras`).
3. Runs each agent (`eliza`, `hermes`, `openclaw`) through 25 scenarios on Cerebras gpt-oss-120b. Sequential, since the agents share the Cerebras quota and the Mockoon port fleet.
4. Runs the existing TS scenario-runner over `test/scenarios/lifeops.*`.
5. Aggregates results and writes `~/.eliza/runs/lifeops/lifeops-multiagent-<ts>/report.md`.

The full run takes ~10–20 minutes depending on Cerebras latency.

## Per-agent runs

If you're debugging a specific harness:

```sh
bun run lifeops:eliza            # only eliza (requires bun dev server; auto-spawned)
bun run lifeops:hermes           # only hermes
bun run lifeops:openclaw         # only openclaw
bun run lifeops:cerebras-direct  # only cerebras-direct (upper-bound reference)
```

Each wrapper is just the unified runner with `ELIZA_BENCH_AGENT` pinned. Mockoon, the Cerebras gate, the JS scenario step, and the aggregator all still run.

## Tuning knobs (env only)

| Env var | Default | What it does |
|---|---|---|
| `LIFEOPS_USE_MOCKOON` | `1` | Set to `0` for a real-API smoke. Don't do this in CI. |
| `ELIZA_BENCH_AGENT` | `all` | `all` / `eliza` / `hermes` / `openclaw` / `cerebras-direct`. |
| `ELIZA_BENCH_LIMIT` | `25` | Scenarios per agent. Lower for fast iteration (e.g. `3` for a smoke). |
| `ELIZA_BENCH_MODEL` | `gpt-oss-120b` | Cerebras model name. Propagated via `MODEL_NAME_OVERRIDE`. |
| `ELIZA_BENCH_CONCURRENCY` | `4` | Per-agent scenario concurrency inside the Python runner. |
| `ELIZA_BENCH_SEEDS` | `1` | Repetitions per scenario (for pass^k). |
| `ELIZA_BENCH_SKIP_JS` | _(unset)_ | Set to `1` to skip the legacy JS scenario-runner step. |
| `CEREBRAS_API_KEY` | _(required)_ | Sourced automatically from `eliza/.env`. |

No other flags. If you find yourself reaching for one, file a bug.

## Reading the report

`~/.eliza/runs/lifeops/lifeops-multiagent-<ts>/report.md` contains:

- **Headline (side-by-side):** agent × {scenarios run, scenarios passed, pass@1, mean score, total cost, agent cost, eval cost, wall time}.
- **Per-domain mean score:** how each agent scored across calendar, mail, messages, contacts, reminders, finance, travel, health, sleep, focus.
- **Cross-agent diffs:** scenarios where exactly one agent passed. These are usually the most informative: a unique pass surfaces real capability gaps (or, in the elizaOS-only direction, a real win).
- **Pointers to per-agent transcripts:** absolute paths to the raw Python-bench JSON for each agent so you can drill into a specific scenario.

`report.json` is the machine-readable rollup (`schema_version: "lifeops-multiagent-v1"`).

## How saved best runs work

Each run dir under `~/.eliza/runs/lifeops/` is the source of truth. The runner never overwrites — every invocation gets its own timestamped dir. If you want to declare "this is the new baseline for agent X", symlink:

```sh
ln -snf ~/.eliza/runs/lifeops/lifeops-multiagent-<ts> \
        ~/.eliza/runs/lifeops/lifeops-multiagent-best
```

(Per-agent baselines from W1-3 live as separate dirs:
`lifeops-{hermes,openclaw,eliza}-baseline-<ts>`. Those predate the unified runner
and are kept for historical comparison.)

The CI workflow uploads run dirs as 30-day artifacts; check the PR comment for the direct link.

## Continuous run / cron

`scripts/lifeops-cron.mjs` (Wave-3 follow-up) will run this nightly. Until then, the `.github/workflows/lifeops-bench.yml` workflow runs on every PR that touches:

- `plugins/app-lifeops/**`
- `plugins/app-training/**`
- `packages/scenario-runner/**`
- `packages/benchmarks/lifeops-bench/**`
- `packages/core/src/runtime/**`
- `test/scenarios/lifeops.**`
- `scripts/lifeops-*.mjs`

## Troubleshooting

### Cerebras gate fails

The runner aborts before any agent if `bun run lifeops:verify-cerebras` returns non-zero. Most common causes:

- `CEREBRAS_API_KEY` not set in `eliza/.env`.
- Cerebras outage (check status page; transient 5xx should retry on a second invocation).
- Cerebras model id drift — pin via `ELIZA_BENCH_MODEL=<id>` if `gpt-oss-120b` is renamed.

### Mockoon port collisions

Mockoon environments live in `test/mocks/mockoon/*.json` and each one binds a fixed port. If a previous run left orphans, the bootstrap detects them and reuses (logs `already listening on <port>, skipping spawn`). To force a clean slate:

```sh
node scripts/lifeops-mockoon-bootstrap.mjs --stop
```

### Python bench can't find the module

The runner invokes `python3 -m eliza_lifeops_bench` with `cwd` set to `packages/benchmarks/lifeops-bench/`. If that fails:

```sh
cd packages/benchmarks/lifeops-bench
pip install -e .
```

### "Eliza adapter not yet wired"

The `eliza` agent path requires a bench-server checkout that exposes the OpenAI-compatible endpoint. The harness auto-spawns one when `ELIZA_BENCH_URL` is unset. If you've got a long-running dev server, point at it instead:

```sh
ELIZA_BENCH_URL=http://localhost:31337/v1 \
ELIZA_BENCH_TOKEN=<token> \
bun run lifeops:eliza
```

## Personality benchmark

The personality bench is a separate harness that tests whether an agent:

- shuts up when asked,
- holds a style (`be terse`, haiku, no hedging, no emojis) across unrelated turns,
- respects per-user traits (`no emojis`, `no buddy/friend`, `code blocks only`, ...),
- escalates / de-escalates cleanly when the user pushes harder,
- isolates per-user vs global scope (admin can change globally, regular user gets a per-user override only).

```sh
bun run personality:bench
```

Runs all 200 W3-2 personality scenarios against four agent profiles
(`eliza`, `hermes`, `openclaw`, `eliza-runtime`) on Cerebras `gpt-oss-120b`.
Three profiles are LLM-only — what differs is the system prompt. Pure
conversational, no tools, no Mockoon, no PGLite. The fourth profile,
`eliza-runtime`, drives the real elizaOS bench HTTP server end-to-end so
the W3-1 reply-gate, verbosity enforcer, and `PERSONALITY` action are
actually exercised (not approximated). See the section below for the
spawn/cleanup contract.

The full run is ~15–25 min wall depending on Cerebras latency and costs
roughly $1–$2 in tokens. Trajectories + verdicts land at
`~/.eliza/runs/personality/personality-multiagent-<ts>/report.md` with a
side-by-side comparison.

### Per-agent runs

```sh
bun run personality:bench:eliza
bun run personality:bench:hermes
bun run personality:bench:openclaw
bun run personality:bench:eliza-runtime
```

Each is the same orchestrator with `ELIZA_PERSONALITY_AGENT` pinned. The
multi-agent aggregator still runs at the end — it just produces a
report with one column.

### The `eliza-runtime` profile

The first three profiles are LLM-only and answer the question *"does the
model behave correctly when told to be terse / silent / no-emoji?"* —
they're a baseline for what a strong system prompt can buy you.

`eliza-runtime` is different. It spawns the real bench HTTP server at
`packages/app-core/src/benchmark/server.ts` with `ADVANCED_CAPABILITIES=true`,
points it at Cerebras `gpt-oss-120b`, waits up to 120s for
`/api/benchmark/health` to report `status: "ready"`, then routes every user
turn through `POST /api/benchmark/message`. This means:

- The W3-1 reply-gate fires **before** the LLM is called. On `shut_up`
  scenarios you see assistant `content: ""` and `actions: []` with zero
  prompt tokens spent on the suppressed turns.
- The `PERSONALITY` action and the verbosity enforcer are real plugins
  loaded by the runtime, not a system-prompt approximation.
- Per-room scope semantics work via distinct task ids — each `room` in the
  scenario maps to its own bench session, so the personality store's
  per-user / global keys behave as the scenario expects.

The server is spawned as a detached process group. The runner installs
`exit` / `SIGINT` / `SIGTERM` / `SIGHUP` / `uncaughtException` handlers
that send `SIGTERM` to the group, then `SIGKILL` after a 5 s grace
period. Operators can verify the contract by interrupting the runner
mid-run; `ps -ef | grep benchmark/server.ts` should be empty within
seconds. Server stdout/stderr land in
`$TMPDIR/personality-bench-server-<port>-<ts>.{stdout,stderr}.log`.

`eliza-runtime` is sequential by construction (`concurrency` is forced to
`1` for the runtime profile). The shared bench session state and the
personality store would otherwise interleave across scenarios.

### Tuning knobs (env only)

| Env var | Default | What it does |
|---|---|---|
| `ELIZA_PERSONALITY_AGENT` | `all` | `all` / `eliza` / `hermes` / `openclaw` / `eliza-runtime`. |
| `ELIZA_PERSONALITY_LIMIT` | `200` | Scenarios per agent. Scenarios are bucket-interleaved so `LIMIT=5` covers all 5 buckets. |
| `ELIZA_PERSONALITY_MODEL` | `gpt-oss-120b` | Cerebras model id. |
| `ELIZA_PERSONALITY_CONCURRENCY` | `1` | Scenarios in flight per agent (sequential across agents). |
| `ELIZA_PERSONALITY_SCENARIO_DIR` | `test/scenarios/personality` | Override scenario root. |
| `PERSONALITY_JUDGE_ENABLE_LLM` | _auto_ | `0` disables the LLM judge layer (faster, slightly less accurate). |
| `PERSONALITY_JUDGE_STRICT` | `0` | Set to `1` to collapse `NEEDS_REVIEW` → `FAIL`. |
| `CEREBRAS_API_KEY` | _(required)_ | Sourced from `eliza/.env`. |
| `ELIZA_PERSONALITY_RUNTIME_HEALTH_MS` | `120000` | `eliza-runtime` only — how long to wait for the spawned bench server's `/api/benchmark/health` to flip to `ready` before aborting. |

No CLI flags — every knob is an env var.

### Reading the report

`~/.eliza/runs/personality/personality-multiagent-<ts>/report.md`:

- **Summary:** agent × {scenarios, PASS, FAIL, NEEDS_REVIEW, %Pass, cost, wall}.
- **Per-bucket × agent:** PASS/total cell per (bucket, agent).
- **Cross-agent diffs:**
  - Scenarios where exactly one agent passed (capability win).
  - Scenarios where ALL agents failed (uniform gap — usually the rubric or the W3-2 mapping needs attention).
  - Scenarios flagged NEEDS_REVIEW by ALL agents (operator review).
- **NEEDS_REVIEW list:** full per-(scenario, agent) view for triage.
- **Per-agent run dirs:** absolute paths to drill into a scenario.

`report.json` is the machine-readable rollup (`schema_version: "personality-bench-multiagent-v1"`).

### Just grade an existing run dir

The W3-3 grader still works standalone:

```sh
bun run personality:judge --run-dir <run-dir> --output report.md --output-json report.json
```

### Calibration

```sh
bun run personality:bench:calibrate
```

Runs the W3-3 calibration suite (70 hand-graded scenarios; current
agreement 100%, false-positive 0%). Useful before changing a rubric.

## Related scripts

- `scripts/lifeops-full-run.mjs` — the orchestrator (this doc).
- `scripts/lifeops-mockoon-bootstrap.mjs` — Mockoon spawn / stop / status.
- `scripts/lifeops-multiagent-report.mjs` — side-by-side aggregator.
- `scripts/aggregate-lifeops-run.mjs` — single-agent legacy aggregator (still used by the JS scenario step).
- `scripts/lifeops-bench-delta.mjs` — diff two run JSONs.
- `scripts/lifeops-optimize-planner.mjs` — MIPRO / GEPA / bootstrap-fewshot over recent runs.
