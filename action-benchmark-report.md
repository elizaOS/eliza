# Action Selection Benchmark

**Selection Accuracy:** 85.7% (6/7)
**Latency:** avg 7617ms · p50 6134ms · p95 11642ms
**Planner Accuracy:** 85.7% (6/7)
**Execution Accuracy:** 57.1% (4/7)
**LLM Token Usage:** input 207243 · output 16712 · total 223955 (43/85 calls reported usage)
**Cache Read:** 49.8% (103296/207243 input tokens)
**Cache Write:** 0.0% (0/207243 input tokens)

## By tag

| Tag | Passed | Total | Accuracy |
| --- | ---: | ---: | ---: |
| email | 1 | 1 | 100.0% |
| goals | 1 | 1 | 100.0% |
| messaging | 1 | 1 | 100.0% |
| standard | 6 | 7 | 85.7% |
| todos | 3 | 3 | 100.0% |
| x | 0 | 1 | 0.0% |

## By failure mode

| Mode | Count |
| --- | ---: |
| passed | 6 |
| validate_filtered | 0 |
| llm_chose_reply | 0 |
| llm_chose_other_action | 1 |
| no_response | 0 |
| error | 0 |

## Failures (1)

| Case | Expected | Planned | Completed | Failure Mode | Error |
| --- | --- | --- | --- | --- | --- |
| x-read-dms | MESSAGE | CONNECTOR | (none) | llm_chose_other_action |  |

## Execution Issues (2)

| Case | Planned | Started | Completed | Error |
| --- | --- | --- | --- | --- |
| email-unread | MESSAGE | (none) | (none) |  |
| cross-send-discord | MESSAGE | (none) | (none) |  |
