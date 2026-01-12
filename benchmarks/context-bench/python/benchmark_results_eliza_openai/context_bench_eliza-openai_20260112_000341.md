# Context Benchmark Results

*Generated: 2026-01-12T00:03:41.192808*

## Executive Summary

**Status:** good
**Overall Accuracy:** 83.3%

### Key Findings
- Moderate retrieval accuracy (70-85%)
- Performance below Claude-3-Opus (-11.7%)

## Overall Metrics

| Metric | Value |
|--------|-------|
| Total Tasks | 12 |
| Passed Tasks | 10 |
| Failed Tasks | 2 |
| Overall Accuracy | 83.3% |
| Avg Semantic Similarity | 0.833 |
| Lost in Middle Score | 0.0% |
| Context Degradation Rate | 0.0% |
| Avg Latency | 3527.1ms |
| Total Duration | 42403ms |

## Position Analysis

Accuracy by needle position (detecting 'lost in the middle' effect):

| Position | Tasks | Accuracy | Avg Similarity | Avg Latency |
|----------|-------|----------|----------------|-------------|
| start | 4 | 75.0% | 0.750 | 3671ms |
| middle | 4 | 100.0% | 1.000 | 3798ms |
| end | 4 | 75.0% | 0.750 | 3112ms |

## Context Length Analysis

| Length | Tasks | Accuracy | Avg Similarity |
|--------|-------|----------|----------------|
| 1K | 6 | 83.3% | 0.833 |
| 4K | 6 | 83.3% | 0.833 |

## Benchmark Type Analysis

| Type | Accuracy |
|------|----------|
| niah_basic | 83.3% |

## Leaderboard Comparison

Comparison to published model scores:

| Model | Overall | vs Ours | Lost in Middle |
|-------|---------|---------|----------------|
| gpt-4-turbo | 91.0% | -7.7% | 12.0% |
| gpt-4o | 94.0% | -10.7% | 8.0% |
| claude-3-opus | 95.0% | -11.7% | 5.0% |
| claude-3-sonnet | 88.0% | -4.7% | 15.0% |
| llama-3.1-70b | 80.0% | +3.3% | 22.0% |
| mistral-large | 76.0% | +7.3% | 25.0% |
| **ElizaOS** | **83.3%** | - | **0.0%** |

## Configuration

```
Context Lengths: [1024, 4096]
Positions: ['start', 'middle', 'end']
Tasks per Position: 2
Semantic Threshold: 0.8
Timeout: 60000ms
```
