# Tau-bench Benchmark Results

## Executive Summary

- **Status**: SUCCESS
- **Overall Success Rate**: 75.0%
- **Total Tasks**: 4 (16 trials)
- **Passed**: 12 | **Failed**: 4
- **Duration**: 0.0s

## Pass^k Reliability Metrics

| k | Pass Rate | Tasks Passed |
|---|-----------|--------------|
| 1 | 75.0% | 3/4 |
| 2 | 75.0% | 3/4 |
| 4 | 75.0% | 3/4 |
| 8 | 0.0% | 0/4 |

## Performance Metrics

| Metric | Score |
|--------|-------|
| Tool Selection Accuracy | 100.0% |
| Policy Compliance | 100.0% |
| Response Quality | 100.0% |
| Avg. Duration | 1ms |
| Avg. Turns per Task | 3.0 |
| Avg. Tool Calls per Task | 2.0 |

## Domain Results

### Retail Domain

- **Success Rate**: 100.0%
- **Tasks**: 2 (8 passed)
- **Tool Accuracy**: 100.0%
- **Policy Compliance**: 100.0%

### Airline Domain

- **Success Rate**: 50.0%
- **Tasks**: 2 (4 passed)
- **Tool Accuracy**: 100.0%
- **Policy Compliance**: 100.0%

## Leaderboard Comparison

| Model | Difference |
|-------|------------|
| llama-3.1-70b | +38.1% |
| gpt-4-turbo | +34.0% |
| gpt-4o | +27.6% |
| claude-3-opus | +24.9% |
| o4-mini | +4.4% |
| o3 | +2.3% |
| kimi-k2 | +1.8% |
| claude-3.7-sonnet | -5.5% |
| gemini-3-pro | -15.0% |

**Closest Comparable**: kimi-k2

## Key Findings

- Strong overall performance on Tau-bench tasks

## Strengths

- ✅ High task completion rate
- ✅ Excellent tool selection and parameter extraction
- ✅ Strong policy compliance
- ✅ Strong performance in retail domain

## Areas for Improvement


## Recommendations


---
*Generated on 2026-01-11T23:42:06.311308*
*Benchmark: Tau-bench (Tool-Agent-User Interaction)*
