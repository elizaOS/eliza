# Tau-bench Benchmark Results

## Executive Summary

- **Status**: PARTIAL
- **Overall Success Rate**: 50.0%
- **Total Tasks**: 2 (2 trials)
- **Passed**: 1 | **Failed**: 1
- **Duration**: 6.1s

## Pass^k Reliability Metrics

| k | Pass Rate | Tasks Passed |
|---|-----------|--------------|
| 1 | 50.0% | 1/2 |
| 2 | 0.0% | 0/2 |
| 4 | 0.0% | 0/2 |
| 8 | 0.0% | 0/2 |

## Performance Metrics

| Metric | Score |
|--------|-------|
| Tool Selection Accuracy | 12.5% |
| Policy Compliance | 100.0% |
| Response Quality | 28.7% |
| Avg. Duration | 3054ms |
| Avg. Turns per Task | 2.0 |
| Avg. Tool Calls per Task | 1.0 |

## Domain Results

### Airline Domain

- **Success Rate**: 50.0%
- **Tasks**: 2 (1 passed)
- **Tool Accuracy**: 12.5%
- **Policy Compliance**: 100.0%

## Leaderboard Comparison

| Model | Difference |
|-------|------------|
| llama-3.1-70b | +14.4% |
| gpt-4-turbo | +10.2% |
| gpt-4o | +3.8% |
| claude-3-opus | +1.1% |
| o4-mini | -19.5% |
| o3 | -21.5% |
| kimi-k2 | -22.1% |
| claude-3.7-sonnet | -29.8% |
| gemini-3-pro | -39.2% |

**Closest Comparable**: claude-3-opus

## Key Findings

- Moderate performance with room for improvement

## Strengths

- ✅ Strong policy compliance

## Areas for Improvement

- ⚠️ Tool selection needs improvement

## Recommendations

- 💡 Improve parameter extraction from context

---
*Generated on 2026-01-12T00:32:31.031223*
*Benchmark: Tau-bench (Tool-Agent-User Interaction)*
