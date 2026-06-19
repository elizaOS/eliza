# RLM Benchmark Suite

Benchmark suite for evaluating Recursive Language Model (RLM) performance on long-context tasks.

## Overview

This benchmark evaluates RLM's capabilities as described in the paper "Recursive Language Models: Training LLMs to Process Arbitrarily Long Inputs" ([arXiv:2512.24601](https://arxiv.org/abs/2512.24601)).

### Benchmarks Included

1. **S-NIAH (Streaming NIAH)** - Needle-in-a-haystack tests at scale
   - Tests context lengths from 1K to 100M+ tokens
   - Multiple needle positions (start, middle, end)
   - Multi-needle variants
   - Reference: Paper Table 1

2. **OOLONG** - Long document retrieval and reasoning
   - Document-level information extraction
   - Multi-section document navigation
   - Reference: Paper Table 2

3. **OOLONG-Pairs** - Paired document comparison
   - Cross-document information correlation
   - Comparison and synthesis tasks
   - Reference: Paper Table 2

4. **Strategy Analysis** - Evaluating emergent RLM patterns
   - Peek: Examining prefix/suffix
   - Grep: Regex-based filtering
   - Chunk: Parallel processing
   - Stitch: Result combination
   - Reference: Paper Section 4.1

## Installation

```bash
# From the benchmarks directory
pip install -e ./rlm-bench

# With RLM plugin support
pip install -e ./rlm-bench[rlm]

# With development dependencies
pip install -e ./rlm-bench[dev]
```

## Usage

### Quick Test (Stub Mode)

```bash
# Fast test with mock LLM
python run_benchmark.py --mode stub --context-lengths 1000,10000

# With progress output
python run_benchmark.py --mode stub -v
```

### Full RLM Benchmark

```bash
# Run with RLM plugin
python run_benchmark.py --mode rlm --backend gemini

# With dual-model configuration (Paper Section 3.2)
python run_benchmark.py --mode rlm --dual-model \
    --root-model gemini-2.0-flash \
    --subcall-model gemini-2.0-flash
```

### Custom Configuration

```bash
# Long context test
python run_benchmark.py \
    --context-lengths 1000,10000,100000,1000000 \
    --tasks-per-config 5 \
    --max-iterations 100

# S-NIAH only
python run_benchmark.py --no-oolong

# OOLONG only
python run_benchmark.py --no-s-niah
```

## Output

Results are saved to `./benchmark_results/rlm-bench/` by default:

- `rlm_bench_results_YYYYMMDD_HHMMSS.json` - Full results in JSON
- `rlm_bench_report_YYYYMMDD_HHMMSS.md` - Human-readable report

### Sample Report

```
## Summary

- Overall accuracy: 85.0% (85/100 tasks)
- S-NIAH by length: 1K: 100%, 10K: 95%, 100K: 80%
- OOLONG accuracy: 75%, OOLONG-Pairs: 70%
- Most used strategies: peek, grep, chunk
- Total cost: $0.0234, Avg: $0.000234/task

## S-NIAH Results (Paper Table 1)

| Model | 1K | 10K | 100K | 1M | 10M | 100M |
|-------|----|----|------|----|----|------|
| This Run | 100% | 95% | 80% | - | - | - |
| RLM (Gemini 2.0 Flash) | 100% | 100% | 98% | 95% | 92% | 88% |
```

## Paper Reference

This benchmark suite implements evaluations from:

```
@article{zhang2024rlm,
  title={Recursive Language Models: Training LLMs to Process Arbitrarily Long Inputs},
  author={Zhang, Alexander and others},
  journal={arXiv preprint arXiv:2512.24601},
  year={2024}
}
```

### Key Paper Results

**S-NIAH Performance (Table 1)**
- RLM achieves >95% accuracy at 1M tokens
- RLM maintains >88% accuracy at 100M tokens
- Direct LLMs fail beyond their context window

**OOLONG Performance (Table 2)**
- RLM outperforms direct LLMs by 20-30% on long document tasks
- Effective strategies emerge naturally: peek, grep, chunk, stitch

**Cost Efficiency (Figure 3)**
- Dual-model configuration reduces cost by 40-60%
- Subcall model can be smaller/cheaper than root model

## Development

```bash
# Run tests
pytest elizaos_rlm_bench/tests/ -v

# Run specific test
pytest elizaos_rlm_bench/tests/test_benchmark.py::TestGenerator -v
```

## Integration with elizaOS

The benchmark integrates with the RLM plugin (`plugin-rlm`) for full trajectory logging and cost tracking:

```python
from elizaos_plugin_rlm import RLMTrajectoryIntegration
from elizaos_plugin_trajectory_logger.service import TrajectoryLoggerService

# Setup integration
logger = TrajectoryLoggerService()
integration = RLMTrajectoryIntegration(logger)

# Run with trajectory capture
result = await integration.infer("Long context...")
print(result.trajectory.strategies_used)  # ['peek', 'grep', 'stitch']
print(result.cost.total_cost_usd)  # 0.0001
```
