# Mind2Web Benchmark for ElizaOS

Web agent benchmark based on [OSU-NLP-Group/Mind2Web](https://github.com/OSU-NLP-Group/Mind2Web).

Evaluates ElizaOS agents on real-world web navigation and interaction tasks.

## Features

- **Canonical ElizaOS Integration**: Uses `runtime.message_service.handle_message()` for the full agent loop
- **Multiple Model Providers**: Groq (fast/cheap), OpenAI, Anthropic
- **Comprehensive Metrics**: Task success, step accuracy, element accuracy, operation accuracy
- **Multiple Splits**: Cross-Task, Cross-Website, Cross-Domain evaluation

## Quick Start

### Run with Sample Tasks (No API Key Required)

```bash
# From repo root
python -m benchmarks.mind2web --sample
```

### Run with Groq (Fast and Cheap)

```bash
# Set your Groq API key
export GROQ_API_KEY=your_key_here

# Run benchmark
python -m benchmarks.mind2web --sample --real-llm --provider groq
```

### Run with OpenAI

```bash
export OPENAI_API_KEY=your_key_here
python -m benchmarks.mind2web --sample --real-llm --provider openai
```

### Run Full Benchmark from HuggingFace

```bash
# Install datasets package
pip install datasets

# Run with HuggingFace data
python -m benchmarks.mind2web --hf --real-llm --max-tasks 50
```

## CLI Options

```
Usage: python -m benchmarks.mind2web [OPTIONS]

Data Source:
  --sample              Use built-in sample tasks (default)
  --hf                  Load from HuggingFace (requires datasets package)
  --split SPLIT         Dataset split: train, test_task, test_website, test_domain

Task Selection:
  --max-tasks N         Maximum tasks to run
  --trials N            Trials per task (default: 1)
  --max-steps N         Maximum steps per task (default: 20)

Model Configuration:
  --real-llm            Use real LLM via ElizaOS (requires API key)
  --provider PROVIDER   groq, openai, anthropic, or auto (default)
  --temperature T       LLM temperature (default: 0.0)

Output:
  --output DIR          Output directory for results
  --json                Print results as JSON
  --verbose             Enable verbose logging
```

## Evaluation Metrics

| Metric | Description |
|--------|-------------|
| **Task Success Rate** | Percentage of tasks where ALL steps are correct |
| **Step Accuracy** | Percentage of individual steps that are fully correct |
| **Element Accuracy** | Percentage of steps with correct target element |
| **Operation Accuracy** | Percentage of steps with correct operation (CLICK/TYPE/SELECT) |

## Dataset Splits

| Split | Description |
|-------|-------------|
| `test_task` | Cross-Task: Same websites, new task types |
| `test_website` | Cross-Website: New websites within same domains |
| `test_domain` | Cross-Domain: Entirely new domains |

## Architecture

```
Mind2Web Benchmark
├── eliza_agent.py     # ElizaOS agent with MIND2WEB_ACTION action
├── dataset.py         # Mind2Web dataset loader (HF + local + samples)
├── evaluator.py       # Step and task evaluation
├── runner.py          # Benchmark orchestration
├── cli.py             # Command-line interface
└── types.py           # Type definitions
```

### Agent Flow

1. **Provider** (`MIND2WEB_CONTEXT`): Injects task instruction, current page elements, and action history
2. **Action** (`MIND2WEB_ACTION`): Executes browser operations (CLICK, TYPE, SELECT)
3. **Evaluation**: Compares predicted actions against ground truth

## Example Output

```
============================================================
Mind2Web Benchmark Results
============================================================
Tasks: 3, Trials: 3
Task Success Rate: 66.7%
Step Accuracy: 85.0%
Element Accuracy: 90.0%
Avg Latency: 1234ms

Results saved to: ./benchmark_results/mind2web/2026-01-14_12-30-45
============================================================
```

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest tests/

# Type check
mypy benchmarks/mind2web

# Lint
ruff check benchmarks/mind2web
```

## References

- [Mind2Web Paper](https://arxiv.org/abs/2306.06070)
- [Mind2Web GitHub](https://github.com/OSU-NLP-Group/Mind2Web)
- [Mind2Web HuggingFace Dataset](https://huggingface.co/datasets/osunlp/Mind2Web)

## License

MIT
