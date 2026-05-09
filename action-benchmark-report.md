# Action Selection Benchmark

**Selection Accuracy:** 0.0% (0/1)
**Latency:** avg 9512ms · p50 9512ms · p95 9512ms
**Planner Accuracy:** 0.0% (0/1)
**Execution Accuracy:** 0.0% (0/1)
**LLM Token Usage:** input 15832 · output 876 · total 16708 (3/8 calls reported usage)
**Cache Read:** 33.1% (5248/15832 input tokens)
**Cache Write:** 0.0% (0/15832 input tokens)

## By tag

| Tag | Passed | Total | Accuracy |
| --- | ---: | ---: | ---: |
| standard | 0 | 1 | 0.0% |
| todos | 0 | 1 | 0.0% |

## By failure mode

| Mode | Count |
| --- | ---: |
| passed | 0 |
| validate_filtered | 0 |
| llm_chose_reply | 0 |
| llm_chose_other_action | 1 |
| no_response | 0 |
| error | 0 |

## Failures (1)

| Case | Expected | Planned | Completed | Failure Mode | Error |
| --- | --- | --- | --- | --- | --- |
| todo-add-simple | LIFE | TODOS_CREATE | (none) | llm_chose_other_action |  |
