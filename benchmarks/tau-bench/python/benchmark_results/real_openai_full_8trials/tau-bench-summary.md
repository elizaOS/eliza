# Tau-bench Benchmark Results

## Executive Summary

- **Status**: SUCCESS
- **Overall Success Rate**: 95.8%
- **Total Tasks**: 18 (144 trials)
- **Passed**: 138 | **Failed**: 6
- **Duration**: 606.1s

## Pass^k Reliability Metrics

| k | Pass Rate | Tasks Passed |
|---|-----------|--------------|
| 1 | 94.4% | 17/18 |
| 2 | 94.4% | 17/18 |
| 4 | 94.4% | 17/18 |
| 8 | 94.4% | 17/18 |

## Performance Metrics

| Metric | Score |
|--------|-------|
| Tool Selection Accuracy | 68.8% |
| Policy Compliance | 98.6% |
| Response Quality | 51.5% |
| Avg. Duration | 4209ms |
| Avg. Turns per Task | 2.4 |
| Avg. Tool Calls per Task | 1.4 |

## Domain Results

### Retail Domain

- **Success Rate**: 90.6%
- **Tasks**: 8 (58 passed)
- **Tool Accuracy**: 80.6%
- **Policy Compliance**: 96.9%

### Airline Domain

- **Success Rate**: 100.0%
- **Tasks**: 10 (80 passed)
- **Tool Accuracy**: 59.4%
- **Policy Compliance**: 100.0%

## Leaderboard Comparison

| Model | Difference |
|-------|------------|
| llama-3.1-70b | +58.4% |
| gpt-4-turbo | +54.4% |
| gpt-4o | +48.0% |
| claude-3-opus | +45.3% |
| o4-mini | +24.7% |
| o3 | +22.6% |
| kimi-k2 | +22.1% |
| claude-3.7-sonnet | +14.8% |
| gemini-3-pro | +5.4% |

**Closest Comparable**: gemini-3-pro

## Key Findings

- Strong overall performance on Tau-bench tasks

## Strengths

- ✅ High task completion rate
- ✅ Strong policy compliance
- ✅ Strong performance in retail domain
- ✅ Strong performance in airline domain

## Areas for Improvement


## Recommendations


---
*Generated on 2026-01-12T00:55:20.910249*
*Benchmark: Tau-bench (Tool-Agent-User Interaction)*
