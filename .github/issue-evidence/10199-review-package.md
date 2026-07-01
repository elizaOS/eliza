# #10199 Review-Package Evidence

Date: 2026-07-01
Branch: `fix/10199-benchmark-review-manifest`
Base under test: `15d2a7c58fa2aae244a455834d628795647438a5`
Branch commit under test: `2f2605a0fb4993a59a63acc11348d454319ef37d`

## Change Verified

Added `python -m benchmarks.orchestrator review-package`, which writes:

- `manifest.json` — machine-readable reviewed benchmark package
- `scorecard.md` — human-readable reviewed scorecard

The command exits nonzero unless:

- the static benchmark inventory has no registry/directory gaps,
- `validate-latest-readiness` passes for the selected latest snapshot,
- no generated benchmark output is tracked by git,
- selected latest rows exist,
- a manual trajectory/replay review note is supplied.

## Commands

Focused tests:

```bash
PYTHONPATH=packages python3 -m pytest packages/benchmarks/orchestrator/tests/test_review_package.py -q
# 3 passed in 0.19s
```

Existing guard/readiness regression tests:

```bash
PYTHONPATH=packages python3 -m pytest \
  packages/benchmarks/orchestrator/tests/test_artifact_guard.py \
  packages/benchmarks/orchestrator/tests/test_latest_readiness.py -q
# 15 passed in 0.39s
```

CLI discovery:

```bash
PYTHONPATH=packages python3 -m benchmarks.orchestrator --help
# includes review-package in the subcommand list
```

Real git-index artifact guard:

```bash
PYTHONPATH=packages python3 -m benchmarks.orchestrator verify-artifacts
# OK - checked 46256 tracked file(s); no generated benchmark output is committed.
```

Blocked-package smoke on this clean checkout:

```bash
PYTHONPATH=packages python3 -m benchmarks.orchestrator review-package \
  --out-dir /tmp/eliza-10199-review-package-smoke \
  --reviewed-by codex \
  --reviewer-note 'Smoke test only: no real latest benchmark rows exist in this checkout; focused tests cover successful packaging and blocked packaging.' \
  --skip-runtime-gates
# Wrote manifest: /tmp/eliza-10199-review-package-smoke/manifest.json
# Wrote scorecard: /tmp/eliza-10199-review-package-smoke/scorecard.md
# exits 1 because benchmark_results/latest is absent, as expected
```

Full orchestrator suite:

```bash
env -u CEREBRAS_API_KEY -u OPENAI_API_KEY -u OPENROUTER_API_KEY -u GROQ_API_KEY \
  -u ANTHROPIC_API_KEY -u ELIZAOS_API_KEY -u BENCHMARK_MODEL_PROVIDER \
  -u BENCHMARK_MODEL_NAME \
  PYTHONPATH=packages python3 -m pytest packages/benchmarks/orchestrator/tests -q
# 347 passed, 4 failed
```

The four failures are in existing `test_code_agent_matrix.py` smoke-gate expectations
and do not touch the files changed in this PR. They reproduce after provider keys are
removed from the environment.

Repo verify:

```bash
bun install --frozen-lockfile --ignore-scripts
# installed dependencies successfully

bun run verify
# fails in audit:type-safety-ratchet before typecheck/lint:
# scanned 9901 tracked production source files
# as unknown as: 108 current > 77 baseline
# top offenders are packages/feed, packages/agent, packages/app-core,
# packages/cloud, and plugins/plugin-capacitor-bridge
```

This is the same repo-wide unsafe-cast ratchet already blocking unrelated
branches; this PR adds Python/Markdown only and does not touch the listed files.

## Manual Review

Opened `/tmp/eliza-10199-review-package-smoke/scorecard.md` and
`/tmp/eliza-10199-review-package-smoke/manifest.json`. The scorecard clearly reports
`blocked`, records the git SHA and reviewer note, shows inventory/artifact guard as
`ok`, and lists the missing latest snapshot/readiness findings. The manifest contains
the same blocking findings under `blocking_findings`.

Screenshots/video: N/A for this slice. It is a CLI/operator packaging command with no
UI surface; the generated markdown/JSON artifacts above are the reviewable output.
