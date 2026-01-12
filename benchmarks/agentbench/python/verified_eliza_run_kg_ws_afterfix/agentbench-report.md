# AgentBench Evaluation Results - ElizaOS Python

## Executive Summary

- **Status**: MODERATE
- **Overall Success Rate**: 50.0%
- **Total Tasks**: 2 (1 passed, 1 failed)
- **Average Duration**: 36612ms per task

### Key Findings

- ElizaOS shows moderate agent capabilities with room for improvement
- Strong performance in: knowledge_graph
- Needs improvement in: web_shopping
- Outperforms GPT-4 baseline in: knowledge_graph

### Recommendations

- Enhance web_shopping environment handling capabilities

## Environment Breakdown

| Environment | Success Rate | Tasks | Avg Steps | Avg Duration |
|-------------|-------------|-------|-----------|--------------|
| knowledge_graph | 100.0% | 1 | 3.0 | 11995ms |
| web_shopping | 0.0% | 1 | 15.0 | 61229ms |

## Comparison with Published Baselines

### vs GPT-4

| Environment | ElizaOS | GPT-4 | Difference |
|-------------|---------|-------|------------|
| knowledge_graph | 100.0% | 58.4% | +41.6% |
| web_shopping | 0.0% | 50.5% | -50.5% |

### vs GPT-3.5

| Environment | ElizaOS | GPT-3.5 | Difference |
|-------------|---------|---------|------------|
| knowledge_graph | 100.0% | 16.4% | +83.6% |
| web_shopping | 0.0% | 48.1% | -48.1% |

## Resource Usage

- **Peak Memory**: 4.1MB
- **Average Memory**: 3.9MB
- **Average Tokens per Task**: 0

---
*Generated on 2026-01-12T00:44:04.395199*
*Benchmark: AgentBench (ICLR 2024)*
*Framework: ElizaOS Python*
