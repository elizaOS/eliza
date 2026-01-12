# AgentBench Evaluation Results - ElizaOS Python

## Executive Summary

- **Status**: STRONG
- **Overall Success Rate**: 100.0%
- **Total Tasks**: 5 (5 passed, 0 failed)
- **Average Duration**: 5ms per task

### Key Findings

- ElizaOS demonstrates strong agent capabilities across tested environments
- Strong performance in: operating_system, database, knowledge_graph, lateral_thinking, web_shopping
- Outperforms GPT-4 baseline in: operating_system, database, knowledge_graph, lateral_thinking, web_shopping

### Recommendations


## Environment Breakdown

| Environment | Success Rate | Tasks | Avg Steps | Avg Duration |
|-------------|-------------|-------|-----------|--------------|
| operating_system | 100.0% | 1 | 1.0 | 16ms |
| database | 100.0% | 1 | 5.0 | 4ms |
| knowledge_graph | 100.0% | 1 | 1.0 | 2ms |
| lateral_thinking | 100.0% | 1 | 1.0 | 1ms |
| web_shopping | 100.0% | 1 | 5.0 | 3ms |

## Comparison with Published Baselines

### vs GPT-4

| Environment | ElizaOS | GPT-4 | Difference |
|-------------|---------|-------|------------|
| operating_system | 100.0% | 42.1% | +57.9% |
| database | 100.0% | 32.6% | +67.4% |
| knowledge_graph | 100.0% | 58.4% | +41.6% |
| lateral_thinking | 100.0% | 34.8% | +65.2% |
| web_shopping | 100.0% | 50.5% | +49.5% |

### vs GPT-3.5

| Environment | ElizaOS | GPT-3.5 | Difference |
|-------------|---------|---------|------------|
| operating_system | 100.0% | 36.0% | +64.0% |
| database | 100.0% | 10.2% | +89.8% |
| knowledge_graph | 100.0% | 16.4% | +83.6% |
| lateral_thinking | 100.0% | 10.9% | +89.1% |
| web_shopping | 100.0% | 48.1% | +51.9% |

## Resource Usage

- **Peak Memory**: 0.0MB
- **Average Memory**: 0.0MB
- **Average Tokens per Task**: 0

---
*Generated on 2026-01-12T00:14:51.893765*
*Benchmark: AgentBench (ICLR 2024)*
*Framework: ElizaOS Python*
