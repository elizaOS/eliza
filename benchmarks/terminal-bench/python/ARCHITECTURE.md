# Terminal-Bench Architecture & Flow Documentation

## Overview

Terminal-Bench evaluates AI agents' proficiency in terminal environments. This document describes the complete architecture, data flow, ElizaOS integration patterns, and potential issues.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Terminal-Bench Runner                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────┐    ┌──────────────┐    ┌────────────────────────────┐ │
│  │   Dataset   │───▶│    Agent     │───▶│      Evaluator            │ │
│  │   Loader    │    │  (Terminal)  │    │   (Test Verification)     │ │
│  └─────────────┘    └──────────────┘    └────────────────────────────┘ │
│        │                   │                         │                  │
│        ▼                   ▼                         ▼                  │
│  ┌─────────────┐    ┌──────────────┐    ┌────────────────────────────┐ │
│  │TerminalTask│    │  Terminal    │    │    TerminalBenchReport    │ │
│  │  Objects   │    │ Environment  │    │  (JSON + Markdown)        │ │
│  └─────────────┘    │  (Docker)    │    └────────────────────────────┘ │
│                     └──────────────┘                                    │
└─────────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        LLM Access (2 modes)                              │
├────────────────────────────────┬────────────────────────────────────────┤
│      Standalone Mode           │        ElizaOS Runtime Mode            │
├────────────────────────────────┼────────────────────────────────────────┤
│  Direct OpenAI API calls       │  runtime.use_model(ModelType.TEXT_*)   │
│  via httpx                     │  with registered model handlers        │
│  Requires: OPENAI_API_KEY      │  Requires: Plugin with model handlers  │
└────────────────────────────────┴────────────────────────────────────────┘
```

## Component Details

### 1. Dataset Loader (`dataset.py`)

**Purpose**: Loads Terminal-Bench tasks from files or built-in samples.

**Data Flow**:
```
Input: data_path (directory) OR use_sample_tasks=True
  ↓
Load metadata.json, instruction.txt, test.sh, solution.sh
  ↓
Parse into TerminalTask objects
  ↓
Output: list[TerminalTask]
```

**Key Features**:
- Supports filtering by category, difficulty, task IDs
- Built-in sample tasks for testing
- Statistics calculation

### 2. Terminal Environment (`environment.py`)

**Purpose**: Manages Docker containers for sandboxed command execution.

**Data Flow**:
```
Input: Docker image, resource limits, task setup scripts
  ↓
Create and start container
  ↓
Execute commands via docker exec_run
  ↓
Capture stdout, stderr, exit code
  ↓
Run test script to verify task completion
  ↓
Stop and remove container
  ↓
Output: TerminalCommand results
```

**Key Features**:
- Resource isolation (CPU, memory limits)
- Network isolation (optional)
- File operations (read, write, list)
- Test script execution

### 3. Terminal Agent (`agent.py`)

**Purpose**: LLM-powered agent that solves terminal tasks.

**Data Flow**:
```
Input: TerminalTask
  ↓
Build system prompt + task prompt
  ↓
Agent Loop (max_iterations):
  ├── Get LLM response
  ├── Parse action (EXECUTE, READ_FILE, WRITE_FILE, LIST_DIR, TASK_COMPLETE)
  ├── Execute action in terminal environment
  └── Add result to conversation history
  ↓
Run test script
  ↓
Output: TerminalBenchResult
```

**Action Format**:
```
ACTION: EXECUTE
COMMAND: <shell command>

ACTION: READ_FILE
PATH: <file path>

ACTION: WRITE_FILE
PATH: <file path>
CONTENT: |
<file content>

ACTION: TASK_COMPLETE
```

### 4. Evaluator (`evaluator.py`)

**Purpose**: Calculates metrics and generates reports.

**Metrics Calculated**:
- Overall accuracy
- Accuracy by category
- Accuracy by difficulty
- Average commands per task
- Token usage
- Error categorization
- Leaderboard comparison

### 5. Runner (`runner.py`)

**Purpose**: Orchestrates the full benchmark pipeline.

**Flow**:
```
1. Setup: Load dataset, create output directory
2. Filter tasks (by category, difficulty, IDs)
3. For each task:
   a. Create TerminalAgent with fresh TerminalEnvironment
   b. Agent solves task
   c. Collect result
4. Calculate metrics
5. Generate reports (JSON, Markdown)
6. Save session logs
```

## ElizaOS Integration

### Integration Points

The benchmark integrates with ElizaOS at the **model access level**, not as a full plugin with Actions/Providers/Evaluators. This is intentional:

1. **Benchmark Purpose**: We're testing terminal capabilities, not registering new agent behaviors
2. **Consistency**: Same pattern as GAIA and other benchmarks in the codebase
3. **Flexibility**: Can run standalone OR with ElizaOS runtime

### Standalone Mode (No Runtime)

```python
agent = TerminalAgent(
    runtime=None,  # No runtime
    max_iterations=20,
    model_name="gpt-4",
)
result = await agent.solve_task(task)
```

Uses direct OpenAI API calls via httpx:
```python
async with httpx.AsyncClient() as client:
    response = await client.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json={"model": model_name, "messages": conversation_history, ...}
    )
```

### ElizaOS Runtime Mode

```python
from elizaos.runtime import AgentRuntime
from elizaos_plugin_openai import get_openai_plugin

runtime = AgentRuntime(plugins=[get_openai_plugin()])
await runtime.initialize()

agent = TerminalAgent(runtime=runtime)
result = await agent.solve_task(task)
```

Uses runtime's model system:
```python
result = await self.runtime.use_model(
    ModelType.TEXT_LARGE,
    {
        "messages": self._conversation_history,
        "temperature": self.temperature,
        "max_tokens": 2000,
    },
)
```

### Why Not Actions/Providers/Evaluators?

ElizaOS components serve different purposes:

| Component | Purpose | Why Not Used Here |
|-----------|---------|-------------------|
| **Actions** | Agent behaviors triggered by conversation | Benchmark runs automated, not conversational |
| **Providers** | State/context providers for prompts | Agent has its own terminal state |
| **Evaluators** | Evaluate agent responses in conversation | We use test scripts for verification |
| **Services** | Background services | Not needed for benchmarking |

The benchmark could be wrapped as a plugin for automated execution, but the core evaluation logic remains standalone.

## Potential Issues

### 1. Docker Not Available
- **Symptom**: `TerminalEnvironmentError: Failed to connect to Docker`
- **Cause**: Docker daemon not running or not installed
- **Solution**: Start Docker daemon: `docker info`

### 2. API Key Missing
- **Symptom**: `ValueError: OPENAI_API_KEY environment variable required`
- **Cause**: No API key in environment
- **Solution**: `export OPENAI_API_KEY=sk-...`

### 3. Runtime Model Handler Not Found
- **Symptom**: `RuntimeError: No model handler registered for: TEXT_LARGE`
- **Cause**: No plugin providing model handlers
- **Solution**: Initialize runtime with OpenAI plugin:
  ```python
  from elizaos_plugin_openai import get_openai_plugin
  runtime = AgentRuntime(plugins=[get_openai_plugin()])
  ```

### 4. Task Timeout
- **Symptom**: `Task timed out after X seconds`
- **Cause**: Task takes too long or agent loops
- **Solution**: Increase timeout or check task complexity

### 5. Test Script Failures
- **Symptom**: Tasks fail despite agent completing work
- **Cause**: Test script logic doesn't match expected state
- **Solution**: Check test_script in task definition

### 6. Container Resource Limits
- **Symptom**: Commands fail with out-of-memory errors
- **Cause**: Default memory limit (2GB) too low
- **Solution**: Increase `memory_limit` in config

## Testing Flow

### Unit Tests
```bash
pytest tests/ -v -m "not docker"  # 81 tests, no Docker required
```

### Integration Tests
```bash
python scripts/test_integration.py  # Tests all components including Docker
```

### LLM Tests (Requires API Key)
```bash
export OPENAI_API_KEY=sk-...
python scripts/test_with_llm.py
```

### Full Benchmark
```bash
export OPENAI_API_KEY=sk-...
terminal-bench --sample --verbose
```

## Report Output

### JSON Report Structure
```json
{
  "metadata": {"version": "2.0", "model": "gpt-4", "timestamp": "..."},
  "summary": {
    "total_tasks": 5,
    "passed_tasks": 3,
    "accuracy": 0.6,
    "total_commands": 25,
    "total_tokens": 5000
  },
  "leaderboard_comparison": {
    "our_score": 60.0,
    "rank": 5,
    "percentile": 50.0
  },
  "by_category": {...},
  "by_difficulty": {...},
  "results": [...]
}
```

### Leaderboard Comparison (December 2025)

| Rank | Agent | Score |
|------|-------|-------|
| 1 | Droid (Factory) + GPT-5.2 | 64.9% |
| 2 | Ante + Gemini 3 Pro | 64.7% |
| 3 | Junie CLI + Gemini 3 Flash | 64.3% |
| 4 | Claude Code + Claude 3.5 Sonnet | 58.2% |
| 5 | OpenHands + GPT-4o | 52.8% |
| 6 | Aider + Claude 3.5 Sonnet | 47.5% |
| 7 | GPT-4 (baseline) | 28.3% |
| - | Human Expert | 92.5% |

**Target**: Achieve >50% accuracy to compete with mid-tier agents.

## Performance Optimization Tips

1. **Use faster models** for simpler tasks: `--model gpt-3.5-turbo`
2. **Reduce iterations** for easy tasks: `--max-iterations 10`
3. **Filter by difficulty**: `--difficulties easy medium`
4. **Parallel execution** (planned): Run multiple tasks concurrently
5. **Cache Docker images**: Pull images before benchmark run
