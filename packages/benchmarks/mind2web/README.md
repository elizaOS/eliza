# Mind2Web Benchmark for ElizaOS

Web agent benchmark based on [OSU-NLP-Group/Mind2Web](https://github.com/OSU-NLP-Group/Mind2Web).

Evaluates ElizaOS agents on real-world web navigation and interaction tasks.

## Features

- **Canonical ElizaOS Integration**: Uses the TypeScript benchmark bridge for the full agent loop
- **Multiple Model Providers**: Groq, OpenAI, OpenRouter, Cerebras through OpenAI-compatible local calls, or the Eliza bridge
- **Faithful MindAct two-stage pipeline**: DeBERTa-v3 candidate ranker (stage 1) feeds top-K elements to the LLM action predictor (stage 2)
- **Comprehensive Metrics**: Task success, step accuracy, element/operation accuracy, plus stage-1 Recall@K
- **Multiple Splits**: Cross-Task, Cross-Website, Cross-Domain evaluation

## Two-stage MindAct pipeline

This harness reproduces the two-stage architecture from Deng et al. 2023
([arXiv:2306.06070](https://arxiv.org/abs/2306.06070)):

1. **Candidate ranker** (`ranker.py`): a DeBERTa-v3 cross-encoder scores every
   DOM candidate against the task description + last 3 actions, and forwards
   the top-K (default 50) to the LLM. The pretrained checkpoint
   [`osunlp/MindAct_CandidateGeneration_deberta-v3-base`](https://huggingface.co/osunlp/MindAct_CandidateGeneration_deberta-v3-base)
   is downloaded lazily on first use (~750MB). On CPU the first call takes
   ~10-20s to load weights; subsequent calls reuse the in-process singleton.
2. **Action predictor**: the configured LLM picks one element from the top-K
   and emits `(operation, value)`.

Stage-1 Recall@K is reported alongside the standard step/task metrics
(upstream reports ~88-92% Recall@50 on `test_task` with the released
checkpoint).

### `--ranker` flag

```
--ranker {real,oracle,none}     # default: real
--ranker-top-k N                # default: 50
--ranker-model HF_ID            # override checkpoint
--ranker-device {cpu,cuda,...}  # default: auto
```

| Mode | Behavior | Comparability |
|------|----------|---------------|
| `real` (default) | DeBERTa-v3 cross-encoder ranks all DOM candidates and the top-K go to the LLM. | Leaderboard-comparable. |
| `oracle` | Annotated `pos_candidates` are passed straight through to the LLM. | **Upper bound only — not leaderboard-comparable** (leaks the answer). |
| `none` | All `pos + neg` candidates passed without filtering. | Diagnostic only. |

The `--mock` flag selects the `OracleMind2WebAgent` (formerly
`MockMind2WebAgent`), which replays the dataset's annotated answer and
trivially scores 100%. It is intended for CI smoke tests only and refuses to
run without `--mock`.

## Quick Start

### Run with Sample Tasks (No API Key Required)

```bash
# From repo root
PYTHONPATH=packages python -m benchmarks.mind2web --sample --mock
```

### Run with Groq (Fast and Cheap)

```bash
# Set your Groq API key
export GROQ_API_KEY=your_key_here

# Run benchmark
PYTHONPATH=packages python -m benchmarks.mind2web --sample --real-llm --provider groq --model openai/gpt-oss-120b
```

### Run with OpenAI

```bash
export OPENAI_API_KEY=your_key_here
PYTHONPATH=packages python -m benchmarks.mind2web --sample --provider openai --model openai/gpt-oss-120b
```

### Run Full Benchmark from HuggingFace

```bash
# Install datasets package
pip install datasets

# Run with HuggingFace data
PYTHONPATH=packages python -m benchmarks.mind2web --hf --real-llm --max-tasks 50
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
  --mock                Use deterministic ground-truth replay for offline smoke tests
  --real-llm            Deprecated alias for --provider eliza when no provider is specified
  --provider PROVIDER   groq, openai, openrouter, cerebras, eliza, or auto (default)
  --model MODEL         Model name for OpenAI-compatible providers
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
