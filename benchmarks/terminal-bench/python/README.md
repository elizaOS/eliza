# Terminal-Bench for ElizaOS

A benchmark evaluating AI agents' proficiency in performing complex tasks within terminal environments. This implementation integrates Terminal-Bench with the ElizaOS Python framework.

## Overview

Terminal-Bench tests AI agents across diverse terminal tasks including:
- **Code Compilation**: Building and compiling projects
- **System Administration**: Managing files, processes, and configurations  
- **Machine Learning**: Setting up and training ML models
- **File Operations**: Creating, modifying, and organizing files
- **Scripting**: Writing and executing shell scripts
- **Database Operations**: Managing databases via CLI
- **Network Configuration**: Configuring network settings

## Installation

```bash
# From the terminal-bench directory
pip install -e ".[dev]"

# Or install dependencies manually
pip install elizaos docker aiofiles pexpect httpx pydantic
```

## Quick Start

### Run with Sample Tasks (Recommended for Testing)

```bash
# Run sample tasks to verify installation
terminal-bench --sample

# Verbose output
terminal-bench --sample --verbose
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

### Using with ElizaOS Runtime

```python
from elizaos.runtime import AgentRuntime
from elizaos_terminal_bench import TerminalBenchRunner

async def run_with_runtime():
    # Initialize ElizaOS runtime
    runtime = AgentRuntime()
    await runtime.initialize()
    
    # Create runner with runtime
    runner = TerminalBenchRunner(runtime=runtime)
    await runner.setup()
    
    # Run benchmark
    report = await runner.run()
    
    await runtime.stop()
```

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
| 4 | Claude Code | Claude 3.5 Sonnet | 58.2% |
| 5 | OpenHands | GPT-4o | 52.8% |
| 6 | Aider | Claude 3.5 Sonnet | 47.5% |
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
