# Action Selection Benchmark

**Selection Accuracy:** 97.4% (74/76)
**Latency:** avg 6470ms · p50 5406ms · p95 14932ms
**Planner Accuracy:** 96.1% (73/76)
**Execution Accuracy:** 97.4% (74/76)
**LLM Token Usage:** input 1587619 · output 153571 · total 1741190 (340/465 calls reported usage)
**Cache Read:** 31.0% (491904/1587619 input tokens)
**Cache Write:** 0.0% (0/1587619 input tokens)

## By tag

| Tag | Passed | Total | Accuracy |
| --- | ---: | ---: | ---: |
| approval | 1 | 2 | 50.0% |
| blocking | 5 | 5 | 100.0% |
| browser | 2 | 2 | 100.0% |
| calendar | 5 | 5 | 100.0% |
| calendly | 2 | 2 | 100.0% |
| chat | 11 | 11 | 100.0% |
| checkin | 2 | 2 | 100.0% |
| computer-use | 2 | 2 | 100.0% |
| credentials | 1 | 2 | 50.0% |
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
| password | 1 | 2 | 50.0% |
| profile | 1 | 1 | 100.0% |
| relationships | 3 | 3 | 100.0% |
| remote-desktop | 2 | 2 | 100.0% |
| scheduling | 4 | 4 | 100.0% |
| screen-time | 2 | 2 | 100.0% |
| standard | 49 | 51 | 96.1% |
| subscriptions | 4 | 4 | 100.0% |
| todos | 3 | 3 | 100.0% |
| travel | 1 | 1 | 100.0% |
| voice | 2 | 2 | 100.0% |
| x | 3 | 3 | 100.0% |

## By failure mode

| Mode | Count |
| --- | ---: |
| passed | 74 |
| validate_filtered | 0 |
| llm_chose_reply | 0 |
| llm_chose_other_action | 2 |
| no_response | 0 |
| error | 0 |

## Failures (2)

| Case | Expected | Planned | Completed | Failure Mode | Error |
| --- | --- | --- | --- | --- | --- |
| approval-reject-request | RESOLVE_REQUEST | CONNECTOR | CONNECTOR | llm_chose_other_action |  |
| password-manager-lookup | PASSWORD_MANAGER | AUTOFILL | AUTOFILL | llm_chose_other_action |  |
