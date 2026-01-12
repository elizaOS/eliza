# Tau-bench Benchmark Results

## Executive Summary

- **Status**: SUCCESS
- **Overall Success Rate**: 75.0%
- **Total Tasks**: 4 (4 trials)
- **Passed**: 3 | **Failed**: 1
- **Duration**: 19.2s

## Pass^k Reliability Metrics

| k | Pass Rate | Tasks Passed |
|---|-----------|--------------|
| 1 | 75.0% | 3/4 |
| 2 | 0.0% | 0/4 |
| 4 | 0.0% | 0/4 |
| 8 | 0.0% | 0/4 |

## Performance Metrics

| Metric | Score |
|--------|-------|
| Tool Selection Accuracy | 27.1% |
| Policy Compliance | 100.0% |
| Response Quality | 40.2% |
| Avg. Duration | 4791ms |
| Avg. Turns per Task | 2.2 |
| Avg. Tool Calls per Task | 1.2 |

## Domain Results

### Retail Domain

- **Success Rate**: 100.0%
- **Tasks**: 2 (2 passed)
- **Tool Accuracy**: 25.0%
- **Policy Compliance**: 100.0%

### Airline Domain

- **Success Rate**: 50.0%
- **Tasks**: 2 (1 passed)
- **Tool Accuracy**: 29.2%
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
- ✅ Strong policy compliance
- ✅ Strong performance in retail domain

## Areas for Improvement

- ⚠️ Tool selection needs improvement

## Recommendations

- 💡 Improve parameter extraction from context

---
*Generated on 2026-01-12T00:29:41.216886*
*Benchmark: Tau-bench (Tool-Agent-User Interaction)*
