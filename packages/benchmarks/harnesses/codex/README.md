# Codex Adapter

Benchmark harness adapter for the Codex CLI. Requires an installed, authenticated CLI for live runs.

The client replays complete task context and prior JSONL events across turns,
records usage, and rejects failed or incomplete turns. `reset()` starts a fresh
task. An explicit `cwd` enables workspace-write; otherwise execution is read-only.
The caller must provide an isolated workspace for coding evaluations.

This client is not yet a registered cross-framework suite adapter. Passing its
unit tests does not establish tool-protocol compatibility or live parity.

## Development

Use a Python environment matching `pyproject.toml` and install the required dependencies.

No compilation or wheel build is required to run this suite from source.

Test from this directory:

```bash
python -m pytest
```
