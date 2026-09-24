# Benchmark package guide

This directory owns the benchmark suites, harness adapters, registry, shared
Python/TypeScript helpers, and benchmark action plugin inside the elizaOS
monorepo. Follow the repository [AGENTS.md](../../AGENTS.md) and read the
nearest suite guide and README before editing.

## Ownership and setup

- The root `package.json` owns Bun workspaces, overrides, patches, and trusted
  dependencies. Run `bun install` from the monorepo root. Runtime dependencies
  resolve from sibling packages and plugins through `workspace:*`.
- `AGENTS.md` is the only instruction file; do not duplicate it as `CLAUDE.md`.
- Python imports use `benchmarks.*`. From the monorepo root, set
  `PYTHONPATH="$PWD/packages"`; from this directory, set `PYTHONPATH=..`.
  `__init__.py` also exposes suites under that package namespace.
- Python dependencies remain suite-specific. Use a virtual environment and
  the suite's `pyproject.toml` or `requirements.txt`. Rust suites use Cargo.

## Layout

| Directory | Responsibility |
| --- | --- |
| `suites/` | Benchmark implementations, inputs, fixtures, and tests |
| `harnesses/` | Eliza, Hermes, OpenClaw, Smithers, and Codex adapters |
| `registry/` | Benchmark commands, requirements, result locators, and scorers |
| `framework/` | Shared Python and TypeScript harness framework |
| `lib/` | Results storage, pricing, trajectories, and shared schemas |
| `plugin-benchmarks/` | Canonical benchmark action vocabulary |
| `viewer/` | Static normalized-results viewer |
| `scripts/` | Acceptance gates and cost reporting |
| `tests/` | Shared registry, scoring, and harness contracts |

## Running and validation

From this directory, with the appropriate Python environment activated:

```bash
PYTHONPATH=.. python -m benchmarks.orchestrator list-benchmarks
PYTHONPATH=.. python -m benchmarks.orchestrator inventory --format markdown
PYTHONPATH=.. python -m benchmarks.orchestrator run --benchmarks <id> --provider <p> --model <m>
PYTHONPATH=.. python -m pytest tests/ lib/ -q
bun run test:plugin
bun run typecheck:plugin
```

Run affected suite tests as described in their guides, then the root validation
gates. Offline conformance validates the harness, not agent quality. Publishable
scores require real-model provenance, complete per-item trajectories, and
manual artifact review. Never fabricate scores or silently truncate model inputs.

## Adding and maintaining suites

Keep each benchmark's implementation, data, README, guide, and tests together
under `suites/<name>/`. Register its command in `registry/commands.py`, its
scorer in `registry/scores.py`, and its execution classification in
`suites/orchestrator/ci_coverage.py`. That classification describes execution
requirements; it does not prove a hosted workflow is active.

Keep run results, logs, caches, coverage, SQLite databases, and generated audit
reports out of source control. Preserve authored datasets, protected task
inputs, replay fixtures, golden baselines, and consumed schema manifests even
when a generator originally produced them. Test independent behavior instead
of pinning a second committed copy of reproducible report output.
