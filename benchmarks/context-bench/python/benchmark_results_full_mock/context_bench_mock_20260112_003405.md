# Context Benchmark Results

*Generated: 2026-01-12T00:34:05.433775*

## Executive Summary

**Status:** needs_improvement
**Overall Accuracy:** 39.2%

### Key Findings
- Low retrieval accuracy (<70%)
- Struggles with 2-hop reasoning (0.0% success)
- Struggles with 3-hop reasoning (0.0% success)
- Performance below Claude-3-Opus (-55.8%)

### Recommendations
- Consider using a model with better context handling
- Consider chain-of-thought prompting for 2+ hop questions
- Consider chain-of-thought prompting for 3+ hop questions

## Overall Metrics

| Metric | Value |
|--------|-------|
| Total Tasks | 130 |
| Passed Tasks | 51 |
| Failed Tasks | 79 |
| Overall Accuracy | 39.2% |
| Avg Semantic Similarity | 0.531 |
| Lost in Middle Score | 0.0% |
| Context Degradation Rate | 1.0% |
| Avg Latency | 2.7ms |
| Total Duration | 2435ms |

## Position Analysis

Accuracy by needle position (detecting 'lost in the middle' effect):

| Position | Tasks | Accuracy | Avg Similarity | Avg Latency |
|----------|-------|----------|----------------|-------------|
| start | 20 | 50.0% | 0.606 | 2ms |
| early | 20 | 55.0% | 0.674 | 3ms |
| middle | 20 | 55.0% | 0.678 | 2ms |
| late | 20 | 50.0% | 0.610 | 3ms |
| end | 20 | 45.0% | 0.583 | 3ms |
| random | 30 | 0.0% | 0.198 | 3ms |

## Context Length Analysis

| Length | Tasks | Accuracy | Avg Similarity |
|--------|-------|----------|----------------|
| 1K | 26 | 42.3% | 0.565 |
| 2K | 26 | 38.5% | 0.539 |
| 4K | 26 | 42.3% | 0.520 |
| 8K | 26 | 34.6% | 0.517 |
| 16K | 26 | 38.5% | 0.513 |

## Benchmark Type Analysis

| Type | Accuracy |
|------|----------|
| niah_basic | 45.3% |
| niah_semantic | 68.0% |
| multi_hop | 0.0% |

## Multi-hop Reasoning Analysis

| Hops | Success Rate |
|------|--------------|
| 2-hop | 0.0% |
| 3-hop | 0.0% |

## Leaderboard Comparison

Comparison to published model scores:

| Model | Overall | vs Ours | Lost in Middle |
|-------|---------|---------|----------------|
| gpt-4-turbo | 91.0% | -51.8% | 12.0% |
| gpt-4o | 94.0% | -54.8% | 8.0% |
| claude-3-opus | 95.0% | -55.8% | 5.0% |
| claude-3-sonnet | 88.0% | -48.8% | 15.0% |
| llama-3.1-70b | 80.0% | -40.8% | 22.0% |
| mistral-large | 76.0% | -36.8% | 25.0% |
| **ElizaOS** | **39.2%** | - | **0.0%** |

## Configuration

```
Context Lengths: [1024, 2048, 4096, 8192, 16384]
Positions: ['start', 'early', 'middle', 'late', 'end']
Tasks per Position: 3
Semantic Threshold: 0.8
Timeout: 60000ms
```
