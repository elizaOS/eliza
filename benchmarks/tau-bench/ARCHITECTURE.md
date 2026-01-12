# Tau-bench Architecture & Flow Documentation

## Overview

The Tau-bench benchmark evaluates LLM agents' ability to use tools in real-world customer service scenarios. This document provides a detailed flow of how the benchmark works, how ElizaOS integration functions, and where potential issues may arise.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              CLI (cli.py)                                │
│  - Parses arguments (--sample, --trials, --real-llm, --temperature)      │
│  - Creates TauBenchConfig                                                │
│  - Invokes TauBenchRunner                                                │
└─────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          TauBenchRunner (runner.py)                      │
│  - Loads dataset (TauBenchDataset)                                       │
│  - Creates environments for each domain                                  │
│  - Runs tasks with multiple trials (for Pass^k)                          │
│  - Generates TauBenchReport                                              │
└─────────────────────────────────────────────────────────────────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
        ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
        │ RetailEnv     │  │ AirlineEnv    │  │ Future Envs   │
        │ - 15 tools    │  │ - 9 tools     │  │ (extensible)  │
        │ - 4 policies  │  │ - 4 policies  │  │               │
        └───────────────┘  └───────────────┘  └───────────────┘
                    │                │
                    └────────┬───────┘
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          ToolExecutor (executor.py)                      │
│  - Registers tool definitions from environment                           │
│  - Validates tool call parameters against schema                         │
│  - Dispatches calls to environment handlers                              │
│  - Returns results with status (CORRECT, WRONG_TOOL, WRONG_PARAMS, etc.)│
└─────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       Agent (eliza_agent.py)                             │
│                                                                          │
│  ┌─────────────────┐    ┌─────────────────────────────────────────┐     │
│  │  MockTauAgent   │    │         ElizaOSTauAgent                 │     │
│  │  - Uses expected│    │  - Imports elizaos.runtime.AgentRuntime │     │
│  │    tool calls   │    │  - Auto-detects model provider          │     │
│  │  - For testing  │    │    (OpenAI, Anthropic, Google, Ollama)  │     │
│  └─────────────────┘    │  - Calls runtime.generate_text()        │     │
│                         │  - Parses tool calls from response      │     │
│                         └─────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       TauBenchEvaluator (evaluator.py)                   │
│  - Compares expected vs actual tool calls                                │
│  - Calculates tool accuracy, parameter accuracy                          │
│  - Evaluates response quality (word overlap or LLM judge)               │
│  - Checks policy compliance                                              │
│  - Computes Pass^k metrics                                               │
│  - Compares to leaderboard scores                                        │
└─────────────────────────────────────────────────────────────────────────┘
```

## Detailed Component Flows

### 1. Dataset Loading Flow

```
TauBenchDataset.load()
    │
    ├── Search for domain directories (retail/, airline/)
    │   └── Load tasks.json files
    │
    ├── Validate task data (_validate_task_data)
    │   ├── Check required: task_id, user_instruction
    │   ├── Check tool definitions have 'name' field
    │   └── Check expected_tool_calls have tool_name
    │
    └── Parse task (_parse_task)
        ├── Parse ToolDefinitions
        ├── Parse expected ToolCalls
        ├── Parse PolicyConstraints
        └── Return TauBenchTask
```

### 2. Task Execution Flow

```
TauBenchRunner._run_task(task, trial_number)
    │
    ├── Create DomainEnvironment (Retail or Airline)
    │   └── environment.initialize() → Sets up mock data
    │
    ├── Create ToolExecutor
    │   └── Register available tools from environment
    │
    ├── Create Agent (Mock or ElizaOS)
    │   └── agent.initialize() → Connect to LLM if real mode
    │
    ├── agent.process_task(task) [with timeout]
    │   │
    │   ├── Build system prompt with tools and policies
    │   │
    │   └── Agent Loop (max_turns):
    │       ├── Generate response (LLM or mock)
    │       ├── Extract tool call from response
    │       │   └── Parse [TOOL_CALL]...[/TOOL_CALL] format
    │       ├── If tool call found:
    │       │   ├── executor.execute(tool_call)
    │       │   ├── Add to conversation
    │       │   └── Continue loop
    │       └── If no tool call: final response, break
    │
    ├── environment.check_policy_compliance()
    │   └── Returns list of violation descriptions
    │
    ├── environment.check_goal_achieved()
    │   └── Checks success_criteria against state
    │
    └── evaluator.evaluate_task() → TauBenchResult
```

### 3. ElizaOS Integration Flow

```
ElizaOSTauAgent.initialize()
    │
    ├── Check ELIZAOS_AVAILABLE (imported successfully?)
    │
    ├── get_model_provider_plugin()
    │   ├── Check OPENAI_API_KEY → create_openai_elizaos_plugin()
    │   ├── Check ANTHROPIC_API_KEY → create_anthropic_elizaos_plugin()
    │   ├── Check GOOGLE_GENERATIVE_AI_API_KEY → create_google_elizaos_plugin()
    │   └── Try Ollama (local) → create_ollama_elizaos_plugin()
    │
    ├── Create AgentRuntime with Character
    │   └── Character includes system prompt for tool calling
    │
    └── runtime.initialize()
        └── Registers model handlers from plugin
```

### 4. Evaluation Flow

```
TauBenchEvaluator.evaluate_task()
    │
    ├── _evaluate_tool_calls(expected, actual)
    │   ├── Match tool names (selection accuracy)
    │   ├── Compare parameters (_params_match)
    │   ├── Penalize extra calls
    │   └── Return tool_accuracy, selection_accuracy, parameter_accuracy
    │
    ├── _evaluate_response(expected, actual)
    │   ├── If use_llm_judge: call runtime for judgment
    │   └── Else: word overlap + key phrase matching
    │
    ├── Calculate policy_compliance
    │   └── 1.0 - (violations / total_constraints)
    │
    └── Determine success:
        tool_accuracy >= 0.7 AND
        response_quality >= 0.5 AND
        policy_compliance >= 0.9 AND
        goal_achieved
```

### 5. Pass^k Calculation

```
PassKMetrics.calculate(results, k)
    │
    ├── Group results by task_id
    │
    └── For each task:
        ├── Take first k trials
        ├── Task passes if ALL k trials succeeded
        └── pass_rate = passed_tasks / total_tasks
```

## Configuration Options

| Option | CLI Flag | Default | Description |
|--------|----------|---------|-------------|
| use_mock | --real-llm (inverse) | True | Use mock agent (no LLM calls) |
| temperature | --temperature | 0.0 | LLM temperature |
| num_trials | --trials | 1 | Trials per task for Pass^k |
| max_turns_per_task | --max-turns | 15 | Max conversation turns |
| timeout_ms | --timeout | 120000 | Timeout per task |

## Potential Issues & Debugging

### 1. ElizaOS Import Failures
**Symptom**: `ELIZAOS_AVAILABLE = False`
**Cause**: elizaos package not installed or import error
**Debug**: Run `python -c "from elizaos.runtime import AgentRuntime"`
**Fix**: Install elizaos package or check Python path

### 2. No Model Provider Available
**Symptom**: "No model provider plugin available" warning
**Cause**: No API keys in environment, plugins not installed
**Debug**: Check `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.
**Fix**: Set API key in .env or install Ollama locally

### 3. Tool Call Parsing Failures
**Symptom**: Agent doesn't extract tool calls
**Cause**: LLM not using `[TOOL_CALL]...[/TOOL_CALL]` format
**Debug**: Check agent response in logs
**Fix**: Improve system prompt or use different model

### 4. Low Success Rate
**Symptom**: Pass^1 much lower than expected
**Cause**: Wrong tool selection, parameter extraction, or policy violations
**Debug**: Check tau-bench-detailed.json for per-task breakdown
**Fix**: Review evaluator thresholds, check tool definitions

### 5. Timeout Errors
**Symptom**: Tasks failing with "Task timed out"
**Cause**: LLM too slow or conversation loop not terminating
**Debug**: Increase timeout, reduce max_turns
**Fix**: `--timeout 300000` or `--max-turns 10`

## Testing Without LLM

The benchmark works fully in mock mode for testing infrastructure:

```bash
# Run with sample tasks in mock mode (default)
python -m elizaos_tau_bench --sample --trials 4

# Run full benchmark with real data
python -m elizaos_tau_bench --all --trials 8
```

## Testing With Real LLM

```bash
# Set API key
export OPENAI_API_KEY="sk-..."

# Run with real LLM
python -m elizaos_tau_bench --sample --trials 4 --real-llm --temperature 0.0

# Force specific provider
python -m elizaos_tau_bench --sample --real-llm --model-provider anthropic
```

## Output Files

| File | Content |
|------|---------|
| tau-bench-results.json | Main results with metrics |
| tau-bench-summary.md | Human-readable summary |
| tau-bench-detailed.json | Per-task breakdown (if --no-details not set) |

## Metrics Explained

| Metric | Description |
|--------|-------------|
| Pass^k | Probability of ALL k trials succeeding (reliability) |
| Tool Accuracy | Combined selection + parameter accuracy |
| Policy Compliance | 1 - (violations / constraints) |
| Response Quality | Word overlap with ground truth or LLM judgment |
| Goal Achieved | Success criteria met based on environment state |
