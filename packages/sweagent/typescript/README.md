# 🤖 swe-agent-ts

A fully-featured autonomous software engineer, written in typescript.

## ✨ Features

- 🚀 **Autonomous problem solving** - Give it a GitHub issue, bug report, or feature request
- 🔧 **Automatic code generation** - Writes, tests, and submits complete solutions
- 📊 **Full SWE-bench support** - Benchmark on thousands of real GitHub issues
- 🌐 **Multi-model support** - Works with OpenAI, Anthropic, and open-source models
- ⚡ **Parallel execution** - Run multiple instances simultaneously
- 🎯 **Interactive shell mode** - Step through solutions interactively
- 📈 **Complete parity** with Python SWE-agent functionality

## 📦 Installation

### Prerequisites
- Node.js 18+ and npm
- Docker (for sandboxed execution)
- Git

### Quick Install

```bash
# Clone the repository
git clone https://github.com/elizaos/swe-agent-ts.git
cd swe-agent-ts

# Install dependencies
npm install

# Build the project
npm run build

# Set up API keys (choose one)
export OPENAI_API_KEY=your_key
# OR
export ANTHROPIC_API_KEY=your_key
```

### Global Installation (Optional)

```bash
# Install globally for system-wide access
npm install -g .

# Now you can use 'sweagent' command anywhere
sweagent --help
```

## 🚀 Quick Start

### 1. Solve a GitHub Issue Automatically

```bash
# Have SWE-agent automatically fix a GitHub issue
npx sweagent run \
  --agent.model.name gpt-4o \
  --env.repo.github_url https://github.com/user/repo \
  --problem_statement.github_url https://github.com/user/repo/issues/123
```

The agent will:
1. Clone the repository
2. Understand the issue
3. Write and test a solution
4. Create a patch file with the fix

### 2. Write Code from a Description

```bash
# Create a new feature from a text description
echo "Create a REST API with CRUD operations for a todo list app" > task.md

npx sweagent run \
  --agent.model.name gpt-4o \
  --env.repo.path ./my-project \
  --problem_statement.path task.md
```

### 3. Interactive Shell Mode

```bash
# Work interactively with the agent
npx sweagent shell \
  --repo ./my-project \
  --config config/default.yaml

# In the shell, you can:
# - Ask it to implement features
# - Debug issues together
# - Review its proposed changes
```

## 📊 Running Benchmarks

### SWE-bench Benchmarking

Test the agent on real-world GitHub issues:

```bash
# Quick test on 3 instances
npx sweagent run-batch \
  --instances.type swe_bench \
  --instances.subset lite \
  --instances.split dev \
  --instances.slice :3 \
  --agent.model.name gpt-4o

# Full benchmark with parallel execution
npx sweagent run-batch \
  --instances.type swe_bench \
  --instances.subset lite \
  --instances.slice :50 \
  --num_workers 5 \
  --agent.model.name gpt-4o \
  --instances.evaluate
```

### Custom Benchmarks

```bash
# Run on your own test cases
cat > my_tests.json << EOF
[
  {
    "imageName": "python:3.11",
    "problemStatement": "Fix the authentication bug in login.py",
    "instanceId": "auth-001",
    "repoName": "my-app",
    "baseCommit": "main"
  }
]
EOF

npx sweagent run-batch \
  --instances.type file \
  --instances.path my_tests.json \
  --agent.model.name gpt-4o
```

## 🧪 Running Tests

```bash
# Run all tests
npm test

# Run specific test suites
npm test -- test-agent
npm test -- test-swe-bench
npm test -- test-environment

# Run with coverage
npm test -- --coverage

# Run linting
npm run lint

# Format code
npm run format
```

## 💡 Examples and Demos

### Run Example Scripts

```bash
# Demo SWE-bench capabilities
node examples/demo_swe_bench.js

# Run comprehensive benchmark examples
./examples/run_swe_bench.sh

# Test basic functionality
node examples/test_swe_bench_simple.js
```

### Common Use Cases

#### Fix a Bug
```bash
npx sweagent run \
  --agent.model.name gpt-4o \
  --env.repo.path ./my-app \
  --problem_statement.text "The login form throws an error when email contains special characters"
```

#### Add a Feature
```bash
npx sweagent run \
  --agent.model.name claude-3-sonnet-20241022 \
  --env.repo.github_url https://github.com/user/repo \
  --problem_statement.text "Add dark mode support to the settings page"
```

#### Refactor Code
```bash
npx sweagent run \
  --agent.model.name gpt-4o \
  --env.repo.path ./legacy-app \
  --problem_statement.text "Refactor the user service to use async/await instead of callbacks"
```

## 🏗️ Project Structure

```
swe-agent-ts/
├── src/
│   ├── agent/          # Core agent logic
│   ├── environment/    # Execution environment
│   ├── run/           # CLI and batch execution
│   ├── tools/         # Agent tools and commands
│   └── utils/         # Utilities
├── config/            # Configuration files
├── examples/          # Example scripts and demos
├── tests/            # Test suite
└── docs/             # Documentation
```

## ⚙️ Configuration

### Model Configuration

```yaml
# config/my_config.yaml
agent:
  model:
    name: gpt-4o
    per_instance_cost_limit: 2.00
    temperature: 0.7
    
tools:
  execution_timeout: 30
  max_consecutive_execution_timeouts: 3
```

### Using Different Models

```bash
# OpenAI GPT-4
export OPENAI_API_KEY=your_key
npx sweagent run --agent.model.name gpt-5 ...

# Anthropic Claude
export ANTHROPIC_API_KEY=your_key
npx sweagent run --agent.model.name claude-4-sonnet ...

# Local/Open-source models via LiteLLM
npx sweagent run --agent.model.name ollama/codellama ...
```

## 🔧 Advanced Usage

### Custom Tools and Commands

```typescript
// Create custom tools for the agent
import { Bundle } from 'swe-agent-ts';

const customBundle = new Bundle({
  name: 'my-tools',
  commands: [
    {
      name: 'analyze',
      description: 'Analyze code quality',
      script: 'npm run analyze'
    }
  ]
});
```

### Hooks and Extensions

```typescript
// Add custom hooks to monitor agent behavior
import { AbstractAgentHook } from 'swe-agent-ts';

class MyHook extends AbstractAgentHook {
  onStepStart() {
    console.log('Agent is thinking...');
  }
  
  onActionExecuted(step) {
    console.log(`Executed: ${step.action}`);
  }
}
```

## 🐛 Troubleshooting

### Common Issues

1. **Node Version**: Ensure Node.js 18+
   ```bash
   node --version  # Should be v18.0.0 or higher
   ```

2. **Build Errors**: Clean and rebuild
   ```bash
   npm run clean
   npm install
   npm run build
   ```

3. **Docker Issues**: Ensure Docker is running
   ```bash
   docker ps  # Should show running containers
   ```

4. **API Keys**: Verify environment variables
   ```bash
   echo $OPENAI_API_KEY
   echo $ANTHROPIC_API_KEY
   ```

```bash
# Fork and clone the repository
git clone https://github.com/elizaos/swe-agent-ts.git

# Create a feature branch
git checkout -b feature/amazing-feature

# Make changes and test
npm test

# Submit a pull request
```

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

This TypeScript port is based on the original [SWE-agent](https://github.com/princeton-nlp/SWE-agent) by Princeton University and Stanford University researchers.