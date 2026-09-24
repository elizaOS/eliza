# SWE-bench

Software engineering benchmark (Lite / Verified / Full / Multilingual): generates unified-diff patches for real GitHub issues and evaluates them with the official SWE-bench Docker harness.

## Development

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No compilation or wheel build is required to run this suite from source.

Test from the repository root:

```bash
PYTHONPATH=packages python -m pytest packages/benchmarks/suites/swe_bench/tests
```

## Execution modes and evidence

The default lane generates a patch through a harness bridge. To exercise Eliza's
production message loop and READ/WRITE/EDIT/SHELL tools in an isolated task checkout:

```bash
PYTHONPATH=packages python -m benchmarks.swe_bench.cli --variant verified \
  --harness eliza --execution-mode native_direct --provider cerebras \
  --model MODEL --max-instances 1 \
  --workspace test-results/swe-native/workspaces --output test-results/swe-native
```

Install the pinned Python dependencies first. Supply credentials for the selected
provider; `native_direct` also accepts `openai` or `openai-compatible` using
`OPENAI_API_KEY` and `OPENAI_BASE_URL`. Runtime state and full CLI logs are retained
under the output directory. Native mode is experimental until live integration
and official Docker evaluation pass; CLI completion alone is not issue resolution.
The timeout covers the native process, including runtime boot. The legacy
`--max-steps` flag does not override the production runtime's planning policy.

`--no-docker` validates diff structure only and cannot publish a resolution score.
Mocks, gold-patch calibration, and evaluator-feedback repairs are non-publishable.
Repairs are disabled by default; an explicit `SWE_BENCH_REPAIR_ATTEMPTS` is for
adaptive evaluator diagnostics only, not pass@1 comparison. Official evaluation
logs and predictions are retained under `evaluator/`.

The legacy `--orchestrated` option is a Python-managed provider matrix. It does
not establish Eliza TASKS/ACP orchestration, and its score publication is disabled.
A genuine orchestration lane must record parent TASKS calls, child session and
workspace identities, completion/cancellation receipts, and the independently
graded child diff. Lifecycle decision tests alone do not satisfy that contract.
DeepSWE is a coding agent evaluated on SWE-bench, not another dataset in this repo.
