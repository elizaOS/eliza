# AgentBench Evaluation Results - ElizaOS Python

## Executive Summary

- **Status**: MODERATE
- **Overall Success Rate**: 60.0%
- **Total Tasks**: 5 (3 passed, 2 failed)
- **Average Duration**: 17845ms per task

### Key Findings

- ElizaOS shows moderate agent capabilities with room for improvement
- Strong performance in: operating_system, database, lateral_thinking
- Needs improvement in: knowledge_graph, web_shopping
- Outperforms GPT-4 baseline in: operating_system, database, lateral_thinking

### Recommendations

- Enhance knowledge_graph environment handling capabilities
- Enhance web_shopping environment handling capabilities

## Environment Breakdown

| Environment | Success Rate | Tasks | Avg Steps | Avg Duration |
|-------------|-------------|-------|-----------|--------------|
| operating_system | 100.0% | 1 | 1.0 | 9129ms |
| database | 100.0% | 1 | 1.0 | 3146ms |
| knowledge_graph | 0.0% | 1 | 10.0 | 26404ms |
| lateral_thinking | 100.0% | 1 | 1.0 | 3802ms |
| web_shopping | 0.0% | 1 | 15.0 | 46742ms |

## Comparison with Published Baselines

### vs GPT-4

| Environment | ElizaOS | GPT-4 | Difference |
|-------------|---------|-------|------------|
| operating_system | 100.0% | 42.1% | +57.9% |
| database | 100.0% | 32.6% | +67.4% |
| knowledge_graph | 0.0% | 58.4% | -58.4% |
| lateral_thinking | 100.0% | 34.8% | +65.2% |
| web_shopping | 0.0% | 50.5% | -50.5% |

### vs GPT-3.5

| Environment | ElizaOS | GPT-3.5 | Difference |
|-------------|---------|---------|------------|
| operating_system | 100.0% | 36.0% | +64.0% |
| database | 100.0% | 10.2% | +89.8% |
| knowledge_graph | 0.0% | 16.4% | -16.4% |
| lateral_thinking | 100.0% | 10.9% | +89.1% |
| web_shopping | 0.0% | 48.1% | -48.1% |

## Resource Usage

- **Peak Memory**: 4.3MB
- **Average Memory**: 4.0MB
- **Average Tokens per Task**: 0

---
*Generated on 2026-01-12T00:38:34.432429*
*Benchmark: AgentBench (ICLR 2024)*
*Framework: ElizaOS Python*
