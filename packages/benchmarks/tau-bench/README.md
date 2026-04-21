# ElizaOS Tau-bench Benchmark

A comprehensive implementation of the **τ-bench (Tau-bench)** benchmark for evaluating ElizaOS agents on real-world tool-augmented customer service tasks.

## Overview

Tau-bench evaluates LLMs' ability to effectively utilize tools in realistic customer service scenarios across multiple domains:

- **Retail Domain**: E-commerce customer support (orders, returns, refunds)
- **Airline Domain**: Flight booking and management (reservations, changes, cancellations)

### Key Metrics

- **Pass^k**: Reliability metric measuring success across k independent trials (key innovation from the original paper)
- **Tool Selection Accuracy**: Correct tool selection and parameter extraction
- **Policy Compliance**: Adherence to domain-specific business rules
- **Response Quality**: Helpfulness and accuracy of final responses

## Installation

```bash
# From the benchmark directory
cd benchmarks/tau-bench/python

# Install in development mode
pip install -e ".[dev]"

# Or just install dependencies
pip install -e .
```

## Quick Start

### Run with Sample Tasks (No External Data Required)

```bash
# Run all domains with sample tasks
python -m elizaos_tau_bench --sample

# Run specific domain
python -m elizaos_tau_bench --sample --domain retail

# Run with multiple trials for Pass^k evaluation
python -m elizaos_tau_bench --sample --trials 8
```

### Run with a Real LLM (ElizaOS Runtime)

The Python benchmark currently supports the **OpenAI** model provider via the `elizaos-plugin-openai` package.

```bash
cd benchmarks/tau-bench/python

# Install benchmark deps
pip install -e ".[dev]"

# Install OpenAI provider plugin (from this monorepo)
pip install -e ../../../plugins/plugin-openai/python

# (Recommended) Install trajectory logger plugin (from this monorepo)
# This captures full end-to-end ElizaOS trajectories and exports them for training.
pip install -e ../../../plugins/plugin-trajectory-logger/python

# Provide credentials
export OPENAI_API_KEY="..."

# Optional: choose models (defaults are gpt-5 / gpt-5-mini)
export OPENAI_SMALL_MODEL="gpt-5-mini"
export OPENAI_LARGE_MODEL="gpt-5-mini"

# Run full dataset with real LLM
python -m elizaos_tau_bench --all --real-llm --trials 1
```

### Trajectory Logging (ART / GRPO)

When running with `--real-llm`, tau-bench exports trajectories compatible with the training system (OpenPipe ART / GRPO).

- **ART JSONL**: `OUTPUT/trajectories/trajectories.art.jsonl`
- **GRPO groups**: `OUTPUT/trajectories/trajectories.grpo.groups.json`

```bash
# Default: trajectories enabled in real-llm mode (ART)
python -m elizaos_tau_bench --all --real-llm --output ./results/tau-bench-run

# Disable explicitly
python -m elizaos_tau_bench --all --real-llm --no-trajectories

# Export in GRPO grouped format (best for RL training rollouts)
python -m elizaos_tau_bench --all --real-llm --trajectory-format grpo
```

### Run with Custom Data

```bash
# Run with benchmark data
python -m elizaos_tau_bench --all --data-path ./benchmark-data/tau-bench

# Run specific domain with verbose output
python -m elizaos_tau_bench --domain airline --verbose

# Run with custom output directory
python -m elizaos_tau_bench --all --output ./results/tau-bench-2026
```

## CLI Options

```
Usage: python -m elizaos_tau_bench [OPTIONS]

Options:
  --all                 Run all domains (retail + airline)
  --domain {retail,airline}
                        Run specific domain only
  --sample              Use built-in sample tasks
  --data-path PATH      Path to benchmark data directory
  --output PATH         Output directory for results
  --trials N            Number of trials per task (for Pass^k)
  --max-tasks N         Maximum tasks per domain
  --max-turns N         Maximum turns per task
  --timeout MS          Timeout per task in milliseconds
  --difficulty {easy,medium,hard}
                        Filter by task difficulty
  --verbose             Enable verbose output
  --json                Output results as JSON to stdout
  --llm-judge           Use LLM to evaluate response quality
  --real-llm            Use real LLM via ElizaOS runtime (default: mock agent)
  --temperature FLOAT   Temperature for model calls (provider-dependent)
  --model-provider STR  Provider selection (Python: openai)
  --trajectories        Enable trajectory logging + export (requires elizaos-plugin-trajectory-logger)
  --no-trajectories     Disable trajectory logging
  --trajectory-format {art,grpo}
                        Export format for trajectories
```

## Benchmark Data Format

Tasks are defined in JSON format:

```json
{
  "task_id": "retail_001",
  "domain": "retail",
  "user_instruction": "I want to return my order #ORD-12345",
  "user_profile": "Customer: John Smith, Gold member",
  "user_goal": "Successfully initiate a return",
  "difficulty": "easy",
  "expected_tool_calls": [
    {"tool_name": "get_order_details", "arguments": {"order_id": "ORD-12345"}},
    {"tool_name": "initiate_return", "arguments": {"order_id": "ORD-12345"}}
  ],
  "policy_constraints": [
    {"policy_id": "RETURN_WINDOW", "description": "Returns within 30 days"}
  ],
  "success_criteria": ["return_initiated"],
  "ground_truth_response": "Return initiated. You'll receive a return label via email."
}
```

## Output

Results are saved to the output directory:

- `tau-bench-results.json` - Main benchmark results with metrics
- `tau-bench-summary.md` - Human-readable markdown summary
- `tau-bench-detailed.json` - Per-task detailed results (if `--save-details`)

### Sample Output

```
╔═══════════════════════════════════════════════════════════════════════╗
║                  ElizaOS Tau-bench Benchmark Runner                   ║
╚═══════════════════════════════════════════════════════════════════════╝

📋 Configuration:
   Domains: retail, airline
   Trials per Task: 8
   Max Tasks: unlimited

🚀 Starting Tau-bench evaluation...

📊 TAU-BENCH RESULTS SUMMARY
======================================================================

🎯 Overall Performance:
   Status: PARTIAL
   Success Rate: 62.5%
   Total Tasks: 16 (128 trials)

📈 Pass^k Reliability:
   Pass^1: 68.8%
   Pass^2: 56.3%
   Pass^4: 43.8%
   Pass^8: 31.3%

⚡ Performance Metrics:
   Tool Accuracy: 78.5%
   Policy Compliance: 94.2%
   Response Quality: 71.3%

🏆 Leaderboard Comparison:
   Closest Model: gpt-5
   Difference: +8.5% better

✅ Tau-bench evaluation completed successfully!
```

## Pass^k Metric

The **Pass^k** metric is the key innovation from the original τ-bench paper. It measures the probability that an agent successfully completes a task in **ALL** of k independent trials.

- **Pass^1**: Standard success rate (probability of success on first try)
- **Pass^k**: Probability of succeeding in all k trials consecutively

This metric captures **reliability and consistency**, which is critical for production deployments. Even state-of-the-art models like GPT-4o show significant drops from Pass^1 to Pass^8.

## Leaderboard Comparison

The benchmark compares results against published scores from the official leaderboard:

| Model | Retail Pass^1 | Airline Pass^1 |
|-------|---------------|----------------|
| Gemini 3 Pro | 90.7% | 89.2% |
| Claude 3.7 Sonnet | 81.2% | 79.8% |
| Kimi K2 | 74.3% | 72.1% |
| o3 | 73.9% | 71.5% |
| o4-mini | 71.8% | 69.5% |
| GPT-4o | 48.5% | 46.2% |

## Running Tests

```bash
# Install test dependencies
pip install -e ".[dev]"

# Run all tests
pytest tests/

# Run with coverage
pytest tests/ --cov=elizaos_tau_bench --cov-report=html

# Run specific test file
pytest tests/test_environments.py -v

# Run integration tests only
pytest tests/test_integration.py -v
```

## Architecture

```
elizaos_tau_bench/
├── __init__.py           # Package exports
├── constants.py          # Leaderboard baselines (reference)
├── types.py              # Core type definitions
├── dataset.py            # Task loading and management
├── agent.py              # Legacy mock agent (kept for reference)
├── eliza_agent.py        # Real LLM agent integration (ElizaOS runtime)
├── executor.py           # Tool execution engine
├── evaluator.py          # Result evaluation and Pass^k
├── runner.py             # Benchmark runner
├── cli.py                # Command-line interface
└── environments/
    ├── base.py           # Abstract environment
    ├── retail.py         # Retail domain simulator
    └── airline.py        # Airline domain simulator
```

## References

- **Official τ-bench Repository**: https://github.com/sierra-research/tau-bench
- **Paper**: "τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains" (2024)
- **Sierra Research**: https://sierra.ai/resources/research/tau-bench

## License

MIT License - See [LICENSE](../../../LICENSE) for details.
