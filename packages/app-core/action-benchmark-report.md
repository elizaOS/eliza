# Action Selection Benchmark

**Selection Accuracy:** 97.4% (76/78)
**Latency:** avg 5522ms · p50 4051ms · p95 16207ms
**Planner Accuracy:** 97.4% (76/78)
**Execution Accuracy:** 97.4% (76/78)

## By tag

| Tag | Passed | Total | Accuracy |
| --- | ---: | ---: | ---: |
| approval | 1 | 2 | 50.0% |
| blocking | 4 | 5 | 80.0% |
| browser | 2 | 2 | 100.0% |
| calendar | 5 | 5 | 100.0% |
| calendly | 2 | 2 | 100.0% |
| chat | 11 | 11 | 100.0% |
| checkin | 2 | 2 | 100.0% |
| computer-use | 2 | 2 | 100.0% |
| credentials | 2 | 2 | 100.0% |
| critical | 14 | 14 | 100.0% |
| dossier | 2 | 2 | 100.0% |
| email | 5 | 5 | 100.0% |
| focus | 4 | 5 | 80.0% |
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
| standard | 51 | 53 | 96.2% |
| subscriptions | 4 | 4 | 100.0% |
| todos | 3 | 3 | 100.0% |
| travel | 1 | 1 | 100.0% |
| voice | 2 | 2 | 100.0% |
| x | 3 | 3 | 100.0% |

## By failure mode

| Mode | Count |
| --- | ---: |
| passed | 76 |
| validate_filtered | 0 |
| llm_chose_reply | 0 |
| llm_chose_other_action | 2 |
| no_response | 0 |
| error | 0 |

## Failures (2)

| Case | Expected | Planned | Completed | Failure Mode | Error |
| --- | --- | --- | --- | --- | --- |
| block-apps-slack | OWNER_APP_BLOCK | BLOCK_UNTIL_TASK_COMPLETE | BLOCK_UNTIL_TASK_COMPLETE | llm_chose_other_action |  |
| approval-approve-request | APPROVE_REQUEST | LIFEOPS_MUTATE | (none) | llm_chose_other_action |  |
