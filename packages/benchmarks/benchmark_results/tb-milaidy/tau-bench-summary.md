# Tau-bench Benchmark Results

## Executive Summary

- **Status**: NEEDS_IMPROVEMENT
- **Overall Success Rate**: 0.0%
- **Total Tasks**: 4 (4 trials)
- **Passed**: 0 | **Failed**: 4
- **Duration**: 29.1s

## Pass^k Reliability Metrics

| k | Pass Rate | Tasks Passed |
|---|-----------|--------------|
| 1 | 0.0% | 0/4 |
| 2 | 0.0% | 0/4 |
| 4 | 0.0% | 0/4 |
| 8 | 0.0% | 0/4 |

## Performance Metrics

| Metric | Score |
|--------|-------|
| Tool Selection Accuracy | 12.5% |
| Policy Compliance | 100.0% |
| Response Quality | 14.9% |
| Avg. Duration | 7270ms |
| Avg. Turns per Task | 1.2 |
| Avg. Tool Calls per Task | 0.2 |

## Domain Results

### Retail Domain

- **Success Rate**: 0.0%
- **Tasks**: 2 (0 passed)
- **Tool Accuracy**: 25.0%
- **Policy Compliance**: 100.0%

### Airline Domain

- **Success Rate**: 0.0%
- **Tasks**: 2 (0 passed)
- **Tool Accuracy**: 0.0%
- **Policy Compliance**: 100.0%

## Leaderboard Comparison

| Model | Difference |
|-------|------------|
| llama-3.1-70b | -36.9% |
| gpt-4-turbo | -40.9% |
| gpt-5 | -47.4% |
| claude-3-opus | -50.0% |
| o4-mini | -70.6% |
| o3 | -72.7% |
| kimi-k2 | -73.2% |
| claude-3.7-sonnet | -80.5% |
| gemini-3-pro | -90.0% |

**Closest Comparable**: llama-3.1-70b

## Key Findings

- Significant improvement needed in task completion

## Strengths

- ✅ Strong policy compliance

## Areas for Improvement

- ⚠️ Low overall success rate
- ⚠️ Tool selection needs improvement
- ⚠️ Weak performance in retail domain
- ⚠️ Weak performance in airline domain

## Recommendations

- 💡 Focus on improving tool selection accuracy
- 💡 Improve parameter extraction from context

---
*Generated on 2026-02-06T10:53:59.269868*
*Benchmark: Tau-bench (Tool-Agent-User Interaction)*
