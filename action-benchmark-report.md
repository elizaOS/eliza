# Action Selection Benchmark

**Selection Accuracy:** 100.0% (7/7)
**Latency:** avg 6926ms · p50 6824ms · p95 12053ms
**Planner Accuracy:** 100.0% (7/7)
**Execution Accuracy:** 85.7% (6/7)
**LLM Token Usage:** input 106576 · output 8124 · total 114700 (23/66 calls reported usage)
**Cache Read:** 29.1% (30976/106576 input tokens)
**Cache Write:** 0.0% (0/106576 input tokens)

## By tag

| Tag | Passed | Total | Accuracy |
| --- | ---: | ---: | ---: |
| email | 1 | 1 | 100.0% |
| goals | 1 | 1 | 100.0% |
| messaging | 1 | 1 | 100.0% |
| standard | 7 | 7 | 100.0% |
| todos | 3 | 3 | 100.0% |
| x | 1 | 1 | 100.0% |

## By failure mode

| Mode | Count |
| --- | ---: |
| passed | 7 |
| validate_filtered | 0 |
| llm_chose_reply | 0 |
| llm_chose_other_action | 0 |
| no_response | 0 |
| error | 0 |

## Execution Issues (1)

| Case | Planned | Started | Completed | Error |
| --- | --- | --- | --- | --- |
| email-unread | MESSAGE | MESSAGE | (none) |  |
