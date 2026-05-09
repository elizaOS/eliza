# Action Selection Benchmark

**Selection Accuracy:** 0.0% (0/1)
**Latency:** avg 3523ms · p50 3523ms · p95 3523ms
**Planner Accuracy:** 0.0% (0/1)
**Execution Accuracy:** 0.0% (0/1)
**LLM Token Usage:** input 5577 · output 438 · total 6015 (2/6 calls reported usage)
**Cache Read:** 87.2% (4864/5577 input tokens)
**Cache Write:** 0.0% (0/5577 input tokens)

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
| llm_chose_reply | 1 |
| llm_chose_other_action | 0 |
| no_response | 0 |
| error | 0 |

## Failures (1)

| Case | Expected | Planned | Completed | Failure Mode | Error |
| --- | --- | --- | --- | --- | --- |
| todo-add-simple | LIFE | (none) | (none) | llm_chose_reply |  |
