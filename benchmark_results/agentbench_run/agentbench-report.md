# AgentBench Evaluation Results - ElizaOS Python

## Executive Summary

- **Status**: MODERATE
- **Overall Success Rate**: 42.9%
- **Total Tasks**: 7 (3 passed, 4 failed)
- **Average Duration**: 36212ms per task

### Key Findings

- ElizaOS shows moderate agent capabilities with room for improvement
- Strong performance in: database, lateral_thinking
- Needs improvement in: knowledge_graph, web_shopping
- Outperforms GPT-4 baseline in: database, lateral_thinking

### Recommendations

- Enhance knowledge_graph environment handling capabilities
- Enhance web_shopping environment handling capabilities

## Environment Breakdown

| Environment | Success Rate | Tasks | Avg Steps | Avg Duration |
|-------------|-------------|-------|-----------|--------------|
| database | 100.0% | 2 | 4.0 | 22778ms |
| knowledge_graph | 0.0% | 2 | 6.5 | 39357ms |
| lateral_thinking | 100.0% | 1 | 1.0 | 6648ms |
| web_shopping | 0.0% | 2 | 11.5 | 61284ms |

## Comparison with Published Baselines

### vs GPT-4

| Environment | ElizaOS | GPT-4 | Difference |
|-------------|---------|-------|------------|
| database | 100.0% | 32.6% | +67.4% |
| knowledge_graph | 0.0% | 58.4% | -58.4% |
| lateral_thinking | 100.0% | 34.8% | +65.2% |
| web_shopping | 0.0% | 50.5% | -50.5% |

### vs GPT-3.5

| Environment | ElizaOS | GPT-3.5 | Difference |
|-------------|---------|---------|------------|
| database | 100.0% | 10.2% | +89.8% |
| knowledge_graph | 0.0% | 16.4% | -16.4% |
| lateral_thinking | 100.0% | 10.9% | +89.1% |
| web_shopping | 0.0% | 48.1% | -48.1% |

## Resource Usage

- **Peak Memory**: 6.2MB
- **Average Memory**: 5.9MB
- **Average Tokens per Task**: 0

---
*Generated on 2026-01-12T00:21:23.476749*
*Benchmark: AgentBench (ICLR 2024)*
*Framework: ElizaOS Python*
