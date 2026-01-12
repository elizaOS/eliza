# Tau-bench Benchmark Results

## Executive Summary

- **Status**: SUCCESS
- **Overall Success Rate**: 87.5%
- **Total Tasks**: 8 (8 trials)
- **Passed**: 7 | **Failed**: 1
- **Duration**: 270.3s

## Pass^k Reliability Metrics

| k | Pass Rate | Tasks Passed |
|---|-----------|--------------|
| 1 | 87.5% | 7/8 |
| 2 | 0.0% | 0/8 |
| 4 | 0.0% | 0/8 |
| 8 | 0.0% | 0/8 |

## Performance Metrics

| Metric | Score |
|--------|-------|
| Tool Selection Accuracy | 41.7% |
| Policy Compliance | 100.0% |
| Response Quality | 40.4% |
| Avg. Duration | 33783ms |
| Avg. Turns per Task | 1.9 |
| Avg. Tool Calls per Task | 0.9 |

## Domain Results

### Retail Domain

- **Success Rate**: 87.5%
- **Tasks**: 8 (7 passed)
- **Tool Accuracy**: 41.7%
- **Policy Compliance**: 100.0%

## Leaderboard Comparison

| Model | Difference |
|-------|------------|
| llama-3.1-70b | +49.3% |
| gpt-4-turbo | +45.4% |
| gpt-4o | +39.0% |
| claude-3-opus | +36.3% |
| o4-mini | +15.7% |
| o3 | +13.6% |
| kimi-k2 | +13.2% |
| claude-3.7-sonnet | +6.3% |
| gemini-3-pro | -3.2% |

**Closest Comparable**: gemini-3-pro

## Key Findings

- Strong overall performance on Tau-bench tasks

## Strengths

- ✅ High task completion rate
- ✅ Strong policy compliance
- ✅ Strong performance in retail domain

## Areas for Improvement

- ⚠️ Tool selection needs improvement

## Recommendations

- 💡 Improve parameter extraction from context

---
*Generated on 2026-01-12T00:21:38.849573*
*Benchmark: Tau-bench (Tool-Agent-User Interaction)*
