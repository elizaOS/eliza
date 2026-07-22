# Mind2Web benchmark for elizaOS

Web agent benchmark based on [OSU-NLP-Group/Mind2Web](https://github.com/OSU-NLP-Group/Mind2Web).

Evaluates Eliza agents on real-world web navigation and interaction tasks.

## Features

- **Native harness comparison**: the Eliza, Hermes, and OpenClaw paths keep their production agent loops while sharing one model gateway and benchmark prompt
- **Pinned held-out data**: verifies the official encrypted archive, revision, checksum, and exact split counts before any model call
- **Faithful MindAct two-stage pipeline**: DeBERTa-v3 candidate ranker (stage 1) feeds top-K elements to the LLM action predictor (stage 2)
- **Comprehensive Metrics**: Task success, step accuracy, element/operation accuracy, plus stage-1 Recall@K
- **Multiple Splits**: Cross-Task, Cross-Website, Cross-Domain evaluation

## Two-stage MindAct pipeline

This harness reproduces the two-stage architecture from Deng et al. 2023
([arXiv:2306.06070](https://arxiv.org/abs/2306.06070)):

1. **Candidate ranker** (`ranker.py`): full runs consume OSU's released,
   checksum-pinned `scores_all_data.pkl` output from the official DeBERTa-v3
   cross-encoder and forward the top-K (default 50). The code can also load the
   commit-pinned checkpoint
   [`osunlp/MindAct_CandidateGeneration_deberta-v3-base`](https://huggingface.co/osunlp/MindAct_CandidateGeneration_deberta-v3-base)
   to reproduce and audit those scores without charging each harness for the
   same deterministic stage.
2. **Action predictor**: every native harness receives the same pruned DOM,
   ranked candidate mapping, previous actions, and required action schema. It
   receives neither the annotated current action nor future action plan.

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
| `real` (default) | Pinned DeBERTa-v3 cross-encoder ranks all DOM candidates and the top-K go to the LLM. | Required for publishable cohort results. |
| `oracle` | Annotated `pos_candidates` are passed straight through to the LLM. | **Upper bound only — not leaderboard-comparable** (leaks the answer). |
| `none` | All `pos + neg` candidates passed without filtering. | Diagnostic only. |

The official corpus/ranker and macro metrics match Mind2Web, but Claude tool
calling and the optional derived edge variants are an adapted comparative
protocol; these results are not represented as published MindAct leaderboard
entries.

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

# Run one explicit non-publishable transport canary on official data
PYTHONPATH=packages python -m benchmarks.mind2web --hf --max-tasks 1 \
  --provider groq --model openai/gpt-oss-120b
```

### Run with OpenAI

```bash
export OPENAI_API_KEY=your_key_here
PYTHONPATH=packages python -m benchmarks.mind2web --hf --max-tasks 1 \
  --provider openai --model openai/gpt-oss-120b
```

### Validate the official held-out archive

```bash
MIND2WEB_DISABLE_DATA_DOWNLOAD=1 PYTHONPATH=packages \
  python -m benchmarks.mind2web --hf --split test_task --count-scenarios \
  --expected-tasks 252
```

## CLI Options

```
Usage: python -m benchmarks.mind2web [OPTIONS]

Data Source:
  --sample              Use built-in non-publishable sample tasks
  --hf                  Load the pinned official encrypted test archive
  --split SPLIT         Dataset split: train, test_task, test_website, test_domain

Task Selection:
  --max-tasks N         Maximum tasks to run
  --trials N            Trials per task (default: 1)
  --max-steps N         Maximum steps per task (default: 20)
  --expand-scenarios    Add ten prompt-preserving stress variants per task
  --expected-tasks N    Require an exact base task count
  --expected-scenarios N Require an exact expanded task count

Model Configuration:
  --mock                Use deterministic ground-truth replay for offline smoke tests
  --real-llm            Deprecated alias for --provider eliza when no provider is specified
  --provider PROVIDER   groq, openai, openrouter, cerebras, eliza, or auto (default)
  --model MODEL         Model name for OpenAI-compatible providers
  --temperature T       LLM temperature (default: 0.0)
  --ranker {real,oracle,none}
  --ranker-top-k N      Candidate cutoff (default: 50)
  --ranker-revision REV Pinned model revision override

Output:
  --output DIR          Output directory for results
  --json                Print results as JSON
  --verbose             Enable verbose logging
```

## Evaluation Metrics

| Metric | Description |
|--------|-------------|
| **Task Success Rate** | Percentage of tasks where ALL steps are correct |
| **Step Accuracy** | Macro-average task step accuracy; requires exact positive backend ID and upstream action-token match |
| **Element Accuracy** | Percentage of steps with an exact positive backend-node ID |
| **Operation Accuracy** | Percentage of steps with correct operation (CLICK/TYPE/SELECT) |

## Dataset Splits

| Split | Description | Tasks |
|-------|-------------|------:|
| `test_task` | Cross-Task: same websites, new tasks | 252 |
| `test_website` | Cross-Website: unseen websites | 177 |
| `test_domain` | Cross-Domain: unseen domains | 912 |

The loader pins Hugging Face dataset revision
`17ece8eb89862368edc0cc806acee6fca5163474` and archive SHA-256
`8f5fbe72afab942fe97cdf7fb397e179885d89b5c16862288e9a14bc6d41ca89`.
The released candidate-score artifact is independently pinned at SHA-256
`884c97cd9ae0544485d21ea39e0d46422aee0291969a7324e56df3a84466dbd7`.
Extraction uses the password published by OSU and completes atomically. Missing,
partial, malformed, or count-mismatched data fails before model execution; it
never falls back to train data or the three-task fixture.

## Architecture

```
Mind2Web Benchmark
├── eliza_agent.py     # Shared action surface and direct-provider agent
├── dataset.py         # Pinned official archive + explicit local/sample loaders
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
