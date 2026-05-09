# Action Selection Benchmark

**Selection Accuracy:** 71.4% (5/7)
**Latency:** avg 7544ms · p50 7186ms · p95 11935ms
**Planner Accuracy:** 71.4% (5/7)
**Execution Accuracy:** 57.1% (4/7)
**LLM Token Usage:** input 214016 · output 18544 · total 232560 (43/82 calls reported usage)
**Cache Read:** 53.1% (113664/214016 input tokens)
**Cache Write:** 0.0% (0/214016 input tokens)

## By tag

| Tag | Passed | Total | Accuracy |
| --- | ---: | ---: | ---: |
| email | 0 | 1 | 0.0% |
| goals | 1 | 1 | 100.0% |
| messaging | 1 | 1 | 100.0% |
| standard | 5 | 7 | 71.4% |
| todos | 3 | 3 | 100.0% |
| x | 0 | 1 | 0.0% |

## By failure mode

| Mode | Count |
| --- | ---: |
| passed | 5 |
| validate_filtered | 0 |
| llm_chose_reply | 0 |
| llm_chose_other_action | 2 |
| no_response | 0 |
| error | 0 |

## Failures (2)

| Case | Expected | Planned | Completed | Failure Mode | Error |
| --- | --- | --- | --- | --- | --- |
| email-unread | MESSAGE | SUMMARIZE_UNREAD_EMAILS | (none) | llm_chose_other_action |  |
| x-read-dms | MESSAGE | CONNECTOR | (none) | llm_chose_other_action |  |

## Execution Issues (1)

| Case | Planned | Started | Completed | Error |
| --- | --- | --- | --- | --- |
| cross-send-discord | MESSAGE | (none) | (none) |  |
