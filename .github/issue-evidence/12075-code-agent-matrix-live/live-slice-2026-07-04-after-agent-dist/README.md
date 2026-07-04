# Issue #12075 live Cerebras matrix slice

Date: 2026-07-04

Command:

```bash
PYTHONPATH=packages python3 -m benchmarks.orchestrator.code_agent_matrix \
  --benchmarks swe_bench,terminal_bench \
  --adapters elizaos \
  --provider cerebras \
  --model gemma-4-31b \
  --max-tasks 1 \
  --no-docker \
  --run-root .github/issue-evidence/12075-code-agent-matrix-live/live-slice-2026-07-04-after-agent-dist \
  --force
```

Prerequisite note: `CEREBRAS_API_KEY` was present in the process environment without printing its value. `packages/agent` needed a local `dist` materialization first, so `bun run --cwd packages/agent build` was run before this slice.

## Result summary

- Run mode: live.
- Provider/model: Cerebras `gemma-4-31b`.
- Selected cells: `swe_bench/elizaos`, `terminal_bench/elizaos`.
- Overall runner exit: `0` / `ok`.
- Live report gate: passed.
- Token evidence gate: passed.
- Trajectory review gate: passed.
- Report/release readiness: not passed; this slice is not a release-complete matrix.

Cells:

| benchmark | status | failure class | score | right/wrong/total | LLM calls | tokens |
| --- | --- | --- | ---: | --- | ---: | ---: |
| `swe_bench` | succeeded | `no_patch` | 0.0 | 0 / 1 / 1 | 2 | 19,230 |
| `terminal_bench` | succeeded | `tests_failed` | 0.0 | 0 / 1 / 1 | 20 | 28,844 |

Key artifacts:

- `summary.json` and `summary.md` contain the full run summary and gates.
- `swe_bench/elizaos/output/orchestrated-20260704_172723.json` records the SWE-bench task result.
- `terminal_bench/elizaos/output/terminal-bench-20260704_133701.json` records the Terminal-Bench task result.
- Each selected cell has `trajectories/telemetry.jsonl` with live LLM usage telemetry.

## Manual review

I opened `summary.json`, both cell result payloads, the SWE-bench orchestrated JSON, the Terminal-Bench result JSON, and sampled both trajectory files.

The run confirms the provider/key blocker is cleared for a bounded live slice. The selected cells both ran live and produced trajectory/token evidence. The results are not good enough to close the broader release-readiness work: SWE-bench reached the native worktree path but produced no patch for `astropy__astropy-12907`, and Terminal-Bench looped through shell inspection on `3d-model-format-legacy` before failing tests.

The report remains blocked on full included benchmark coverage, baseline comparability, required stats for the full comparison matrix, and the non-code quality guardrail summary.

Secret scan:

```bash
rg --glob '!README.md' -n "csk-[A-Za-z0-9]|CEREBRAS_API_KEY=|Authorization:|Bearer [A-Za-z0-9._-]{10,}|OPENAI_API_KEY=|api[_-]?key[=:]\s*[^\s\"']+|token[=:]\s*[^\s\"']+|secret[=:]\s*[^\s\"']+" \
  .github/issue-evidence/12075-code-agent-matrix-live/live-slice-2026-07-04-after-agent-dist
```

The scan returned no matches.
