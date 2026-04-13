# Tau-bench Benchmark Results

## Executive Summary

- **Status**: NEEDS_IMPROVEMENT
- **Overall Success Rate**: 0.0%
- **Total Tasks**: 2 (2 trials)
- **Passed**: 0 | **Failed**: 2
- **Duration**: 12.4s

## Pass^k Reliability Metrics

| k | Pass Rate | Tasks Passed |
|---|-----------|--------------|
| 1 | 0.0% | 0/2 |
| 2 | 0.0% | 0/2 |
| 4 | 0.0% | 0/2 |
| 8 | 0.0% | 0/2 |

## Performance Metrics

| Metric | Score |
|--------|-------|
| Tool Selection Accuracy | 16.7% |
| Policy Compliance | 100.0% |
| Response Quality | 22.5% |
| Avg. Duration | 6186ms |
| Avg. Turns per Task | 9.0 |
| Avg. Tool Calls per Task | 8.0 |

## Domain Results

### Retail Domain

- **Success Rate**: 0.0%
- **Tasks**: 1 (0 passed)
- **Tool Accuracy**: 0.0%
- **Policy Compliance**: 100.0%

### Airline Domain

- **Success Rate**: 0.0%
- **Tasks**: 1 (0 passed)
- **Tool Accuracy**: 33.3%
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
*Generated on 2026-02-11T23:08:41.409406*
*Benchmark: Tau-bench (Tool-Agent-User Interaction)*
