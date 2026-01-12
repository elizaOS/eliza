# GAIA Benchmark Research & Implementation Plan

## Implementation Status: ✅ COMPLETE

The GAIA benchmark has been fully implemented for ElizaOS Python. See `python/` directory for the complete implementation.

### Quick Start
```bash
cd benchmarks/gaia/python
pip install -e ".[dev]"

# Set your OpenAI API key
export OPENAI_API_KEY=your_key

# Run quick test
gaia-benchmark --quick-test

# Run full benchmark
gaia-benchmark --split validation
```

---

## Overview

GAIA (General AI Assistants) is a benchmark introduced by Meta in May 2024 to evaluate AI systems' capabilities in real-world tasks requiring reasoning, multimodal processing, web browsing, and tool use. It is designed to test the practical capabilities of AI assistants on tasks that are easy for humans but challenging for AI.

## Benchmark Description

### Key Statistics
- **466 questions** across three difficulty levels
- **Human accuracy**: ~92%
- **Initial GPT-4 with plugins**: ~15%
- **Current best (2025)**: ~65% (h2oGPTe Agent)

### Difficulty Levels

| Level | Description | Typical Tasks | Question Count |
|-------|-------------|---------------|----------------|
| **Level 1** | Solvable by advanced LLMs | Direct reasoning, simple tool use | ~150 |
| **Level 2** | Requires complex reasoning + tools | Multi-step web research, file processing | ~200 |
| **Level 3** | Demanding advanced capabilities | Complex integrations, multi-modal reasoning | ~100 |

### Task Categories
- **Web Browsing**: Searching and navigating websites
- **File Processing**: Reading PDFs, images, spreadsheets
- **Calculations**: Mathematical reasoning and computation
- **Multi-step Reasoning**: Chaining multiple operations
- **Tool Use**: Using APIs and external tools
- **Multimodal**: Processing images, audio, documents

## Key Characteristics

1. **Human-Easy, AI-Hard**: Questions trivial for humans but challenging for AI
2. **Real-World Grounding**: Based on practical assistant tasks
3. **Multi-Modal**: Includes images, PDFs, audio files
4. **Tool-Requiring**: Many questions cannot be answered without tools
5. **Factual**: Answers are verifiable facts (not opinions)

## Resources

### Official Resources
- **Benchmark Website**: https://gaiabenchmark.com/
- **Paper**: [GAIA: A Benchmark for General AI Assistants (ICLR 2024)](https://proceedings.iclr.cc/paper_files/paper/2024/hash/25ae35b5b1738d80f1f03a8713e405ec-Abstract-Conference.html)
- **HuggingFace Dataset**: https://huggingface.co/datasets/gaia-benchmark/GAIA
- **Leaderboard**: https://huggingface.co/spaces/gaia-benchmark/leaderboard

### Implementation References
- **aymeric-roucher/GAIA**: https://github.com/aymeric-roucher/GAIA (Top-scoring implementation)
- **Transformers Agents**: HuggingFace agent framework
- **Inspect AI Implementation**: https://ukgovernmentbeis.github.io/inspect_evals/evals/assistants/gaia/

### Related Projects
- **Memento-GAIA**: https://github.com/beotavalo/memento-gaia
- **OpenDevin**: Multi-agent approach to GAIA

## Technical Requirements

### Dependencies
```
python >= 3.10
huggingface_hub  # Dataset access
requests  # Web browsing
beautifulsoup4  # HTML parsing
PyPDF2 / pdfplumber  # PDF processing
Pillow  # Image processing
pandas  # Spreadsheet handling
selenium / playwright  # Browser automation
```

### Required Capabilities
1. **Web Search**: Google, Bing, or similar API
2. **Web Browsing**: Headless browser for navigation
3. **File Processing**: PDF, images, Excel, CSV
4. **Code Execution**: Python interpreter
5. **Calculator**: Mathematical operations

### Dataset Structure
```json
{
  "question": "What is the population of the capital of France?",
  "level": 1,
  "final_answer": "2161000",
  "file_name": null,
  "file_path": null,
  "annotator_metadata": {
    "steps": ["Search for capital of France", "Search for Paris population"],
    "tools": ["web_search"],
    "number_of_steps": 2
  }
}
```

## Implementation Plan for ElizaOS Python

### Phase 1: Core Framework (Week 1-2)

#### 1.1 Type Definitions
```python
# benchmarks/gaia/types.py
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional
from enum import Enum
from pathlib import Path

class GAIALevel(Enum):
    LEVEL_1 = 1
    LEVEL_2 = 2
    LEVEL_3 = 3

class ToolType(Enum):
    WEB_SEARCH = "web_search"
    WEB_BROWSE = "web_browse"
    FILE_READ = "file_read"
    CODE_EXEC = "code_exec"
    CALCULATOR = "calculator"
    IMAGE_ANALYSIS = "image_analysis"

@dataclass
class GAIAQuestion:
    id: str
    question: str
    level: GAIALevel
    final_answer: str
    file_name: Optional[str] = None
    file_path: Optional[Path] = None
    annotator_steps: List[str] = field(default_factory=list)
    required_tools: List[ToolType] = field(default_factory=list)

@dataclass
class GAIAResult:
    question_id: str
    level: GAIALevel
    predicted_answer: str
    expected_answer: str
    is_correct: bool
    steps_taken: List[str]
    tools_used: List[ToolType]
    latency_ms: float
    token_usage: int
    error: Optional[str] = None
    intermediate_results: List[Dict[str, Any]] = field(default_factory=list)
```

#### 1.2 Dataset Loader
```python
# benchmarks/gaia/dataset.py
from huggingface_hub import hf_hub_download
import json

class GAIADataset:
    def __init__(self, cache_dir: str = ".cache/gaia"):
        self.cache_dir = Path(cache_dir)
        self.validation_set: List[GAIAQuestion] = []
        self.test_set: List[GAIAQuestion] = []
    
    async def load(self, split: str = "validation") -> None:
        """Load GAIA dataset from HuggingFace."""
        # Download dataset
        dataset_path = hf_hub_download(
            repo_id="gaia-benchmark/GAIA",
            filename=f"{split}.jsonl",
            repo_type="dataset",
            cache_dir=self.cache_dir
        )
        # Parse questions
        with open(dataset_path) as f:
            for line in f:
                data = json.loads(line)
                question = self._parse_question(data)
                if split == "validation":
                    self.validation_set.append(question)
                else:
                    self.test_set.append(question)
    
    async def download_files(self) -> None:
        """Download associated files (PDFs, images, etc.)."""
        pass
    
    def get_by_level(self, level: GAIALevel) -> List[GAIAQuestion]:
        """Filter questions by difficulty level."""
        return [q for q in self.validation_set if q.level == level]
```

### Phase 2: Tool Implementations (Week 3-4)

#### 2.1 Web Search Tool
```python
# benchmarks/gaia/tools/web_search.py
from elizaos.types.components import Action

class WebSearchTool:
    """Web search capability for GAIA."""
    
    def __init__(self, api_key: str, engine: str = "google"):
        self.api_key = api_key
        self.engine = engine
    
    async def search(self, query: str, num_results: int = 10) -> List[Dict]:
        """Execute web search and return results."""
        pass
    
    def to_action(self) -> Action:
        """Convert to ElizaOS Action."""
        return Action(
            name="WEB_SEARCH",
            description="Search the web for information",
            parameters=[
                ActionParameter(name="query", required=True, schema_def=ParameterSchema(type="string")),
                ActionParameter(name="num_results", required=False, schema_def=ParameterSchema(type="number", default=10)),
            ],
            handler=self._action_handler,
        )
```

#### 2.2 Web Browser Tool
```python
# benchmarks/gaia/tools/web_browser.py
from playwright.async_api import async_playwright

class WebBrowserTool:
    """Headless browser for web navigation."""
    
    async def navigate(self, url: str) -> str:
        """Navigate to URL and return page content."""
        async with async_playwright() as p:
            browser = await p.chromium.launch()
            page = await browser.new_page()
            await page.goto(url)
            content = await page.content()
            await browser.close()
            return content
    
    async def click(self, selector: str) -> None:
        """Click element on page."""
        pass
    
    async def extract_text(self) -> str:
        """Extract visible text from page."""
        pass
```

#### 2.3 File Processing Tools
```python
# benchmarks/gaia/tools/file_processor.py
class FileProcessor:
    """Process various file types."""
    
    async def read_pdf(self, path: Path) -> str:
        """Extract text from PDF."""
        import pdfplumber
        with pdfplumber.open(path) as pdf:
            return "\n".join(page.extract_text() for page in pdf.pages)
    
    async def read_image(self, path: Path) -> Dict:
        """Analyze image and extract information."""
        # Use vision model or OCR
        pass
    
    async def read_spreadsheet(self, path: Path) -> str:
        """Read Excel/CSV and return formatted data."""
        import pandas as pd
        df = pd.read_excel(path) if path.suffix == '.xlsx' else pd.read_csv(path)
        return df.to_string()
```

#### 2.4 Code Execution Tool
```python
# benchmarks/gaia/tools/code_executor.py
import subprocess
import tempfile

class CodeExecutor:
    """Safe code execution environment."""
    
    def __init__(self, timeout: int = 30):
        self.timeout = timeout
    
    async def execute_python(self, code: str) -> Dict[str, Any]:
        """Execute Python code in sandbox."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
            f.write(code)
            f.flush()
            try:
                result = subprocess.run(
                    ['python', f.name],
                    capture_output=True,
                    text=True,
                    timeout=self.timeout
                )
                return {
                    "stdout": result.stdout,
                    "stderr": result.stderr,
                    "returncode": result.returncode
                }
            except subprocess.TimeoutExpired:
                return {"error": "Execution timed out"}
```

### Phase 3: Agent Integration (Week 5)

#### 3.1 GAIA Agent
```python
# benchmarks/gaia/agent.py
from elizaos.runtime import AgentRuntime
from elizaos.types.agent import Character

class GAIAAgent:
    """Specialized agent for GAIA benchmark."""
    
    def __init__(self, runtime: AgentRuntime):
        self.runtime = runtime
        self.tools = self._initialize_tools()
    
    def _initialize_tools(self) -> Dict[str, Any]:
        """Initialize all required tools."""
        return {
            "web_search": WebSearchTool(),
            "web_browser": WebBrowserTool(),
            "file_processor": FileProcessor(),
            "code_executor": CodeExecutor(),
        }
    
    async def solve(self, question: GAIAQuestion) -> GAIAResult:
        """Attempt to solve a GAIA question."""
        # Create task-specific prompt
        prompt = self._create_prompt(question)
        
        # Run agent loop
        steps = []
        tools_used = []
        
        for _ in range(self.max_iterations):
            response = await self._get_agent_response(prompt, steps)
            
            if self._is_final_answer(response):
                return self._extract_result(response, question, steps, tools_used)
            
            # Execute tool call
            tool_result = await self._execute_tool(response)
            steps.append(tool_result)
            tools_used.append(tool_result["tool"])
        
        return GAIAResult(
            question_id=question.id,
            level=question.level,
            predicted_answer="",
            expected_answer=question.final_answer,
            is_correct=False,
            steps_taken=steps,
            tools_used=tools_used,
            error="Max iterations reached"
        )
```

#### 3.2 GAIA Plugin
```python
# benchmarks/gaia/plugin.py
from elizaos.types.plugin import Plugin

gaia_plugin = Plugin(
    name="gaia",
    description="GAIA benchmark tools for ElizaOS",
    actions=[
        WebSearchTool().to_action(),
        WebBrowserTool().to_action(),
        FileProcessor().to_action(),
        CodeExecutor().to_action(),
    ],
    providers=[
        Provider(
            name="GAIA_CONTEXT",
            description="Provides context for GAIA questions",
            get=provide_gaia_context,
        ),
    ],
)
```

### Phase 4: Evaluation & Scoring (Week 6)

#### 4.1 Answer Evaluator
```python
# benchmarks/gaia/evaluator.py
class GAIAEvaluator:
    """Evaluate GAIA answers."""
    
    def evaluate(
        self,
        predicted: str,
        expected: str,
        question_type: str = "factual"
    ) -> bool:
        """
        Evaluate answer correctness.
        GAIA uses exact match after normalization.
        """
        pred_normalized = self._normalize(predicted)
        exp_normalized = self._normalize(expected)
        return pred_normalized == exp_normalized
    
    def _normalize(self, answer: str) -> str:
        """
        Normalize answer:
        - Lowercase
        - Remove punctuation
        - Normalize numbers
        - Remove articles
        """
        answer = answer.lower().strip()
        # Remove punctuation
        answer = re.sub(r'[^\w\s]', '', answer)
        # Normalize numbers
        answer = self._normalize_numbers(answer)
        return answer
    
    def _normalize_numbers(self, text: str) -> str:
        """Normalize number formats (1000 vs 1,000)."""
        pass
```

#### 4.2 Benchmark Runner
```python
# benchmarks/gaia/runner.py
class GAIARunner:
    def __init__(
        self,
        runtime: AgentRuntime,
        config: GAIAConfig
    ):
        self.runtime = runtime
        self.config = config
        self.dataset = GAIADataset()
        self.agent = GAIAAgent(runtime)
        self.evaluator = GAIAEvaluator()
    
    async def run_benchmark(
        self,
        split: str = "validation",
        levels: List[GAIALevel] = None
    ) -> GAIAResults:
        """Run GAIA benchmark."""
        await self.dataset.load(split)
        
        questions = self.dataset.validation_set
        if levels:
            questions = [q for q in questions if q.level in levels]
        
        results = []
        for question in questions:
            result = await self.agent.solve(question)
            result.is_correct = self.evaluator.evaluate(
                result.predicted_answer,
                question.final_answer
            )
            results.append(result)
        
        return self._aggregate_results(results)
```

### Phase 5: Metrics & Reporting (Week 7)

#### 5.1 Metrics
```python
# benchmarks/gaia/metrics.py
@dataclass
class GAIAMetrics:
    overall_accuracy: float
    level_accuracy: Dict[GAIALevel, float]
    tool_usage: Dict[ToolType, int]
    average_steps: float
    average_latency_ms: float
    error_rate: float
    error_categories: Dict[str, int]

class MetricsCalculator:
    def calculate(self, results: List[GAIAResult]) -> GAIAMetrics:
        """Calculate comprehensive metrics."""
        pass
    
    def compare_with_leaderboard(
        self,
        metrics: GAIAMetrics
    ) -> Dict[str, Any]:
        """Compare with published leaderboard scores."""
        leaderboard = {
            "h2oGPTe": 0.65,
            "Langfun": 0.49,
            "Magentic-1": 0.38,
            "GPT-4 + plugins": 0.15,
        }
        return {
            "our_score": metrics.overall_accuracy,
            "rank": self._calculate_rank(metrics.overall_accuracy, leaderboard),
            "comparison": leaderboard,
        }
```

#### 5.2 Reporting
```python
# benchmarks/gaia/reporting.py
class GAIAReporter:
    def generate_report(self, results: GAIAResults) -> str:
        """Generate comprehensive markdown report."""
        return f"""
# GAIA Benchmark Results

## Overall Performance
- **Accuracy**: {results.metrics.overall_accuracy:.1%}
- **Human Baseline**: 92%
- **Best AI (h2oGPTe)**: 65%

## By Level
| Level | Accuracy | Questions |
|-------|----------|-----------|
| Level 1 | {results.metrics.level_accuracy[GAIALevel.LEVEL_1]:.1%} | {results.level_counts[1]} |
| Level 2 | {results.metrics.level_accuracy[GAIALevel.LEVEL_2]:.1%} | {results.level_counts[2]} |
| Level 3 | {results.metrics.level_accuracy[GAIALevel.LEVEL_3]:.1%} | {results.level_counts[3]} |

## Tool Usage
{self._format_tool_usage(results.metrics.tool_usage)}

## Error Analysis
{self._format_error_analysis(results.metrics.error_categories)}
"""
```

## Integration with ElizaOS

### Required Capabilities
1. **Web Search Provider**: Search API integration
2. **Browser Action**: Playwright-based navigation
3. **File Reading**: PDF, image, spreadsheet support
4. **Code Execution**: Sandboxed Python execution

### Action Mapping
| GAIA Tool | ElizaOS Action |
|-----------|---------------|
| web_search | WEB_SEARCH |
| web_browse | NAVIGATE, CLICK, READ_PAGE |
| file_read | READ_FILE, ANALYZE_IMAGE |
| code_exec | EXECUTE_CODE |
| calculator | CALCULATE |

## Testing Strategy

### Unit Tests
- Answer normalization
- Tool execution
- Result evaluation

### Integration Tests
- Level 1 subset (quick eval)
- Full validation set
- Tool chain testing

## Timeline

| Week | Tasks |
|------|-------|
| 1-2 | Types, dataset loader, file downloads |
| 3-4 | Tool implementations (search, browser, files) |
| 5 | Agent integration, plugin creation |
| 6 | Evaluation, answer matching |
| 7 | Metrics, reporting, documentation |

## Success Criteria

- [x] All three difficulty levels supported
- [x] Core tools implemented (search, browse, files, code)
- [x] Answer normalization matching GAIA standards
- [ ] Level 1 accuracy > 40% (pending full evaluation)
- [ ] Level 2 accuracy > 20% (pending full evaluation)
- [x] Comprehensive error analysis

## Implementation Details

### Package Structure
```
benchmarks/gaia/python/
├── elizaos_gaia/
│   ├── __init__.py      # Package exports
│   ├── types.py         # Type definitions (GAIAQuestion, GAIAResult, etc.)
│   ├── dataset.py       # HuggingFace dataset loader
│   ├── agent.py         # GAIA-specialized agent
│   ├── evaluator.py     # Answer evaluation with normalization
│   ├── metrics.py       # Metrics calculation & leaderboard comparison
│   ├── runner.py        # Benchmark orchestration
│   ├── cli.py           # Command-line interface
│   └── tools/
│       ├── web_search.py    # Serper/DuckDuckGo search
│       ├── web_browser.py   # Web content extraction
│       ├── file_processor.py # PDF, Excel, CSV, images
│       ├── code_executor.py  # Safe Python execution
│       └── calculator.py     # Math expressions
├── tests/               # Unit tests
├── pyproject.toml       # Package configuration
└── README.md            # Documentation
```

### Features Implemented
1. **Dataset Loading**: Automatic download from HuggingFace
2. **Tool System**: Web search, browsing, file processing, code execution
3. **Answer Evaluation**: GAIA-compliant normalization and matching
4. **Metrics**: Per-level accuracy, tool usage, performance stats
5. **Leaderboard Comparison**: Automatic ranking against published scores
6. **Markdown Reports**: Comprehensive benchmark reports

## Notes

- GAIA test set answers are hidden (leaderboard submission required)
- Some questions require specific API keys (Google Search, etc.)
- File processing may require additional libraries per format
- Consider rate limiting for web searches
