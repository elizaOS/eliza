# AgentBench Research & Implementation Plan

## Overview

AgentBench is a comprehensive benchmark introduced in 2023 by THUDM (Tsinghua University) to evaluate Large Language Models (LLMs) functioning as autonomous agents across diverse interactive environments. It is considered one of the most comprehensive agent benchmarks available.

## Implementation Status: ✅ COMPLETE

The AgentBench benchmark has been fully implemented for ElizaOS Python with the following components:

| Component | Status | Location |
|-----------|--------|----------|
| Core Types | ✅ Complete | `python/elizaos_agentbench/types.py` |
| OS Environment | ✅ Complete | `python/elizaos_agentbench/adapters/os_adapter.py` |
| Database Environment | ✅ Complete | `python/elizaos_agentbench/adapters/db_adapter.py` |
| Knowledge Graph | ✅ Complete | `python/elizaos_agentbench/adapters/kg_adapter.py` |
| Web Shopping | ✅ Complete | `python/elizaos_agentbench/adapters/webshop_adapter.py` |
| Lateral Thinking | ✅ Complete | `python/elizaos_agentbench/adapters/lateral_thinking_adapter.py` |
| Card Game | 🔄 Planned | - |
| Householding | 🔄 Planned | - |
| Web Browsing | 🔄 Planned | - |
| Benchmark Runner | ✅ Complete | `python/elizaos_agentbench/runner.py` |
| CLI Interface | ✅ Complete | `python/elizaos_agentbench/cli.py` |
| Test Suite | ✅ Complete | `python/elizaos_agentbench/tests/` |

### Quick Start

```bash
# Install
cd benchmarks/agentbench/python
pip install -e .

# Run benchmark
python run_benchmark.py --env db kg ws lt

# Or with ElizaOS runtime
python run_benchmark.py --elizaos --env all
```

## Benchmark Description

AgentBench comprises **8 distinct environments** designed to assess LLMs' reasoning and decision-making capabilities:

| Environment | Description | Key Challenges | Implementation |
|-------------|-------------|----------------|----------------|
| **Operating System (OS)** | Interacting with Linux terminal | Command execution, file manipulation, system administration | ✅ Docker/Local |
| **Database (DB)** | SQL query generation and execution | Query composition, data retrieval, schema understanding | ✅ SQLite |
| **Knowledge Graph (KG)** | Querying structured knowledge bases | SPARQL-like queries, entity relationships, reasoning | ✅ In-memory |
| **Digital Card Game** | Playing strategic card games | Planning, opponent modeling, resource management | 🔄 Planned |
| **Lateral Thinking Puzzle** | Solving creative puzzles | Deductive reasoning, hypothesis generation | ✅ Yes/No Q&A |
| **Householding (ALFWorld)** | Performing household tasks | Object manipulation, navigation, task decomposition | 🔄 Planned |
| **Web Shopping** | Online product search and purchase | Information retrieval, decision making | ✅ Simulated |
| **Web Browsing** | General web navigation | Multi-step navigation, form filling, information extraction | 🔄 Planned |

## Benchmark Results (Mock Runtime)

Results from running with mock runtime (baseline for infrastructure validation):

| Environment | Success Rate | GPT-4 Baseline | Difference |
|-------------|-------------|----------------|------------|
| Database | 0.0% | 32.6% | -32.6% |
| Knowledge Graph | 0.0% | 58.4% | -58.4% |
| Lateral Thinking | 0.0% | 34.8% | -34.8% |

> **Note**: Mock runtime returns placeholder responses. Run with `--elizaos` flag and proper LLM configuration for real evaluation.

## Published Leaderboard Scores (ICLR 2024)

### GPT-4 Performance
| Environment | Score |
|-------------|-------|
| Operating System | 42.1% |
| Database | 32.6% |
| Knowledge Graph | 58.4% |
| Card Game | 42.8% |
| Lateral Thinking | 34.8% |
| Householding | 78.3% |
| Web Shopping | 50.5% |
| Web Browsing | 49.3% |
| **Overall** | **48.6%** |

### GPT-3.5 Performance
| Environment | Score |
|-------------|-------|
| Operating System | 36.0% |
| Database | 10.2% |
| Knowledge Graph | 16.4% |
| Card Game | 18.0% |
| Lateral Thinking | 10.9% |
| Householding | 13.7% |
| Web Shopping | 48.1% |
| Web Browsing | 15.0% |
| **Overall** | **21.0%** |

## Key Findings from Original Research

- **Performance Gap**: Top commercial models (GPT-4) demonstrated strong agentic abilities, while open-source models (<70B parameters) showed significant gaps
- **Key Challenges**: Deficiencies in long-term reasoning, decision-making, and instruction-following
- **Improvement Areas**: Instruction adherence and training on high-quality multi-round alignment data

## Resources

### Official Resources
- **GitHub Repository**: https://github.com/THUDM/AgentBench
- **Paper**: [AgentBench: Evaluating LLMs as Agents (ICLR 2024)](https://proceedings.iclr.cc/paper_files/paper/2024/hash/e9df36b21ff4ee211a8b71ee8b7e9f57-Abstract-Conference.html)
- **ArXiv**: https://arxiv.org/abs/2308.03688

### Related Benchmarks (Evolution)
- **Agent-SafetyBench**: Safety evaluation (December 2024) - https://arxiv.org/abs/2412.14470
- **AgentRewardBench**: Trajectory evaluation - https://github.com/McGill-NLP/agent-reward-bench
- **LifelongAgentBench**: Lifelong learning evaluation (May 2025) - https://arxiv.org/abs/2505.11942

### Dataset Sources
- ALFWorld: https://github.com/alfworld/alfworld
- WebShop: https://github.com/princeton-nlp/WebShop
- DBBench: Custom SQL benchmark
- Freebase Knowledge Graph

## Technical Architecture

### Package Structure
```
benchmarks/agentbench/python/
├── elizaos_agentbench/
│   ├── __init__.py           # Package exports
│   ├── types.py              # Core data types and baselines
│   ├── runner.py             # Main benchmark orchestrator
│   ├── cli.py                # Command-line interface
│   ├── adapters/
│   │   ├── base.py           # Abstract adapter interface
│   │   ├── os_adapter.py     # Linux terminal environment
│   │   ├── db_adapter.py     # SQL database environment
│   │   ├── kg_adapter.py     # Knowledge graph environment
│   │   ├── webshop_adapter.py # E-commerce environment
│   │   └── lateral_thinking_adapter.py # Puzzle environment
│   └── tests/
│       ├── test_types.py     # 12 tests ✅
│       ├── test_adapters.py  # 21 tests ✅
│       └── test_runner.py    # 8 tests ✅
├── pyproject.toml
├── README.md
└── run_benchmark.py
```

### Core Components

#### 1. Environment Adapter Interface
```python
class EnvironmentAdapter(ABC):
    @abstractmethod
    async def initialize(self) -> None: ...
    @abstractmethod
    async def reset(self, task: AgentBenchTask) -> dict[str, Any]: ...
    @abstractmethod
    async def step(self, action: str) -> tuple[dict, float, bool, dict]: ...
    @abstractmethod
    async def evaluate(self, task: AgentBenchTask, trajectory: list[str]) -> bool: ...
```

#### 2. Task Definition
```python
@dataclass
class AgentBenchTask:
    id: str
    environment: AgentBenchEnvironment
    description: str
    initial_state: dict[str, Any]
    goal: str
    max_steps: int
    timeout_ms: int = 60000
    ground_truth: Optional[str] = None
```

#### 3. Result Tracking
```python
@dataclass
class AgentBenchResult:
    task_id: str
    environment: AgentBenchEnvironment
    success: bool
    steps_taken: int
    actions: list[str]
    duration_ms: float
    metrics: dict[str, float]
```

## Running Benchmarks

### With Mock Runtime (Testing)
```bash
cd benchmarks/agentbench/python
python run_benchmark.py --env db kg --max-tasks 5
```

### With ElizaOS Runtime
```bash
# Ensure ElizaOS is configured with an LLM provider
python run_benchmark.py --elizaos --env all --output ./results
```

### Using CLI
```bash
# List environments
python -m elizaos_agentbench.cli list

# Run specific environments
python -m elizaos_agentbench.cli run --env os database --max-tasks 10
```

## Testing

All tests pass (41 total):

```bash
cd benchmarks/agentbench/python
pytest elizaos_agentbench/tests/ -v

# Results:
# test_types.py: 12 passed
# test_adapters.py: 21 passed  
# test_runner.py: 8 passed
```

## Output Files

After benchmark execution:
- `agentbench-results.json` - Detailed metrics and comparisons
- `agentbench-report.md` - Human-readable markdown report
- `agentbench-detailed.json` - Full task-level execution logs

## Success Criteria

- [x] All 8 environments defined in types
- [x] 5 environments fully implemented
- [x] Base adapter interface with step/reset/evaluate
- [x] Complete test suite with >80% coverage
- [x] Benchmark runner with memory tracking
- [x] Comparison with GPT-4/GPT-3.5 baselines
- [x] JSON and markdown report generation
- [ ] Performance benchmarks against real LLM
- [ ] CI/CD pipeline for automated evaluation

## Future Work

1. **Complete remaining environments**: Card Game, Householding (ALFWorld), Web Browsing
2. **Real LLM evaluation**: Run with GPT-4, Claude, or local models via ElizaOS
3. **Extended datasets**: Load full AgentBench dataset files
4. **Docker integration**: Improve OS environment sandboxing
5. **Performance optimization**: Parallel task execution
6. **CI Integration**: Add to GitHub Actions workflow

## Notes

- ALFWorld has known memory/disk leaks - implement container recycling
- WebShop requires significant RAM - document minimum requirements
- Some environments may require API keys (web browsing)
- Consider implementing subset mode for faster development iterations
