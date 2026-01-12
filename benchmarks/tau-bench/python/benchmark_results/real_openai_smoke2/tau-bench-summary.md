# Tau-bench Benchmark Results

## Executive Summary

- **Status**: SUCCESS
- **Overall Success Rate**: 100.0%
- **Total Tasks**: 1 (1 trials)
- **Passed**: 1 | **Failed**: 0
- **Duration**: 5.5s

## Pass^k Reliability Metrics

| k | Pass Rate | Tasks Passed |
|---|-----------|--------------|
| 1 | 100.0% | 1/1 |
| 2 | 0.0% | 0/1 |
| 4 | 0.0% | 0/1 |
| 8 | 0.0% | 0/1 |

## Performance Metrics

| Metric | Score |
|--------|-------|
| Tool Selection Accuracy | 25.0% |
| Policy Compliance | 100.0% |
| Response Quality | 63.3% |
| Avg. Duration | 5476ms |
| Avg. Turns per Task | 2.0 |
| Avg. Tool Calls per Task | 1.0 |

## Domain Results

### Retail Domain

- **Success Rate**: 100.0%
- **Tasks**: 1 (1 passed)
- **Tool Accuracy**: 25.0%
- **Policy Compliance**: 100.0%

## Leaderboard Comparison

| Model | Difference |
|-------|------------|
| llama-3.1-70b | +61.8% |
| gpt-4-turbo | +57.9% |
| gpt-4o | +51.5% |
| claude-3-opus | +48.8% |
| o4-mini | +28.2% |
| o3 | +26.1% |
| kimi-k2 | +25.7% |
| claude-3.7-sonnet | +18.8% |
| gemini-3-pro | +9.3% |

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
*Generated on 2026-01-12T00:28:33.400217*
*Benchmark: Tau-bench (Tool-Agent-User Interaction)*
