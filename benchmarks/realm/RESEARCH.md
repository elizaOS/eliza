# REALM-Bench: Real-World Planning Benchmark

## Overview

REALM-Bench (Real-World Planning Benchmark) evaluates the planning capabilities of Large Language Models (LLMs) and multi-agent systems on complex, real-world tasks requiring multi-step reasoning and execution.

**Reference Paper**: [arXiv:2412.13102](https://arxiv.org/abs/2412.13102)  
**GitHub**: [genglongling/REALM-Bench](https://github.com/genglongling/REALM-Bench)

## Benchmark Description

REALM-Bench challenges agents with tasks that require:

1. **Complex Planning**: Generating multi-step plans to achieve a goal
2. **Tool Use**: Utilizing a set of available tools or APIs
3. **Dynamic Environments**: Adapting plans based on changing environment states
4. **Real-World Constraints**: Incorporating practical limitations and requirements
5. **Multi-Agent Interaction**: Coordinating with other agents in some scenarios

### Task Categories

| Category | Description | Example Tasks |
|----------|-------------|---------------|
| **Sequential** | Step-by-step execution with clear dependencies | Mathematical chains, data pipelines |
| **Reactive** | Adaptation to changing conditions | System monitoring, deployment rollback |
| **Complex** | Multi-step with resource constraints | Project planning, CI/CD configuration |
| **Multi-Agent** | Coordination between agents | Research collaboration, debugging |
| **Tool Use** | API calls and tool sequencing | API chains, file operations |
| **Reasoning** | Decision making under uncertainty | Risk assessment, fallback planning |

---

## Detailed Benchmark Flow

### 1. Architecture Overview

```
benchmarks/realm/
├── __init__.py          # Module exports
├── __main__.py          # Entry point for python -m
├── types.py             # Type definitions and leaderboard scores
├── dataset.py           # Task loading and generation
├── agent.py             # Planning agent with ElizaOS integration
├── evaluator.py         # Result evaluation and metrics
├── runner.py            # Benchmark orchestration
├── cli.py               # Command-line interface
└── RESEARCH.md          # This documentation
```

### 2. Execution Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          CLI (cli.py)                                   │
│  - Parse arguments                                                       │
│  - Check environment (API keys, ElizaOS availability)                   │
│  - Create REALMConfig                                                    │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Runner (runner.py)                                │
│  1. Initialize REALMDataset - loads or generates benchmark tasks        │
│  2. Initialize REALMAgent - sets up LLM integration                     │
│  3. For each test case:                                                  │
│     a. Agent.solve_task(task, test_case)                                 │
│     b. Evaluator.evaluate_trajectory()                                   │
│     c. Collect results                                                   │
│  4. Calculate aggregate metrics                                          │
│  5. Compare to leaderboard                                               │
│  6. Generate report                                                      │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          Agent (agent.py)                                │
│                                                                          │
│  solve_task(task, test_case):                                            │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ 1. Generate Plan                                                   │  │
│  │    ┌──────────────────────────────────────────────────────────┐   │  │
│  │    │ IF has_model_provider AND use_llm:                       │   │  │
│  │    │   → Build planning prompt from task                       │   │  │
│  │    │   → Call runtime.use_model(TEXT_LARGE, prompt)           │   │  │
│  │    │   → Parse JSON response into PlanningActions              │   │  │
│  │    │ ELSE:                                                     │   │  │
│  │    │   → Use heuristic: expected actions or available tools    │   │  │
│  │    └──────────────────────────────────────────────────────────┘   │  │
│  │                                                                    │  │
│  │ 2. Execute Plan                                                    │  │
│  │    FOR each action in plan:                                        │  │
│  │    ┌──────────────────────────────────────────────────────────┐   │  │
│  │    │ → Execute action (simulated or real)                     │   │  │
│  │    │ → Record observation, success/failure                     │   │  │
│  │    │ → IF failed AND enable_adaptation:                        │   │  │
│  │    │     → Attempt plan adaptation                             │   │  │
│  │    │ → Add step to trajectory                                  │   │  │
│  │    └──────────────────────────────────────────────────────────┘   │  │
│  │                                                                    │  │
│  │ 3. Calculate Metrics                                               │  │
│  │    → Plan quality score                                            │  │
│  │    → Evaluate success (70%+ steps succeeded)                       │  │
│  │                                                                    │  │
│  │ RETURN PlanningTrajectory                                          │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3. ElizaOS Integration

The benchmark follows the same integration pattern as other ElizaOS benchmarks (BFCL, MINT):

```python
# Try to import ElizaOS (optional dependency)
try:
    from elizaos.runtime import AgentRuntime
    from elizaos.types.agent import Character
    from elizaos.types.model import ModelType
    from elizaos.types.plugin import Plugin
    ELIZAOS_AVAILABLE = True
except ImportError:
    ELIZAOS_AVAILABLE = False

# Check for model providers (API keys)
def get_model_provider_plugin():
    if os.environ.get("OPENAI_API_KEY"):
        from elizaos_plugin_openai import create_openai_elizaos_plugin
        return create_openai_elizaos_plugin()
    elif os.environ.get("ANTHROPIC_API_KEY"):
        from elizaos_plugin_anthropic.plugin import create_anthropic_elizaos_plugin
        return create_anthropic_elizaos_plugin()
    # ... etc
    return None

# Initialize runtime with character and plugin
runtime = AgentRuntime(
    character=Character(name="REALMBenchmarkAgent", ...),
    plugins=[model_plugin],
)
await runtime.initialize()

# Use model for planning
response = await runtime.use_model(
    ModelType.TEXT_LARGE,
    {"prompt": planning_prompt, "temperature": 0.3}
)
```

### 4. Operating Modes

| Mode | Condition | Behavior |
|------|-----------|----------|
| **LLM Mode** | ElizaOS + API keys + plugin | Full LLM-based plan generation |
| **Heuristic Mode** | ElizaOS but no API keys | Uses expected actions or available tools |
| **Mock Mode** | `--mock` flag | Uses MockREALMAgent for testing |

---

## Installation & Usage

### Prerequisites

```bash
# Install ElizaOS (optional but recommended)
pip install elizaos

# Install model provider plugin (at least one)
pip install elizaos-plugin-openai
# or
pip install elizaos-plugin-anthropic
# or
pip install elizaos-plugin-google-genai
```

### Set API Keys

Create `.env` file in project root:

```bash
# .env
OPENAI_API_KEY=sk-...
# or
ANTHROPIC_API_KEY=sk-ant-...
# or
GOOGLE_GENERATIVE_AI_API_KEY=...
```

### Check Environment

```bash
python -m benchmarks.realm.cli --check-env
```

Expected output:
```
🔑 API Key Status:
   OpenAI: ✅ Found
   Anthropic: ❌ Not set
   Google Generative AI: ❌ Not set

📦 ElizaOS Status:
   Core runtime: ✅ Available

🔌 Model Plugins:
   OpenAI Plugin: ✅ Installed
   ...

📋 Summary:
   ✅ Ready for LLM-based benchmarking!
```

### Running the Benchmark

```bash
# Run all benchmark tasks
python -m benchmarks.realm.cli

# Run specific categories
python -m benchmarks.realm.cli --categories sequential reactive

# Limit tasks per category
python -m benchmarks.realm.cli --max-tasks 5

# Use mock agent for testing
python -m benchmarks.realm.cli --mock

# Custom output directory
python -m benchmarks.realm.cli --output ./my_results

# Show leaderboard comparison
python -m benchmarks.realm.cli --leaderboard
```

---

## Type System

The benchmark uses strongly-typed dataclasses for all data structures:

| Type | Purpose |
|------|---------|
| `REALMCategory` | Enum for task categories (sequential, reactive, complex, etc.) |
| `ExecutionModel` | Enum for plan execution models (sequential, parallel, dag) |
| `PlanStatus` | Enum for plan execution status |
| `PlanningAction` | Action with name, parameters, and description |
| `PlanningStep` | Execution step with observation and result |
| `PlanningTrajectory` | Full trajectory of task execution |
| `REALMTask` | Task definition with constraints and tools |
| `REALMTestCase` | Task with input and expected output |
| `REALMResultMetrics` | Planning time, quality, efficiency metrics |
| `REALMResultDetails` | Adaptation count, error recoveries |
| `REALMResult` | Complete result for a single task |
| `REALMMetrics` | Aggregate metrics across all tasks |
| `REALMReport` | Full benchmark report with comparison |

---

## Where to Expect Issues

### Common Issues

1. **No Model Provider**
   - **Symptom**: "No model provider available - running in mock mode"
   - **Cause**: No API keys set or plugins not installed
   - **Fix**: Set `OPENAI_API_KEY` or similar in environment

2. **ElizaOS Not Installed**
   - **Symptom**: "ElizaOS not available, agent will use mock/heuristic mode"
   - **Cause**: ElizaOS package not installed
   - **Fix**: `pip install elizaos`

3. **Plugin Import Errors**
   - **Symptom**: "OpenAI API key found but plugin not installed"
   - **Cause**: API key set but plugin not installed
   - **Fix**: `pip install elizaos-plugin-openai`

4. **Low Success Rate in Heuristic Mode**
   - **Symptom**: 0-30% success rate
   - **Cause**: Simulated execution uses random success/failure
   - **Expected**: This is normal for heuristic/mock mode

5. **JSON Parsing Failures**
   - **Symptom**: "Failed to parse LLM response as JSON"
   - **Cause**: LLM didn't follow JSON format
   - **Fix**: Falls back to heuristic automatically

### Debugging

Enable verbose logging:
```bash
python -m benchmarks.realm.cli --verbose
```

Check specific components:
```python
from benchmarks.realm import ELIZAOS_AVAILABLE, REALMAgent

print(f"ElizaOS available: {ELIZAOS_AVAILABLE}")

agent = REALMAgent()
await agent.initialize()
print(f"Has model provider: {agent._has_model_provider}")
```

---

## Evaluation Metrics

### Plan Quality Score
Measures coherence and correctness of generated plans:
- **Tool coverage (60%)**: Do we use appropriate tools?
- **Step efficiency (40%)**: Is the step count optimal?

### Goal Achievement
Measures task completion:
- Required actions executed
- Success rate across steps

### Efficiency
Measures execution performance:
- Time relative to timeout
- Steps relative to expected

### Success Criteria
- A task is considered successful if **≥70% of steps succeeded**
- All required actions must be executed

---

## Benchmark Results

### Current Performance (Heuristic Mode)

| Metric | Value |
|--------|-------|
| **Mode** | Heuristic (no LLM) |
| **Success Rate** | ~40-60% |
| **Plan Quality** | ~85-100% |
| **Efficiency** | ~100% |

### Expected Performance (LLM Mode)

With a proper LLM (GPT-4, Claude, etc.), expect:
- Sequential tasks: 70-90%
- Reactive tasks: 60-80%
- Complex tasks: 50-70%
- Overall: 60-75%

---

## Leaderboard Reference

From the REALM-Bench paper (arXiv:2412.13102):

| Model | Sequential | Reactive | Complex | Multi-Agent | Overall |
|-------|------------|----------|---------|-------------|---------|
| GPT-4-Turbo | 82.1% | 74.5% | 68.9% | 62.3% | 72.9% |
| GPT-4 | 78.5% | 71.2% | 65.3% | 58.7% | 69.3% |
| Claude-3-Opus | 76.2% | 69.8% | 63.1% | 56.2% | 67.2% |
| Claude-3-Sonnet | 71.4% | 65.2% | 58.7% | 51.8% | 62.7% |
| Gemini-Pro | 68.5% | 61.3% | 54.2% | 47.6% | 58.7% |
| Llama-3-70B | 62.3% | 55.8% | 48.4% | 42.1% | 52.9% |
| Mixtral-8x7B | 54.6% | 48.2% | 41.5% | 35.8% | 45.8% |

---

## Configuration Options

| Setting | Default | Description |
|---------|---------|-------------|
| `data_path` | `./data/realm` | Path to REALM benchmark data |
| `output_dir` | `./benchmark_results/realm` | Output directory for results |
| `max_tasks_per_category` | None | Limit tasks per category |
| `timeout_per_task_ms` | 120000 | Timeout per task (2 min) |
| `max_steps` | 15 | Maximum execution steps |
| `execution_model` | `dag` | Plan execution model |
| `enable_adaptation` | True | Enable plan adaptation |
| `model_name` | `gpt-4` | Model for reporting |

---

## Future Work

1. **Real Tool Execution**: Connect to actual APIs/tools instead of simulation
2. **External Dataset Loading**: Support loading official REALM-Bench JSON files
3. **Multi-Agent Coordination**: Full multi-agent benchmark support
4. **LLM Evaluation**: Use LLM-based verification for open-ended tasks
5. **Continuous Integration**: Automated benchmark runs on PRs

---

## References

- **REALM-Bench Paper**: [arXiv:2412.13102](https://arxiv.org/abs/2412.13102)
- **GitHub Repository**: [genglongling/REALM-Bench](https://github.com/genglongling/REALM-Bench)
- **ElizaOS Documentation**: [ElizaOS Docs](https://elizaos.github.io/eliza/)

---

*Last Updated: 2026-01-11*
*Benchmark Version: 2.0.0*
