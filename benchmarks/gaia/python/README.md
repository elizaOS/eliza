# GAIA Benchmark for ElizaOS

A comprehensive implementation of the [GAIA (General AI Assistants)](https://gaiabenchmark.com/) benchmark for evaluating ElizaOS agents on real-world tasks requiring reasoning, multimodal processing, web browsing, and tool use.

## Overview

GAIA evaluates AI assistants on tasks that are easy for humans but challenging for AI. It tests:
- **Web Browsing**: Searching and navigating websites
- **File Processing**: Reading PDFs, images, spreadsheets
- **Calculations**: Mathematical reasoning and computation
- **Multi-step Reasoning**: Chaining multiple operations
- **Tool Use**: Using APIs and external tools
- **Multimodal**: Processing images, audio, documents

### Key Statistics
- **466 questions** across three difficulty levels
- **Human accuracy**: ~92%
- **Best AI (h2oGPTe Agent)**: ~65%
- **GPT-4 + plugins baseline**: ~15%

## Installation

```bash
# Basic installation
pip install elizaos-gaia

# With all optional features
pip install "elizaos-gaia[full]"

# Development installation
pip install -e ".[dev]"
```

## Quick Start

### Command Line

```bash
# Set your OpenAI API key
export OPENAI_API_KEY=your_api_key

# Run quick test (5 questions)
gaia-benchmark --quick-test

# Run full benchmark
gaia-benchmark --split validation

# Run specific levels
gaia-benchmark --levels 1,2

# Use different model
gaia-benchmark --model gpt-4-turbo
```

### Python API

```python
import asyncio
from elizaos_gaia import GAIAConfig, GAIARunner

async def main():
    config = GAIAConfig(
        split="validation",
        levels=[GAIALevel.LEVEL_1],  # Start with Level 1
        max_questions=10,
        output_dir="./my_results",
    )
    
    runner = GAIARunner(config)
    results = await runner.run_benchmark()
    
    print(f"Accuracy: {results.metrics.overall_accuracy:.1%}")
    print(f"Correct: {results.metrics.correct_answers}/{results.metrics.total_questions}")

asyncio.run(main())
```

### Integration with ElizaOS

```python
from elizaos.runtime import AgentRuntime
from elizaos_gaia import GAIAConfig, GAIARunner

# Create ElizaOS runtime with your plugins
runtime = AgentRuntime(...)
await runtime.initialize()

# Run benchmark with ElizaOS agent
config = GAIAConfig(model_name="gpt-4")
runner = GAIARunner(config, runtime=runtime)
results = await runner.run_benchmark()
```

## Configuration

### GAIAConfig Options

| Option | Default | Description |
|--------|---------|-------------|
| `split` | `"validation"` | Dataset split (`validation` or `test`) |
| `levels` | `None` | Filter by levels (e.g., `[GAIALevel.LEVEL_1]`) |
| `max_questions` | `None` | Limit number of questions |
| `max_iterations` | `15` | Max agent iterations per question |
| `timeout_per_question_ms` | `300000` | Timeout per question (5 min) |
| `model_name` | `"gpt-4"` | LLM model to use |
| `enable_web_search` | `True` | Enable web search tool |
| `enable_web_browse` | `True` | Enable web browsing tool |
| `enable_code_execution` | `True` | Enable Python code execution |
| `code_execution_sandbox` | `False` | Run code in Docker sandbox |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | **Required** - OpenAI API key |
| `SERPER_API_KEY` | Optional - For Google search results |
| `HF_TOKEN` | Optional - HuggingFace token for dataset |

## Benchmark Results

### Expected Output

After running the benchmark, you'll get:

1. **Console Summary**: Quick accuracy overview
2. **JSON Results**: Detailed results in `gaia-results.json`
3. **Markdown Report**: `BENCHMARK_RESULTS.md` with full analysis
4. **Detailed Logs**: `gaia-detailed-results.jsonl` with per-question data

### Sample Report

```
# GAIA Benchmark Results - ElizaOS Python

## Executive Summary

| Metric | Value |
|--------|-------|
| **Overall Accuracy** | 35.2% |
| **Total Questions** | 165 |
| **Correct Answers** | 58 |
| **Human Baseline** | 92% |
| **Best AI (h2oGPTe)** | 65% |

## Results by Level

| Level | Questions | Correct | Accuracy |
|-------|-----------|---------|----------|
| Level 1 | 80 | 42 | 52.5% |
| Level 2 | 60 | 14 | 23.3% |
| Level 3 | 25 | 2 | 8.0% |

## Leaderboard Comparison

**Rank:** #4 of 7 entries
**Percentile:** 57th
```

## Architecture

```
elizaos_gaia/
├── __init__.py          # Package exports
├── types.py             # Type definitions
├── dataset.py           # HuggingFace dataset loader
├── agent.py             # GAIA-specialized agent
├── evaluator.py         # Answer evaluation with normalization
├── metrics.py           # Metrics calculation
├── runner.py            # Benchmark orchestration
├── cli.py               # Command-line interface
└── tools/
    ├── web_search.py    # Web search (Serper/DuckDuckGo)
    ├── web_browser.py   # Web browsing (aiohttp/Playwright)
    ├── file_processor.py # PDF, Excel, CSV, images
    ├── code_executor.py  # Python code execution
    └── calculator.py     # Mathematical calculations
```

## Tools

### Web Search
- Supports Serper API (Google results) and DuckDuckGo (no API key)
- Returns top results with snippets

### Web Browser
- Extracts text, links, images, and tables from web pages
- Optional Playwright support for JavaScript rendering

### File Processor
- **PDF**: Text and table extraction (pdfplumber/PyPDF2)
- **Excel/CSV**: DataFrame conversion with pandas
- **Images**: OCR with pytesseract (optional)
- **Audio**: Metadata extraction

### Code Executor
- Safe Python execution in subprocess
- Optional Docker sandbox for isolation
- Configurable timeout and output limits

### Calculator
- Safe expression evaluation via AST
- Supports common math functions
- Unit conversions

## Evaluation

GAIA uses exact match after normalization:
1. Lowercase and strip
2. Remove punctuation (except in numbers)
3. Normalize numbers (1000 vs 1,000)
4. Remove articles (a, an, the)
5. Fuzzy matching for near-misses

## Leaderboard

Current published scores (2025):

| System | Level 1 | Level 2 | Level 3 | Overall |
|--------|---------|---------|---------|---------|
| h2oGPTe Agent | 75% | 62% | 48% | 65% |
| Langfun ReAct | 58% | 45% | 35% | 49% |
| Magentic-1 | 52% | 35% | 22% | 38% |
| GPT-4 + Plugins | 25% | 12% | 5% | 15% |
| Human | 95% | 92% | 88% | 92% |

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type checking
mypy elizaos_gaia

# Linting
ruff check elizaos_gaia

# Format code
black elizaos_gaia
```

## References

- [GAIA Benchmark Website](https://gaiabenchmark.com/)
- [GAIA Paper (ICLR 2024)](https://proceedings.iclr.cc/paper_files/paper/2024/hash/25ae35b5b1738d80f1f03a8713e405ec-Abstract-Conference.html)
- [HuggingFace Dataset](https://huggingface.co/datasets/gaia-benchmark/GAIA)
- [Leaderboard](https://huggingface.co/spaces/gaia-benchmark/leaderboard)

## License

MIT License - see [LICENSE](LICENSE) for details.
