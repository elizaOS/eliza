# Context Benchmark Results

*Generated: 2026-02-14T19:55:51.170513*

## Executive Summary

**Status:** needs_improvement
**Overall Accuracy:** 0.0%

### Key Findings
- Low retrieval accuracy (<70%)
- Performance below Claude-3-Opus (-95.0%)

### Recommendations
- Consider using a model with better context handling

## Overall Metrics

| Metric | Value |
|--------|-------|
| Total Tasks | 12 |
| Passed Tasks | 0 |
| Failed Tasks | 12 |
| Overall Accuracy | 0.0% |
| Avg Semantic Similarity | 0.000 |
| Lost in Middle Score | 0.0% |
| Context Degradation Rate | 0.0% |
| Avg Latency | 0.0ms |
| Total Duration | 41ms |

## Position Analysis

Accuracy by needle position (detecting 'lost in the middle' effect):

| Position | Tasks | Accuracy | Avg Similarity | Avg Latency |
|----------|-------|----------|----------------|-------------|
| start | 4 | 0.0% | 0.000 | 0ms |
| middle | 4 | 0.0% | 0.000 | 0ms |
| end | 4 | 0.0% | 0.000 | 0ms |

## Context Length Analysis

| Length | Tasks | Accuracy | Avg Similarity |
|--------|-------|----------|----------------|
| 1K | 6 | 0.0% | 0.000 |
| 4K | 6 | 0.0% | 0.000 |

## Benchmark Type Analysis

| Type | Accuracy |
|------|----------|
| niah_basic | 0.0% |

## Leaderboard Comparison

Comparison to published model scores:

| Model | Overall | vs Ours | Lost in Middle |
|-------|---------|---------|----------------|
| gpt-4-turbo | 91.0% | -91.0% | 12.0% |
| gpt-5 | 94.0% | -94.0% | 8.0% |
| claude-3-opus | 95.0% | -95.0% | 5.0% |
| claude-3-sonnet | 88.0% | -88.0% | 15.0% |
| llama-3.1-70b | 80.0% | -80.0% | 22.0% |
| mistral-large | 76.0% | -76.0% | 25.0% |
| **ElizaOS** | **0.0%** | - | **0.0%** |

## Configuration

```
Context Lengths: [1024, 4096]
Positions: ['start', 'middle', 'end']
Tasks per Position: 2
Semantic Threshold: 0.8
Timeout: 60000ms
```
