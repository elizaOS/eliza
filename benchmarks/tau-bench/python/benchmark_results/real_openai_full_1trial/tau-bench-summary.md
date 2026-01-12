# Tau-bench Benchmark Results

## Executive Summary

- **Status**: SUCCESS
- **Overall Success Rate**: 88.9%
- **Total Tasks**: 18 (18 trials)
- **Passed**: 16 | **Failed**: 2
- **Duration**: 60.3s

## Pass^k Reliability Metrics

| k | Pass Rate | Tasks Passed |
|---|-----------|--------------|
| 1 | 88.9% | 16/18 |
| 2 | 0.0% | 0/18 |
| 4 | 0.0% | 0/18 |
| 8 | 0.0% | 0/18 |

## Performance Metrics

| Metric | Score |
|--------|-------|
| Tool Selection Accuracy | 44.0% |
| Policy Compliance | 100.0% |
| Response Quality | 45.8% |
| Avg. Duration | 3351ms |
| Avg. Turns per Task | 2.0 |
| Avg. Tool Calls per Task | 1.0 |

## Domain Results

### Retail Domain

- **Success Rate**: 87.5%
- **Tasks**: 8 (7 passed)
- **Tool Accuracy**: 39.6%
- **Policy Compliance**: 100.0%

### Airline Domain

- **Success Rate**: 90.0%
- **Tasks**: 10 (9 passed)
- **Tool Accuracy**: 47.5%
- **Policy Compliance**: 100.0%

## Leaderboard Comparison

| Model | Difference |
|-------|------------|
| llama-3.1-70b | +51.8% |
| gpt-4-turbo | +47.8% |
| gpt-4o | +41.4% |
| claude-3-opus | +38.7% |
| o4-mini | +18.1% |
| o3 | +16.1% |
| kimi-k2 | +15.6% |
| claude-3.7-sonnet | +8.2% |
| gemini-3-pro | -1.2% |

**Closest Comparable**: gemini-3-pro

## Key Findings

- Strong overall performance on Tau-bench tasks

## Strengths

- ✅ High task completion rate
- ✅ Strong policy compliance
- ✅ Strong performance in retail domain
- ✅ Strong performance in airline domain

## Areas for Improvement

- ⚠️ Tool selection needs improvement

## Recommendations

- 💡 Improve parameter extraction from context

---
*Generated on 2026-01-12T00:34:17.892597*
*Benchmark: Tau-bench (Tool-Agent-User Interaction)*
