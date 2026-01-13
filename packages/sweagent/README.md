# SWE-agent

> AI-powered Software Engineering Agent with Python, TypeScript, and Rust implementations

[![Version](https://img.shields.io/badge/version-1.1.0-blue.svg)](https://github.com/elizaos/eliza)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

SWE-agent is an autonomous software engineering agent that can solve coding tasks, fix bugs, and implement features across codebases. This package provides production-ready implementations in three languages with full feature parity.

## Features

- **Multi-language Support**: Full implementations in Python, TypeScript, and Rust
- **Flexible Deployment**: Docker-based isolation or local execution
- **Multiple LLM Backends**: OpenAI, Anthropic Claude, Google Gemini, and more via LiteLLM
- **Batch Processing**: Run on multiple problem instances in parallel
- **Configurable Tools**: Extensible command set for code editing, search, and navigation
- **History Processing**: Intelligent context management for long interactions
- **Retry Mechanisms**: Smart retry loops with reviewers and choosers

## Installation

### TypeScript

```bash
npm install @elizaos/sweagent
# or
bun add @elizaos/sweagent
```

### Python

```bash
pip install sweagent
# or using uv
uv pip install sweagent
```

### Rust

Add to your `Cargo.toml`:

```toml
[dependencies]
elizaos-sweagent = "1.1.0"
```

## Quick Start

### TypeScript

```typescript
import { RunSingle, RunSingleConfig } from '@elizaos/sweagent';

const config: RunSingleConfig = {
  agent: {
    model: { name: 'claude-3-5-sonnet-20241022' }
  },
  env: {
    repo: { github_url: 'https://github.com/owner/repo' }
  },
  problem_statement: {
    type: 'text',
    text: 'Fix the bug in main.py',
    id: 'bug-123'
  }
};

const runner = RunSingle.fromConfig(config);
const result = await runner.run();
```

### Python

```python
from sweagent.run.run_single import run

result = run(
    model_name="claude-3-5-sonnet-20241022",
    problem_statement="Fix the bug in main.py",
    repo="https://github.com/owner/repo"
)
```

### Rust

```rust
use elizaos_sweagent::run::{RunSingle, RunSingleConfig};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = RunSingleConfig::default();
    let mut runner = RunSingle::from_config(config)?;
    let result = runner.run().await?;
    Ok(())
}
```

### CLI

```bash
# TypeScript CLI
npx sweagent run --agent.model.name=gpt-4 --problem_statement.path=issue.md

# Python CLI
sweagent run --agent.model.name gpt-4 --problem_statement.path issue.md

# Rust CLI
cargo run --bin sweagent -- run --agent.model.name=gpt-4 --problem_statement.path=issue.md
```

## Configuration

SWE-agent uses YAML configuration files. A typical configuration looks like:

```yaml
agent:
  model:
    name: claude-3-5-sonnet-20241022
    per_instance_cost_limit: 3.0
  templates:
    system_template: |
      You are a software engineering expert...

env:
  deployment:
    type: docker
    image: python:3.11
  repo:
    type: github
    github_url: https://github.com/owner/repo

tools:
  execution_timeout: 500
  submit_command: submit
```

See the `config/` directory for example configurations.

## Project Structure

```
packages/sweagent/
├── python/           # Python implementation
│   ├── sweagent/     # Core package
│   └── tests/        # Python tests
├── typescript/       # TypeScript implementation
│   ├── src/          # Source code
│   └── tests/        # TypeScript tests
├── rust/             # Rust implementation
│   ├── src/          # Source code
│   └── tests/        # Rust tests
├── config/           # Shared YAML configurations
├── scripts/          # Build and test scripts
└── package.json      # Root orchestration
```

## Development

### Running Tests

All tests can be run from the root:

```bash
# Run all tests (TypeScript, Python, Rust)
bun run test

# Individual language tests
bun run test:ts
bun run test:python
bun run test:rust
```

Or use the test script directly:

```bash
./scripts/run-all-tests.sh
```

### Building

```bash
# Build all implementations
bun run build

# Individual builds
bun run build:ts
bun run build:rust
bun run build:python
```

### Linting

```bash
# Lint all
bun run lint

# Individual
bun run lint:check    # TypeScript
bun run lint:rust
bun run lint:python
```

## Architecture

### Agent

The agent module handles the core problem-solving loop:

- **DefaultAgent**: Main agent implementation with configurable models and tools
- **RetryAgent**: Wrapper that retries with different configurations
- **Models**: LiteLLM, Human, Replay, InstantEmptySubmit models
- **History Processors**: Context management for conversation history

### Environment

The environment module provides isolated execution:

- **SWEEnv**: Main environment orchestrator
- **Deployment**: Docker-based or mock deployments
- **Repo**: GitHub, local, or pre-existing repository sources

### Tools

The tools module provides command parsing and execution:

- **Bundle**: Tool definitions with arguments and documentation
- **Parsing**: Multiple parse functions (ThoughtAction, XML, JSON, FunctionCalling)
- **Registry**: Tool registration and discovery

### Run

The run module handles execution:

- **RunSingle**: Single instance runner
- **RunBatch**: Batch processing with parallelism
- **Hooks**: Extension points for monitoring and actions

## API Reference

### TypeScript

See TypeScript type definitions in `typescript/src/index.ts`.

### Python

See Python docstrings and type hints in `python/sweagent/`.

### Rust

Generate docs with:

```bash
cd rust && cargo doc --open
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes ensuring parity across all three implementations
4. Add tests for new functionality
5. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

Based on the original [SWE-agent](https://github.com/princeton-nlp/SWE-agent) by Princeton NLP.
