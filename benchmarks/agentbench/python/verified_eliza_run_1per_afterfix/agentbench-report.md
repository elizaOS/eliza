# AgentBench Evaluation Results - ElizaOS Python

## Executive Summary

- **Status**: MODERATE
- **Overall Success Rate**: 60.0%
- **Total Tasks**: 5 (3 passed, 2 failed)
- **Average Duration**: 6760ms per task

### Key Findings

- ElizaOS shows moderate agent capabilities with room for improvement
- Strong performance in: operating_system, database, web_shopping
- Needs improvement in: knowledge_graph, lateral_thinking
- Outperforms GPT-4 baseline in: operating_system, database, web_shopping

### Recommendations

- Enhance knowledge_graph environment handling capabilities
- Enhance lateral_thinking environment handling capabilities

## Environment Breakdown

| Environment | Success Rate | Tasks | Avg Steps | Avg Duration |
|-------------|-------------|-------|-----------|--------------|
| operating_system | 100.0% | 1 | 1.0 | 1172ms |
| database | 100.0% | 1 | 1.0 | 4551ms |
| knowledge_graph | 0.0% | 1 | 10.0 | 10240ms |
| lateral_thinking | 0.0% | 1 | 20.0 | 15663ms |
| web_shopping | 100.0% | 1 | 5.0 | 2176ms |

## Comparison with Published Baselines

### vs GPT-4

| Environment | ElizaOS | GPT-4 | Difference |
|-------------|---------|-------|------------|
| operating_system | 100.0% | 42.1% | +57.9% |
| database | 100.0% | 32.6% | +67.4% |
| knowledge_graph | 0.0% | 58.4% | -58.4% |
| lateral_thinking | 0.0% | 34.8% | -34.8% |
| web_shopping | 100.0% | 50.5% | +49.5% |

### vs GPT-3.5

| Environment | ElizaOS | GPT-3.5 | Difference |
|-------------|---------|---------|------------|
| operating_system | 100.0% | 36.0% | +64.0% |
| database | 100.0% | 10.2% | +89.8% |
| knowledge_graph | 0.0% | 16.4% | -16.4% |
| lateral_thinking | 0.0% | 10.9% | -10.9% |
| web_shopping | 100.0% | 48.1% | +51.9% |

## Resource Usage

- **Peak Memory**: 4.3MB
- **Average Memory**: 4.0MB
- **Average Tokens per Task**: 0

---
*Generated on 2026-01-12T00:48:02.538461*
*Benchmark: AgentBench (ICLR 2024)*
*Framework: ElizaOS Python*
