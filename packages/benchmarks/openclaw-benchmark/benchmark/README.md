# Benchmark task specifications

Task material for the `openclaw_bench` registry entry. The registry requires
this directory (`BenchmarkRequirements.paths`), and the sandbox image bakes the
task PRD into the agent workspace:

- [`standard_tasks.md`](./standard_tasks.md) — the standardized Weather-CLI
  task set (four tasks: implementation, CLI flags, error handling, tests).
  `openclaw/Dockerfile` copies it into the container as `/workspace/PRD.md`, so
  its content is part of the benchmark definition — do not edit it casually;
  changing the PRD changes what every run is scored against. The text is the
  original upstream German; harnesses receive it verbatim.

Evidence and scoring land under the adapter's run output, not in this
directory. See the package [`README.md`](../README.md) and
[`AGENTS.md`](../AGENTS.md) for how runs are launched.
