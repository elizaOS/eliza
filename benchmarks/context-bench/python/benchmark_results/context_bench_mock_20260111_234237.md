# Context Benchmark Results

*Generated: 2026-01-11T23:42:37.962341*

## Executive Summary

**Status:** needs_improvement
**Overall Accuracy:** 70.0%

### Key Findings
- Moderate retrieval accuracy (70-85%)
- Struggles with 2-hop reasoning (0.0% success)
- Struggles with 3-hop reasoning (0.0% success)
- Performance below Claude-3-Opus (-25.0%)

### Recommendations
- Consider chain-of-thought prompting for 2+ hop questions
- Consider chain-of-thought prompting for 3+ hop questions

## Overall Metrics

| Metric | Value |
|--------|-------|
| Total Tasks | 130 |
| Passed Tasks | 91 |
| Failed Tasks | 39 |
| Overall Accuracy | 70.0% |
| Avg Semantic Similarity | 0.746 |
| Lost in Middle Score | 2.7% |
| Context Degradation Rate | -1.0% |
| Avg Latency | 1.8ms |
| Total Duration | 2247ms |

## Position Analysis

Accuracy by needle position (detecting 'lost in the middle' effect):

| Position | Tasks | Accuracy | Avg Similarity | Avg Latency |
|----------|-------|----------|----------------|-------------|
| start | 20 | 85.0% | 0.918 | 1ms |
| early | 20 | 80.0% | 0.839 | 2ms |
| middle | 20 | 90.0% | 0.921 | 1ms |
| late | 20 | 100.0% | 0.990 | 1ms |
| end | 20 | 100.0% | 0.985 | 2ms |
| random | 30 | 0.0% | 0.129 | 3ms |

## Context Length Analysis

| Length | Tasks | Accuracy | Avg Similarity |
|--------|-------|----------|----------------|
| 1K | 26 | 65.4% | 0.738 |
| 2K | 26 | 76.9% | 0.778 |
| 4K | 26 | 61.5% | 0.691 |
| 8K | 26 | 76.9% | 0.783 |
| 16K | 26 | 69.2% | 0.738 |

## Benchmark Type Analysis

| Type | Accuracy |
|------|----------|
| niah_basic | 97.3% |
| niah_semantic | 72.0% |
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
| gpt-4-turbo | 91.0% | -21.0% | 12.0% |
| gpt-4o | 94.0% | -24.0% | 8.0% |
| claude-3-opus | 95.0% | -25.0% | 5.0% |
| claude-3-sonnet | 88.0% | -18.0% | 15.0% |
| llama-3.1-70b | 80.0% | -10.0% | 22.0% |
| mistral-large | 76.0% | -6.0% | 25.0% |
| **ElizaOS** | **70.0%** | - | **2.7%** |

## Configuration

```
Context Lengths: [1024, 2048, 4096, 8192, 16384]
Positions: ['start', 'early', 'middle', 'late', 'end']
Tasks per Position: 3
Semantic Threshold: 0.8
Timeout: 60000ms
```
