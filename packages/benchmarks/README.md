# elizaOS Benchmarks

The elizaOS evaluation suite — every benchmark used to measure Eliza agents,
plus the harness adapters that let the same benchmarks run against other agent
backends (Hermes, OpenClaw, Codex). Suites span agent autonomy,
tool-call correctness, long-horizon reasoning, voice/vision multimodal,
embodied control, onchain trading, and adversarial robustness.

Primarily Python, with several TypeScript/Bun and Rust harnesses. Each
benchmark is self-contained in its own directory under `suites/` and carries
`README.md` + `AGENTS.md`.

## Layout

```
suites/            One directory per benchmark (bfcl, tau-bench, agentbench, vending-bench, …)
harnesses/         Agent-backend adapters: eliza / hermes / openclaw / codex
registry/          Source of truth — every benchmark's id, run command, requirements, scorer
framework/         Shared harness framework (Python + TypeScript)
lib/               Shared helpers: results store, pricing, trajectory normalizer, TS schemas
plugin-benchmarks/ @elizaos/plugin-benchmarks — canonical Action wrappers for benchmark tool vocabularies
viewer/            Static browser UI for inspecting normalized results
scripts/           Acceptance gate, cost computation, CI helpers
tests/             Suite-level tests (registry, scoring, normalization, acceptance gate)
```

## Setup

```bash
# From the elizaOS monorepo root (shared Bun workspace and lockfile)
bun install
cd packages/benchmarks
export PYTHONPATH="$(cd .. && pwd)"

# Python — one venv at the repo root covers the shared modules and most suites
python3 -m venv .venv && source .venv/bin/activate
pip install pytest

# Some suites carry their own requirements — see each suite's AGENTS.md, e.g.
pip install -r suites/<benchmark>/requirements.txt
```

elizaOS runtime dependencies resolve from this monorepo through Bun workspaces.
There is no nested runtime checkout or separate Bun installation.

The Python modules import as the `benchmarks` package: run Python entry points
with `packages/` on `PYTHONPATH`, as configured above.

## Running

```bash
# List everything the registry knows about and verify adapter coverage
python -m benchmarks.orchestrator list-benchmarks

# Run one benchmark (idempotent — successful signatures are skipped)
python -m benchmarks.orchestrator run --benchmarks <id> --provider <p> --model <m>

# Run the whole suite
python -m benchmarks.orchestrator run --all --provider cerebras --model gemma-4-31b

# Standard academic adapters (MMLU / HumanEval / GSM8K / MT-Bench)
python -m benchmarks.run mmlu --mock --provider openai --output /tmp/mmlu
```

Each benchmark can also be run directly from its own directory — see that
benchmark's `AGENTS.md` for the exact command and a no-key smoke path.

## Testing

```bash
pytest tests/ -v                       # suite-level (registry, scoring, normalization)
pytest suites/<benchmark>/... -v       # one benchmark — see its AGENTS.md
bun run --cwd plugin-benchmarks test   # plugin vitest suite
```

TypeScript/Bun suites (`eliza-1`, `vision-language`, `configbench`,
`interrupt-bench`, `personality-bench`, `three-agent-dialogue`) test with
their workspace test scripts; Rust components use `cargo test`.

## Results

Run output (per-task traces, scorecards, the orchestrator SQLite DB, and viewer
data) lands under `benchmark_results/` and is **gitignored** — generated, never
committed. Inspect history with:

```bash
python -m benchmarks.orchestrator serve-viewer
```

## Adding a benchmark

1. Create `suites/<your-benchmark>/` with the harness, tests, and README and AGENTS guides.
2. Register it in `registry/commands.py` (id, `build_command`, `locate_result`,
   `requirements`) and add a scorer in `registry/scores.py`.
3. Classify its CI lane (`scheduled` / `smoke` / `manual`) in the orchestrator's
   CI coverage map — the suite tests fail until every registered benchmark has one.
4. Confirm it appears in `python -m benchmarks.orchestrator list-benchmarks`.

Campaign commands and execution requirements: [orchestrator guide](suites/orchestrator/README.md).

Integration findings and validation: [review](REVIEW.md).

## Monorepo validation

Install once at the repository root with `bun install`. Repository validation
uses the canonical full E2E lane. The separate benchmark unit/smoke workflow
has been retired; benchmark campaigns remain explicit research commands and
do not establish product E2E acceptance.

From the monorepo root:

```bash
python -m pip install -r packages/benchmarks/requirements-ci.txt
python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
PYTHONPATH=packages python -m pytest packages/benchmarks/tests packages/benchmarks/lib packages/benchmarks/suites/orchestrator/tests -q
python packages/benchmarks/scripts/runtime-smoke.py
```

Action-calling publication requires the full corpus under `packages/training`,
or the explicit `ELIZA_TRAINING_ROOT` override. Missing corpus data makes
calibration incompatible; diagnostic smoke rows cannot stand in for that corpus.

For all harness unit suites, use `pytest --import-mode=importlib` to keep their
same-named test modules isolated. Docker-backed candidate execution is opt-in
with `BENCHMARK_DOCKER_TESTS=1`; it requires a working daemon and the pinned
evaluator image. The offline unit lane does not certify that sandbox.
