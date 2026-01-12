# Context Benchmark Results

*Generated: 2026-01-12T00:27:47.054152*

## Executive Summary

**Status:** excellent
**Overall Accuracy:** 91.7%

### Key Findings
- Good overall retrieval accuracy (85-95%)
- Significant 'lost in middle' effect detected (25.0% drop)
- Performance within 10% of Claude-3-Opus (-3.3%)

### Recommendations
- Consider chunking strategies or retrieval augmentation for middle content

## Overall Metrics

| Metric | Value |
|--------|-------|
| Total Tasks | 12 |
| Passed Tasks | 11 |
| Failed Tasks | 1 |
| Overall Accuracy | 91.7% |
| Avg Semantic Similarity | 0.917 |
| Lost in Middle Score | 25.0% |
| Context Degradation Rate | -8.3% |
| Avg Latency | 3009.6ms |
| Total Duration | 36144ms |

## Position Analysis

Accuracy by needle position (detecting 'lost in the middle' effect):

| Position | Tasks | Accuracy | Avg Similarity | Avg Latency |
|----------|-------|----------|----------------|-------------|
| start | 4 | 100.0% | 1.000 | 2489ms |
| middle | 4 | 75.0% | 0.750 | 3930ms |
| end | 4 | 100.0% | 1.000 | 2610ms |

## Context Length Analysis

| Length | Tasks | Accuracy | Avg Similarity |
|--------|-------|----------|----------------|
| 1K | 6 | 83.3% | 0.833 |
| 4K | 6 | 100.0% | 1.000 |

## Benchmark Type Analysis

| Type | Accuracy |
|------|----------|
| niah_basic | 91.7% |

## Leaderboard Comparison

Comparison to published model scores:

| Model | Overall | vs Ours | Lost in Middle |
|-------|---------|---------|----------------|
| gpt-4-turbo | 91.0% | +0.7% | 12.0% |
| gpt-4o | 94.0% | -2.3% | 8.0% |
| claude-3-opus | 95.0% | -3.3% | 5.0% |
| claude-3-sonnet | 88.0% | +3.7% | 15.0% |
| llama-3.1-70b | 80.0% | +11.7% | 22.0% |
| mistral-large | 76.0% | +15.7% | 25.0% |
| **ElizaOS** | **91.7%** | - | **25.0%** |

## Configuration

```
Context Lengths: [1024, 4096]
Positions: ['start', 'middle', 'end']
Tasks per Position: 2
Semantic Threshold: 0.8
Timeout: 60000ms
```
