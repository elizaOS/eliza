# Tau-bench Benchmark Results

## Executive Summary

- **Status**: NEEDS_IMPROVEMENT
- **Overall Success Rate**: 25.0%
- **Total Tasks**: 4 (4 trials)
- **Passed**: 1 | **Failed**: 3
- **Duration**: 42.8s

## Pass^k Reliability Metrics

| k | Pass Rate | Tasks Passed |
|---|-----------|--------------|
| 1 | 25.0% | 1/4 |
| 2 | 0.0% | 0/4 |
| 4 | 0.0% | 0/4 |
| 8 | 0.0% | 0/4 |

## Performance Metrics

| Metric | Score |
|--------|-------|
| Tool Selection Accuracy | 14.6% |
| Policy Compliance | 100.0% |
| Response Quality | 32.2% |
| Avg. Duration | 10689ms |
| Avg. Turns per Task | 9.0 |
| Avg. Tool Calls per Task | 8.0 |

## Domain Results

### Retail Domain

- **Success Rate**: 50.0%
- **Tasks**: 2 (1 passed)
- **Tool Accuracy**: 12.5%
- **Policy Compliance**: 100.0%

### Airline Domain

- **Success Rate**: 0.0%
- **Tasks**: 2 (0 passed)
- **Tool Accuracy**: 16.7%
- **Policy Compliance**: 100.0%

## Leaderboard Comparison

| Model | Difference |
|-------|------------|
| llama-3.1-70b | -11.9% |
| gpt-4-turbo | -16.0% |
| gpt-5 | -22.4% |
| claude-3-opus | -25.1% |
| o4-mini | -45.6% |
| o3 | -47.7% |
| kimi-k2 | -48.2% |
| claude-3.7-sonnet | -55.5% |
| gemini-3-pro | -65.0% |

**Closest Comparable**: llama-3.1-70b

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
*Generated on 2026-02-14T20:02:58.886834*
*Benchmark: Tau-bench (Tool-Agent-User Interaction)*
