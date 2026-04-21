# Tau-bench Benchmark Results

## Executive Summary

- **Status**: NEEDS_IMPROVEMENT
- **Overall Success Rate**: 38.9%
- **Total Tasks**: 18 (18 trials)
- **Passed**: 7 | **Failed**: 11
- **Duration**: 92.0s

## Pass^k Reliability Metrics

| k | Pass Rate | Tasks Passed |
|---|-----------|--------------|
| 1 | 38.9% | 7/18 |
| 2 | 0.0% | 0/18 |
| 4 | 0.0% | 0/18 |
| 8 | 0.0% | 0/18 |

## Performance Metrics

| Metric | Score |
|--------|-------|
| Tool Selection Accuracy | 37.7% |
| Policy Compliance | 94.4% |
| Response Quality | 34.4% |
| Avg. Duration | 5112ms |
| Avg. Turns per Task | 7.2 |
| Avg. Tool Calls per Task | 6.2 |

## Domain Results

### Retail Domain

- **Success Rate**: 50.0%
- **Tasks**: 8 (4 passed)
- **Tool Accuracy**: 37.5%
- **Policy Compliance**: 87.5%

### Airline Domain

- **Success Rate**: 30.0%
- **Tasks**: 10 (3 passed)
- **Tool Accuracy**: 37.8%
- **Policy Compliance**: 100.0%

## Leaderboard Comparison

| Model | Difference |
|-------|------------|
| llama-3.1-70b | +3.1% |
| gpt-4-turbo | -1.0% |
| gpt-5 | -7.4% |
| claude-3-opus | -10.1% |
| o4-mini | -30.6% |
| o3 | -32.7% |
| kimi-k2 | -33.2% |
| claude-3.7-sonnet | -40.5% |
| gemini-3-pro | -50.0% |

**Closest Comparable**: gpt-4-turbo

## Key Findings

- Significant improvement needed in task completion

## Strengths

- ✅ Strong policy compliance

## Areas for Improvement

- ⚠️ Low overall success rate
- ⚠️ Tool selection needs improvement
- ⚠️ Weak performance in airline domain

## Recommendations

- 💡 Focus on improving tool selection accuracy
- 💡 Improve parameter extraction from context

---
*Generated on 2026-02-11T23:47:19.761389*
*Benchmark: Tau-bench (Tool-Agent-User Interaction)*
