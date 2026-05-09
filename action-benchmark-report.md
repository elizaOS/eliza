# Action Selection Benchmark

**Selection Accuracy:** 98.7% (75/76)
**Latency:** avg 6906ms · p50 6375ms · p95 12288ms
**Planner Accuracy:** 97.4% (74/76)
**Execution Accuracy:** 97.4% (74/76)
**LLM Token Usage:** input 1476301 · output 149106 · total 1625407 (318/452 calls reported usage)
**Cache Read:** 28.6% (422144/1476301 input tokens)
**Cache Write:** 0.0% (0/1476301 input tokens)

## By tag

| Tag | Passed | Total | Accuracy |
| --- | ---: | ---: | ---: |
| approval | 2 | 2 | 100.0% |
| blocking | 5 | 5 | 100.0% |
| browser | 2 | 2 | 100.0% |
| calendar | 5 | 5 | 100.0% |
| calendly | 2 | 2 | 100.0% |
| chat | 11 | 11 | 100.0% |
| checkin | 1 | 2 | 50.0% |
| computer-use | 2 | 2 | 100.0% |
| credentials | 2 | 2 | 100.0% |
| critical | 14 | 14 | 100.0% |
| email | 5 | 5 | 100.0% |
| focus | 5 | 5 | 100.0% |
| goals | 3 | 3 | 100.0% |
| habits | 2 | 2 | 100.0% |
| health | 2 | 2 | 100.0% |
| inbox | 3 | 3 | 100.0% |
| intent-sync | 2 | 2 | 100.0% |
| messaging | 3 | 3 | 100.0% |
| negative | 11 | 11 | 100.0% |
| password | 2 | 2 | 100.0% |
| profile | 1 | 1 | 100.0% |
| relationships | 3 | 3 | 100.0% |
| remote-desktop | 2 | 2 | 100.0% |
| scheduling | 4 | 4 | 100.0% |
| screen-time | 2 | 2 | 100.0% |
| standard | 50 | 51 | 98.0% |
| subscriptions | 4 | 4 | 100.0% |
| todos | 3 | 3 | 100.0% |
| travel | 1 | 1 | 100.0% |
| voice | 2 | 2 | 100.0% |
| x | 3 | 3 | 100.0% |

## By failure mode

| Mode | Count |
| --- | ---: |
| passed | 75 |
| validate_filtered | 0 |
| llm_chose_reply | 1 |
| llm_chose_other_action | 0 |
| no_response | 0 |
| error | 0 |

## Failures (1)

| Case | Expected | Planned | Completed | Failure Mode | Error |
| --- | --- | --- | --- | --- | --- |
| checkin-night | CHECKIN | (none) | (none) | llm_chose_reply |  |

## Execution Issues (1)

| Case | Planned | Started | Completed | Error |
| --- | --- | --- | --- | --- |
| calendly-create-single-use-link | CALENDAR | (none) | (none) |  |
