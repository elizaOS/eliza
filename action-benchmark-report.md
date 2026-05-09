# Action Selection Benchmark

**Selection Accuracy:** 100.0% (2/2)
**Latency:** avg 7529ms · p50 6965ms · p95 8093ms
**Planner Accuracy:** 100.0% (2/2)
**Execution Accuracy:** 100.0% (2/2)
**LLM Token Usage:** input 41839 · output 3865 · total 45704 (8/12 calls reported usage)
**Cache Read:** 17.7% (7424/41839 input tokens)
**Cache Write:** 0.0% (0/41839 input tokens)

## By tag

| Tag | Passed | Total | Accuracy |
| --- | ---: | ---: | ---: |
| approval | 1 | 1 | 100.0% |
| credentials | 1 | 1 | 100.0% |
| password | 1 | 1 | 100.0% |
| standard | 2 | 2 | 100.0% |

## By failure mode

| Mode | Count |
| --- | ---: |
| passed | 2 |
| validate_filtered | 0 |
| llm_chose_reply | 0 |
| llm_chose_other_action | 0 |
| no_response | 0 |
| error | 0 |
