# App Eval Benchmarks

Automated evaluation suite for elizaOS app agents. Measures response quality across research and coding tasks using deterministic scoring (no LLM-based evaluation).

Scores are heuristic proxies based on keyword coverage and response structure. They are useful for regression tracking, not as a ground-truth correctness metric.

## Quick Start

```bash
# Run all benchmarks (from the app repo root)
bun run benchmarks/app-eval/run-benchmarks.ts

# Research tasks only
bun run benchmarks/app-eval/run-benchmarks.ts --type research

# Coding tasks only
bun run benchmarks/app-eval/run-benchmarks.ts --type coding

# Single task
bun run benchmarks/app-eval/run-benchmarks.ts --task research-001

# Dry run (show tasks without executing)
bun run benchmarks/app-eval/run-benchmarks.ts --dry-run

# Server mode (boot runtime once, faster for full suite)
bun run benchmarks/app-eval/run-benchmarks.ts --server

# Specify app root explicitly
bun run benchmarks/app-eval/run-benchmarks.ts --root /path/to/app
```

## Evaluating Results

After a benchmark run, evaluate the results:

```bash
# Evaluate the latest run
python3 benchmarks/app-eval/evaluate.py benchmarks/app-eval/results/latest/

# JSON output
python3 benchmarks/app-eval/evaluate.py benchmarks/app-eval/results/latest/ --format json

# Save to file
python3 benchmarks/app-eval/evaluate.py benchmarks/app-eval/results/latest/ -o report.json
```

## Directory Structure

```
app-eval/
  run-benchmarks.ts         Main orchestrator (Bun script)
  evaluate.py               Unified Python evaluator
  adapter.py                Adapter for elizaOS/benchmarks orchestrator
  README.md                 This file
  tasks/
    research-tasks.json     Research task definitions (10 tasks)
    coding-tasks.json       Coding task definitions (10 tasks)
    research_evaluator.py   Research scoring logic
    coding_evaluator.py     Coding scoring logic
  results/
    latest/                 Symlink to most recent run
    <timestamp>/            One directory per run
      research-001.json     Individual task results
      ...
      summary.json          Run summary with scores
      evaluation.json       Detailed evaluation report
```

## Task Format

Each task is a JSON object:

```json
{
  "id": "research-001",
  "type": "research",
  "prompt": "The prompt sent to the agent",
  "expected_keywords": ["keyword1", "keyword2"],
  "category": "research",
  "difficulty": "easy|medium|hard",
  "max_score": 10,
  "evaluation": {
    "criteria": [
      { "name": "accuracy", "weight": 0.3, "description": "..." }
    ]
  }
}
```

## Scoring

Scoring is deterministic and does not use LLM calls:

**Research tasks** are scored on:
- **Keyword coverage** — presence of expected terms in the response
- **Depth** — word count as a proxy for thoroughness
- **Structure** — headings, lists, code blocks, paragraph organization
- **Reasoning** — presence of analytical language (because, however, therefore, etc.)

**Coding tasks** are scored on:
- **Code presence** — code blocks or recognizable code patterns
- **Keyword coverage** — expected terms and concepts
- **TypeScript quality** — type annotations, generics, modern patterns
- **Completeness** — balanced braces, return statements, sufficient length
- **Explanation** — non-code text explaining the implementation

Each criterion is weighted according to the task's `evaluation.criteria` array. Final scores are on a 0-10 scale.

## Adding New Tasks

1. Add task definitions to `tasks/research-tasks.json` or `tasks/coding-tasks.json`
2. Follow the existing task format (id, type, prompt, expected_keywords, evaluation criteria)
3. Use unique IDs with the pattern `research-NNN` or `code-NNN`
4. Run `bun run benchmarks/app-eval/run-benchmarks.ts --task <your-id>` to test

## Integration with elizaOS Benchmarks

The `adapter.py` file integrates with the elizaOS benchmarks orchestrator. Set `ELIZA_APP_ROOT` to the app repo root and place the adapter in the orchestrator's adapters directory.

## CLI Options

| Flag | Description | Default |
|------|-------------|---------|
| `--type <t>` | Run only research or coding tasks | all |
| `--task <id>` | Run a single task by ID | all |
| `--root <path>` | App repo root | auto-detect |
| `--dry-run` | Show tasks without running | false |
| `--server` | Server mode (boot once) | false |
| `--timeout <ms>` | Per-task timeout | 120000 |
| `--verbose` | Detailed output | false |
