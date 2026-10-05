# Codex Adapter

Benchmark harness adapter for the Codex CLI. Requires an installed, authenticated CLI for live runs.

The client replays complete task context and prior JSONL events across turns,
records usage, and rejects failed or incomplete turns. `reset()` starts a fresh
task. An explicit `cwd` defaults to workspace-write; `sandbox="read-only"`
keeps a supplied workspace read-only. Without `cwd`, execution defaults to read-only.
The caller must provide an isolated workspace for coding evaluations. On POSIX,
timeouts kill the CLI process group and retain full stdout/stderr on TimeoutExpired;
other platforms terminate the direct process.

The orchestrator registers Codex for the `eliza_1` decision task only. It runs
all 32 decision cases by default, uses a separate read-only workspace per case,
and retains native attempt receipts. Example from the repository root:

```bash
PYTHONPATH=packages python -m benchmarks.orchestrator run --benchmarks eliza_1 --agent codex --provider codex-native --model gpt-5.5
```

The default uses Eliza's materialized Codex accounts. Select accounts with
`--extra '{"accounts":"account-id"}'`, or explicitly use an authenticated CLI
home with `--extra '{"codex_home":"/absolute/path/to/codex-home"}'`.
`codex-native` means the configured native CLI system, including its account
provider configuration; it must not be labeled as a Cerebras/OpenAI API run.
Actual provider identity is not emitted by the CLI protocol. Results remain
separate from equal-provider framework cohorts. Other suites and local planner
profiles are unsupported. Offline tests do not establish live quality or parity.

## Development

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No compilation or wheel build is required to run this suite from source.

Test from this directory:

```bash
python -m pytest
```

For durable attempt evidence, pass `receipt_dir=Path(...)` to `CodexClient`. Each turn writes an atomic `attempt.json` in a unique attempt directory, retaining complete context, stdout/stderr, terminal status and errors. Authentication files and the credential environment are not copied. This is opt-in; callers must configure a receipt directory before claiming durable failure evidence.
