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
5. Aggregates results and writes `~/.milady/runs/lifeops/lifeops-multiagent-<ts>/report.md`.

The full run takes ~10–20 minutes depending on Cerebras latency.

## Per-agent runs

If you're debugging a specific harness:

```sh
bun run lifeops:eliza            # only eliza (requires bun dev server; auto-spawned)
bun run lifeops:hermes           # only hermes
bun run lifeops:openclaw         # only openclaw
bun run lifeops:cerebras-direct  # only cerebras-direct (upper-bound reference)
```

Each wrapper is just the unified runner with `MILADY_BENCH_AGENT` pinned. Mockoon, the Cerebras gate, the JS scenario step, and the aggregator all still run.

## Tuning knobs (env only)

| Env var | Default | What it does |
|---|---|---|
| `LIFEOPS_USE_MOCKOON` | `1` | Set to `0` for a real-API smoke. Don't do this in CI. |
| `MILADY_BENCH_AGENT` | `all` | `all` / `eliza` / `hermes` / `openclaw` / `cerebras-direct`. |
| `MILADY_BENCH_LIMIT` | `25` | Scenarios per agent. Lower for fast iteration (e.g. `3` for a smoke). |
| `MILADY_BENCH_MODEL` | `gpt-oss-120b` | Cerebras model name. Propagated via `MODEL_NAME_OVERRIDE`. |
| `MILADY_BENCH_CONCURRENCY` | `4` | Per-agent scenario concurrency inside the Python runner. |
| `MILADY_BENCH_SEEDS` | `1` | Repetitions per scenario (for pass^k). |
| `MILADY_BENCH_SKIP_JS` | _(unset)_ | Set to `1` to skip the legacy JS scenario-runner step. |
| `CEREBRAS_API_KEY` | _(required)_ | Sourced automatically from `eliza/.env`. |

No other flags. If you find yourself reaching for one, file a bug.

## Reading the report

`~/.milady/runs/lifeops/lifeops-multiagent-<ts>/report.md` contains:

- **Headline (side-by-side):** agent × {scenarios run, scenarios passed, pass@1, mean score, total cost, agent cost, eval cost, wall time}.
- **Per-domain mean score:** how each agent scored across calendar, mail, messages, contacts, reminders, finance, travel, health, sleep, focus.
- **Cross-agent diffs:** scenarios where exactly one agent passed. These are usually the most informative: a unique pass surfaces real capability gaps (or, in the elizaOS-only direction, a real win).
- **Pointers to per-agent transcripts:** absolute paths to the raw Python-bench JSON for each agent so you can drill into a specific scenario.

`report.json` is the machine-readable rollup (`schema_version: "lifeops-multiagent-v1"`).

## How saved best runs work

Each run dir under `~/.milady/runs/lifeops/` is the source of truth. The runner never overwrites — every invocation gets its own timestamped dir. If you want to declare "this is the new baseline for agent X", symlink:

```sh
ln -snf ~/.milady/runs/lifeops/lifeops-multiagent-<ts> \
        ~/.milady/runs/lifeops/lifeops-multiagent-best
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
- Cerebras model id drift — pin via `MILADY_BENCH_MODEL=<id>` if `gpt-oss-120b` is renamed.

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

## Related scripts

- `scripts/lifeops-full-run.mjs` — the orchestrator (this doc).
- `scripts/lifeops-mockoon-bootstrap.mjs` — Mockoon spawn / stop / status.
- `scripts/lifeops-multiagent-report.mjs` — side-by-side aggregator.
- `scripts/aggregate-lifeops-run.mjs` — single-agent legacy aggregator (still used by the JS scenario step).
- `scripts/lifeops-bench-delta.mjs` — diff two run JSONs.
- `scripts/lifeops-optimize-planner.mjs` — MIPRO / GEPA / bootstrap-fewshot over recent runs.
