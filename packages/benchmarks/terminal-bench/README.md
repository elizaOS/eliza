# Terminal-Bench for ElizaOS

A faithful re-implementation of [Terminal-Bench](https://www.tbench.ai/)
(Laude Institute, Apache-2.0) wired into the ElizaOS Python harness. The
real upstream task corpus is vendored under `tasks/` and run inside
per-task Docker images driven by tmux, matching upstream semantics.

## What's in the box

- **Vendored task corpus** at `packages/benchmarks/terminal-bench/tasks/`
  (241 tasks, snapshot of upstream `original-tasks/`, Apache-2.0).
- **Tmux-backed Docker environment** (`TmuxDockerEnvironment`) — builds
  each task's Dockerfile, launches a persistent tmux session, and routes
  every agent command through `tmux send-keys` + `tmux wait`. Required
  for tasks that use interactive tools (vim, python -i, less, ...).
- **One-shot Docker fallback** (`TerminalEnvironment`, `--one-shot`) for
  images where tmux is unavailable.
- **Local-temp-workspace path** (`LocalTerminalEnvironment`,
  `--local-sandbox`) for smoke runs without Docker.
- **Gated mock environment** (`MockTerminalEnvironment`, `--mock`) —
  always reports success, only legal for unit tests.
- **Fail-loud dataset loader** — `TerminalBenchDataset` raises
  `TerminalBenchDatasetMissingError` if the corpus is missing rather
  than quietly falling back to `SAMPLE_TASKS`.

Categories present in the vendored corpus: algorithms, audio-processing,
computer-vision, data-processing, data-querying, data-science,
debugging, file-operations, file-system, game(s), machine-learning,
math(ematics), model-training, optimization, personal-assistant,
protocol-analysis, reproducible-builds, research, scientific-computing,
security, software-engineering, system-administration, video-processing.

## Installation

```bash
# From the terminal-bench directory
pip install -e ".[dev]"
```

Docker is required for the default tmux backend. tmux is installed
automatically inside containers that don't already ship it.

## Quick Start

### Smoke run (no Docker corpus required)

```bash
# Tiny built-in SAMPLE_TASKS — CI / wiring check ONLY, not Terminal-Bench.
terminal-bench --use-sample-tasks --local-sandbox
```

### Run the real benchmark

```bash
# Default backend = tmux inside per-task Docker images.
terminal-bench --task-ids hello-world

# All 241 tasks (slow).
terminal-bench

# Force the legacy one-shot exec_run path (no tmux).
terminal-bench --task-ids hello-world --one-shot

# Eliza bridge task-agent selection defaults to opencode. If
# ANTHROPIC_API_KEY/CLAUDE_API_KEY is present it resolves to claude; if
# CODEX_API_KEY/OPENAI_API_KEY is present it resolves to codex. Override it:
terminal-bench --task-ids hello-world --task-agent opencode

# Cerebras via the eliza bridge, preserving the configured model name.
terminal-bench --model-provider cerebras --model gpt-oss-120b

# Cerebras gpt-oss-120b through the hermes harness.
terminal-bench --agent-harness hermes --model-provider cerebras --model gpt-oss-120b --task-ids hello-world

# Local baselines for harness sanity checks.
terminal-bench --use-sample-tasks --local-sandbox --agent-harness always-right
terminal-bench --use-sample-tasks --local-sandbox --agent-harness always-wrong
terminal-bench --use-sample-tasks --local-sandbox --agent-harness random --baseline-random-seed 1

# Fail-loud check: missing corpus raises rather than running SAMPLE_TASKS.
terminal-bench --data-path /no/such/path  # -> TerminalBenchDatasetMissingError
```

### Network policy

Network is disabled by default (`network_mode="none"`). Some upstream
tasks install `uv` from astral.sh inside `run-tests.sh` and so need a
bridge network at grading time. Pass `--network ...` per task or rely
on per-task `network_enabled=True` in `task.yaml` to flip this. To
enforce hermetic runs, set `network_mode="none"` explicitly in
`TerminalBenchConfig`.

### Refreshing the vendored corpus

```bash
git clone --depth 1 https://github.com/laude-institute/terminal-bench.git /tmp/tb
cp -r /tmp/tb/original-tasks/* packages/benchmarks/terminal-bench/tasks/
cp /tmp/tb/LICENSE packages/benchmarks/terminal-bench/tasks/LICENSE.upstream
```

### Leaderboard

`LEADERBOARD_SCORES` ships empty — leaderboard numbers move too fast
to embed. Compare your score against the live leaderboard at
<https://www.tbench.ai/leaderboard>.

## Original quick-start (legacy section, retained for compat)

### Run with Sample Tasks

```bash
# Run sample tasks to verify installation
terminal-bench --use-sample-tasks --local-sandbox

# Verbose output
terminal-bench --use-sample-tasks --local-sandbox --verbose
```

### Run Full Benchmark

```bash
# Download and run full Terminal-Bench 2.0 dataset
terminal-bench --data-path ./terminal-bench-data

# Filter by category
terminal-bench --categories scripting code_compilation

# Filter by difficulty
terminal-bench --difficulties easy medium

# Limit number of tasks
terminal-bench --max-tasks 20
```

### Python API

```python
import asyncio
from elizaos_terminal_bench import (
    TerminalBenchRunner,
    TerminalBenchConfig,
    TaskCategory,
    TaskDifficulty,
)

async def main():
    # Configure the benchmark
    config = TerminalBenchConfig(
        output_dir="./results",
        max_iterations=20,
        model_name="gpt-4",
        verbose=True,
    )
    
    # Create and setup runner
    runner = TerminalBenchRunner(config=config)
    await runner.setup(use_sample_tasks=True)
    
    # Run benchmark
    report = await runner.run(
        categories=[TaskCategory.SCRIPTING],
        max_tasks=10,
    )
    
    # Print results
    print(f"Accuracy: {report.accuracy:.1%}")
    print(f"Passed: {report.passed_tasks}/{report.total_tasks}")
    
    if report.leaderboard_comparison:
        print(f"Rank: #{report.leaderboard_comparison.rank}")

asyncio.run(main())
```

### Bridge integration

By default runs are routed through the elizaOS TypeScript benchmark
bridge (`packages/app-core/src/benchmark/server.ts`). The CLI spawns the
bridge automatically when `ELIZA_BENCH_URL` is unset, and
`TerminalBenchRunner` delegates per-task decision-making to
`ElizaBridgeTerminalAgent` (in `eliza_adapter.terminal_bench`). The
Python `AgentRuntime` path has been removed.

Alternative harnesses are selected with `--agent-harness`. `hermes`
constructs `hermes_adapter.client.HermesClient` from the configured
provider/model, so `--model-provider cerebras --model gpt-oss-120b`
uses the Cerebras OpenAI-compatible endpoint without printing or
embedding an API key. `openclaw` follows the same provider/model
resolution. The local baselines are `always-right`, `always-wrong`, and
`random`.

## Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `data_path` | `./terminal-bench-data` | Path to dataset |
| `output_dir` | `./benchmark_results/terminal-bench` | Output directory |
| `version` | `2.0` | Terminal-Bench version |
| `max_iterations` | `20` | Max agent iterations per task |
| `timeout_per_task_seconds` | `300` | Task timeout |
| `model_name` | `gpt-4` | LLM model to use |
| `temperature` | `0.0` | Generation temperature |
| `agent_harness` | `eliza` | Decision harness: `eliza`, `hermes`, `openclaw`, `always-right`, `always-wrong`, `random` |
| `task_agent` | `opencode` | Eliza bridge task agent; auto-resolves to `claude`/`codex` when corresponding key env vars are present |
| `docker_image` | `ubuntu:22.04` | Default Docker image |
| `memory_limit` | `2g` | Container memory limit |
| `verbose` | `False` | Enable verbose logging |
| `dry_run` | `False` | Run without execution |

## Current Leaderboard (December 2025)

| Rank | Agent | Model | Accuracy |
|------|-------|-------|----------|
| 1 | Droid (Factory) | GPT-5.2 | 64.9% |
| 2 | Ante (Antigma Labs) | Gemini 3 Pro | 64.7% |
| 3 | Junie CLI (JetBrains) | Gemini 3 Flash | 64.3% |
| 4 | Claude Code | Claude Sonnet 4.6 | 58.2% |
| 5 | OpenHands | GPT-4o | 52.8% |
| 6 | Aider | Claude Sonnet 4.6 | 47.5% |
| ... | GPT-4 (baseline) | - | 28.3% |
| - | Human Expert | - | 92.5% |

**Note**: No agent has exceeded 65% accuracy, demonstrating the benchmark's challenging nature.

## Output Files

After running the benchmark, you'll find:

```
benchmark_results/terminal-bench/
├── terminal-bench-20251211_143052.json   # Detailed JSON report
├── terminal-bench-20251211_143052.md     # Markdown summary
└── sessions-20251211_143052/             # Session logs (optional)
    ├── task_001.json
    └── task_002.json
```

## Running Tests

```bash
# Run all tests
pytest

# Run with coverage
pytest --cov=elizaos_terminal_bench

# Run specific test file
pytest tests/test_types.py

# Skip Docker tests
pytest -m "not docker"
```

## Docker Requirements

Terminal-Bench requires Docker for sandboxed execution:

```bash
# Verify Docker is running
docker info

# Pull required images
docker pull ubuntu:22.04
docker pull gcc:latest
docker pull python:3.11
```

## Task Categories

### Easy Tasks
- Create files and directories
- Execute simple commands
- Write basic scripts

### Medium Tasks
- Compile single-file programs
- Parse and transform text
- Configure environment variables

### Hard Tasks
- Multi-step build processes
- Complex system administration
- ML model setup and training

## Troubleshooting

### Docker Connection Error
```
TerminalEnvironmentError: Failed to connect to Docker
```
Ensure Docker daemon is running: `sudo systemctl start docker`

### Task Timeout
```
Task timed out after 300 seconds
```
Increase timeout: `--timeout 600`

### API Key Missing
```
OPENAI_API_KEY environment variable required
```
Set your API key: `export OPENAI_API_KEY=sk-...`

## References

- [Terminal-Bench Official Site](https://tbench.ai)
- [Terminal-Bench GitHub](https://github.com/laude-institute/terminal-bench)
- [Terminal-Bench Leaderboard](https://tbench.ai/leaderboard/terminal-bench/2.0)
- [ElizaOS Documentation](https://elizaos.dev)

## License

MIT License - See LICENSE file for details.
