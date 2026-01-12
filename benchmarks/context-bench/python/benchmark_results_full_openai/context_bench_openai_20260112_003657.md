# Context Benchmark Results

*Generated: 2026-01-12T00:36:57.583557*

## Executive Summary

**Status:** excellent
**Overall Accuracy:** 100.0%

### Key Findings
- Excellent overall retrieval accuracy (≥95%)
- Performance matches or exceeds Claude-3-Opus baseline (+5.0%)

## Overall Metrics

| Metric | Value |
|--------|-------|
| Total Tasks | 130 |
| Passed Tasks | 130 |
| Failed Tasks | 0 |
| Overall Accuracy | 100.0% |
| Avg Semantic Similarity | 0.410 |
| Lost in Middle Score | 0.0% |
| Context Degradation Rate | 0.0% |
| Avg Latency | 1125.6ms |
| Total Duration | 156286ms |

## Position Analysis

Accuracy by needle position (detecting 'lost in the middle' effect):

| Position | Tasks | Accuracy | Avg Similarity | Avg Latency |
|----------|-------|----------|----------------|-------------|
| start | 20 | 100.0% | 0.472 | 1104ms |
| early | 20 | 100.0% | 0.434 | 1014ms |
| middle | 20 | 100.0% | 0.458 | 1030ms |
| late | 20 | 100.0% | 0.437 | 1152ms |
| end | 20 | 100.0% | 0.449 | 1097ms |
| random | 30 | 100.0% | 0.279 | 1279ms |

## Context Length Analysis

| Length | Tasks | Accuracy | Avg Similarity |
|--------|-------|----------|----------------|
| 1K | 26 | 100.0% | 0.466 |
| 2K | 26 | 100.0% | 0.412 |
| 4K | 26 | 100.0% | 0.392 |
| 8K | 26 | 100.0% | 0.377 |
| 16K | 26 | 100.0% | 0.405 |

## Benchmark Type Analysis

| Type | Accuracy |
|------|----------|
| niah_basic | 100.0% |
| niah_semantic | 100.0% |
| multi_hop | 100.0% |

## Multi-hop Reasoning Analysis

| Hops | Success Rate |
|------|--------------|
| 2-hop | 100.0% |
| 3-hop | 100.0% |

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
Context Lengths: [1024, 2048, 4096, 8192, 16384]
Positions: ['start', 'early', 'middle', 'late', 'end']
Tasks per Position: 3
Semantic Threshold: 0.8
Timeout: 60000ms
```
