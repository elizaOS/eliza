# Context Benchmark Results

*Generated: 2026-01-11T23:58:33.850415*

## Executive Summary

**Status:** needs_improvement
**Overall Accuracy:** 25.0%

### Key Findings
- Low retrieval accuracy (<70%)
- Performance below Claude-3-Opus (-70.0%)

### Recommendations
- Consider using a model with better context handling

## Overall Metrics

| Metric | Value |
|--------|-------|
| Total Tasks | 12 |
| Passed Tasks | 3 |
| Failed Tasks | 9 |
| Overall Accuracy | 25.0% |
| Avg Semantic Similarity | 0.250 |
| Lost in Middle Score | 0.0% |
| Context Degradation Rate | -8.3% |
| Avg Latency | 2448.2ms |
| Total Duration | 29407ms |

## Position Analysis

Accuracy by needle position (detecting 'lost in the middle' effect):

| Position | Tasks | Accuracy | Avg Similarity | Avg Latency |
|----------|-------|----------|----------------|-------------|
| start | 4 | 25.0% | 0.250 | 2861ms |
| middle | 4 | 25.0% | 0.250 | 2355ms |
| end | 4 | 25.0% | 0.250 | 2128ms |

## Context Length Analysis

| Length | Tasks | Accuracy | Avg Similarity |
|--------|-------|----------|----------------|
| 1K | 6 | 16.7% | 0.167 |
| 4K | 6 | 33.3% | 0.333 |

## Benchmark Type Analysis

| Type | Accuracy |
|------|----------|
| niah_basic | 25.0% |

## Leaderboard Comparison

Comparison to published model scores:

| Model | Overall | vs Ours | Lost in Middle |
|-------|---------|---------|----------------|
| gpt-4-turbo | 91.0% | -66.0% | 12.0% |
| gpt-4o | 94.0% | -69.0% | 8.0% |
| claude-3-opus | 95.0% | -70.0% | 5.0% |
| claude-3-sonnet | 88.0% | -63.0% | 15.0% |
| llama-3.1-70b | 80.0% | -55.0% | 22.0% |
| mistral-large | 76.0% | -51.0% | 25.0% |
| **ElizaOS** | **25.0%** | - | **0.0%** |

## Configuration

```
Context Lengths: [1024, 4096]
Positions: ['start', 'middle', 'end']
Tasks per Position: 2
Semantic Threshold: 0.8
Timeout: 60000ms
```
