# Context Benchmark Results

*Generated: 2026-01-12T00:28:42.162877*

## Executive Summary

**Status:** excellent
**Overall Accuracy:** 100.0%

### Key Findings
- Excellent overall retrieval accuracy (≥95%)
- Performance matches or exceeds Claude-3-Opus baseline (+5.0%)

## Overall Metrics

| Metric | Value |
|--------|-------|
| Total Tasks | 12 |
| Passed Tasks | 12 |
| Failed Tasks | 0 |
| Overall Accuracy | 100.0% |
| Avg Semantic Similarity | 0.604 |
| Lost in Middle Score | 0.0% |
| Context Degradation Rate | 0.0% |
| Avg Latency | 753.7ms |
| Total Duration | 9083ms |

## Position Analysis

Accuracy by needle position (detecting 'lost in the middle' effect):

| Position | Tasks | Accuracy | Avg Similarity | Avg Latency |
|----------|-------|----------|----------------|-------------|
| start | 4 | 100.0% | 0.711 | 935ms |
| middle | 4 | 100.0% | 0.538 | 641ms |
| end | 4 | 100.0% | 0.562 | 685ms |

## Context Length Analysis

| Length | Tasks | Accuracy | Avg Similarity |
|--------|-------|----------|----------------|
| 1K | 6 | 100.0% | 0.645 |
| 4K | 6 | 100.0% | 0.562 |

## Benchmark Type Analysis

| Type | Accuracy |
|------|----------|
| niah_basic | 100.0% |

## Leaderboard Comparison

Comparison to published model scores:

| Model | Overall | vs Ours | Lost in Middle |
|-------|---------|---------|----------------|
| gpt-4-turbo | 91.0% | +9.0% | 12.0% |
| gpt-4o | 94.0% | +6.0% | 8.0% |
| claude-3-opus | 95.0% | +5.0% | 5.0% |
| claude-3-sonnet | 88.0% | +12.0% | 15.0% |
| llama-3.1-70b | 80.0% | +20.0% | 22.0% |
| mistral-large | 76.0% | +24.0% | 25.0% |
| **ElizaOS** | **100.0%** | - | **0.0%** |

## Configuration

```
Context Lengths: [1024, 4096]
Positions: ['start', 'middle', 'end']
Tasks per Position: 2
Semantic Threshold: 0.8
Timeout: 60000ms
```
