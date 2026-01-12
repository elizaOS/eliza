# GAIA Benchmark Architecture

## Overview

The GAIA benchmark tests AI assistants on real-world tasks requiring reasoning, tool use, and multimodal processing. This implementation provides:

1. **Multi-provider support**: Groq (default), OpenAI, Anthropic, Ollama, LocalAI, OpenRouter, Google GenAI, XAI
2. **Standalone mode**: Direct API calls, no ElizaOS dependency
3. **ElizaOS integration mode**: Uses runtime for LLM and action processing
4. **Model comparison**: Results are saved per-model to track performance across different providers

## Supported Providers & Models

| Provider | Default Model | Other Models |
|----------|--------------|--------------|
| **Groq** (default) | llama-3.1-8b-instant | llama-3.3-70b-versatile, mixtral-8x7b |
| **OpenAI** | gpt-4o | gpt-4o-mini, o1-preview, o1-mini |
| **Anthropic** | claude-3-5-sonnet | claude-3-5-haiku, claude-3-opus |
| **OpenRouter** | meta-llama/llama-3.1-8b | qwen-2.5-32b, qwen-2.5-72b, deepseek-r1 |
| **Google** | gemini-2.0-flash-exp | gemini-1.5-pro, gemini-1.5-flash |
| **XAI** | grok-2-latest | grok-2-vision |
| **Ollama** | llama3.2:latest | qwen2.5:32b, mistral:latest |
| **LocalAI** | gpt-4 | OpenAI-compatible local models |

## Benchmark Flow

```
CLI/API → GAIARunner → GAIADataset (load questions)
                     ↓
              FOR EACH QUESTION:
                GAIAAgent.solve() → LLM response → Tool execution → Final answer
                     ↓
              GAIAEvaluator.evaluate() → is_correct
                     ↓
              MetricsCalculator → Leaderboard comparison → Reports
```

## Key Components

### 1. GAIAAgent

The agent implements a ReAct-style loop:

```python
for iteration in range(max_iterations):
    response = await self._get_llm_response()  # Call LLM
    
    if final_answer := self._extract_final_answer(response):
        return result
    
    if tool_call := self._extract_tool_call(response):
        tool_result = await self._execute_tool(tool_name, tool_input)
        # Add result to conversation history and continue
```

### 2. Tools

| Tool | Class | ElizaOS Action |
|------|-------|----------------|
| Web Search | `WebSearchTool` | `WEB_SEARCH` |
| Web Browse | `WebBrowserTool` | `BROWSE` |
| Calculator | `Calculator` | `CALCULATE` |
| Code Executor | `CodeExecutor` | `EXECUTE_CODE` |
| File Processor | `FileProcessor` | N/A (file-based) |

### 3. Evaluator

The evaluator normalizes answers before comparison:

1. Lowercase
2. Remove punctuation (except in numbers)
3. Normalize numbers (1,000 → 1000)
4. Remove articles (a, an, the)
5. Compare exact, numeric, or fuzzy match

### 4. Metrics

- Overall accuracy (correct / total)
- Per-level accuracy (Level 1, 2, 3)
- Tool usage and success rates
- Latency and token usage
- Error categorization

## ElizaOS Integration

### Plugin Structure

```python
from elizaos_gaia import gaia_plugin

# Plugin provides:
# - OpenAI model handler for TEXT_LARGE
# - Actions for WEB_SEARCH, BROWSE, CALCULATE, EXECUTE_CODE
# - Configuration for tool enablement
```

### Usage with ElizaOS Runtime

```python
from elizaos.runtime import AgentRuntime
from elizaos_gaia import gaia_plugin, GAIARunner, GAIAConfig

# Create runtime with GAIA plugin
runtime = AgentRuntime(character=my_character)
await runtime.register_plugin(gaia_plugin)
await runtime.initialize()

# Run benchmark with runtime
config = GAIAConfig(split="validation", max_questions=10)
runner = GAIARunner(config, runtime=runtime)
results = await runner.run_benchmark()
```

### Standalone Usage

```python
from elizaos_gaia import GAIARunner, GAIAConfig
import os

os.environ["OPENAI_API_KEY"] = "your-key"

config = GAIAConfig(split="validation")
runner = GAIARunner(config)  # No runtime - uses direct API
results = await runner.run_benchmark()
```

## Potential Issues

### 1. API Key Configuration

**Problem**: Missing or invalid API keys

**Where**: `_call_openai_api()` in agent.py, `openai_model_handler()` in plugin.py

**Solution**: Set environment variables:
```bash
export OPENAI_API_KEY=sk-...
export SERPER_API_KEY=...  # Optional, for better web search
```

### 2. HuggingFace Dataset Access

**Problem**: Dataset download failures or rate limits

**Where**: `GAIADataset.load()` in dataset.py

**Solution**: 
- Set `HF_TOKEN` environment variable
- Use `--hf-token` CLI flag
- Cached data in `.cache/gaia/`

### 3. Tool Extraction from LLM Response

**Problem**: LLM doesn't use expected tool call format

**Where**: `_extract_tool_call()` in agent.py

**Current patterns**:
```
tool_name("input")           # Function style
[TOOL: tool_name] input      # Action style
/tool_name input             # Command style
```

**Improvement**: Consider using function calling API for more reliable tool use.

### 4. File Processing Dependencies

**Problem**: Missing optional dependencies

**Where**: FileProcessor methods

**Optional deps**:
- `pdfplumber` or `PyPDF2` for PDFs
- `pytesseract` for image OCR
- `playwright` for JavaScript-heavy pages
- `mutagen` for audio metadata

### 5. Code Execution Security

**Problem**: Arbitrary code execution risk

**Where**: `CodeExecutor._execute_subprocess()`

**Mitigation**:
- Set `code_execution_sandbox=True` for Docker isolation
- Set `allowed_imports` to restrict modules
- Use timeout to prevent infinite loops

### 6. Answer Normalization Edge Cases

**Problem**: False negatives in evaluation

**Where**: `GAIAEvaluator.normalize()`

**Examples that may fail**:
- Different number formats: "1.5 million" vs "1500000"
- Date formats: "January 1st, 2024" vs "01/01/2024"
- Scientific notation: "1.5e6" vs "1,500,000"

### 7. Rate Limiting

**Problem**: Too many API requests

**Where**: Web search, LLM calls

**Solutions**:
- Use `--max-questions` to limit scope
- Add delays between questions
- Use cheaper models for testing (`gpt-3.5-turbo`)

## Testing

### Unit Tests (no API key needed)

```bash
cd benchmarks/gaia/python
pip install -e ".[dev]"
pytest tests/ -v
```

### Integration Tests (API key required)

```bash
export OPENAI_API_KEY=sk-...
pytest tests/test_integration.py -v -k "test_simple_math"
```

### End-to-End Benchmark

```bash
export OPENAI_API_KEY=sk-...
gaia-benchmark --quick-test  # 5 questions
gaia-benchmark --split validation --max-questions 10
```

## File Structure

```
benchmarks/gaia/python/
├── elizaos_gaia/
│   ├── __init__.py          # Package exports
│   ├── types.py              # Data classes and enums
│   ├── dataset.py            # HuggingFace data loader
│   ├── agent.py              # Question solving agent
│   ├── evaluator.py          # Answer evaluation
│   ├── metrics.py            # Benchmark metrics
│   ├── runner.py             # Benchmark orchestration
│   ├── plugin.py             # ElizaOS plugin integration
│   ├── cli.py                # Command-line interface
│   └── tools/
│       ├── web_search.py     # Web search tool
│       ├── web_browser.py    # Web browsing tool
│       ├── calculator.py     # Math calculation tool
│       ├── code_executor.py  # Code execution tool
│       └── file_processor.py # File processing tool
├── tests/
│   ├── test_types.py         # Type tests
│   ├── test_calculator.py    # Calculator tests
│   ├── test_evaluator.py     # Evaluator tests
│   ├── test_metrics.py       # Metrics tests
│   ├── test_validation.py    # Input validation tests
│   └── test_integration.py   # Integration tests
├── pyproject.toml            # Package configuration
└── README.md                 # User documentation
```

## Configuration Reference

```python
@dataclass
class GAIAConfig:
    # Paths
    cache_dir: str = ".cache/gaia"
    output_dir: str = "./benchmark_results/gaia"
    
    # Dataset
    split: str = "validation"  # or "test"
    levels: list[GAIALevel] | None = None  # Filter by level
    max_questions: int | None = None  # Limit for testing
    
    # Agent
    max_iterations: int = 15
    timeout_per_question_ms: int = 300000  # 5 minutes
    
    # Tools
    enable_web_search: bool = True
    enable_web_browse: bool = True
    enable_file_processing: bool = True
    enable_code_execution: bool = True
    code_execution_sandbox: bool = True
    
    # Model
    model_name: str = "gpt-4"
    temperature: float = 0.0
    max_tokens: int = 4096
```
