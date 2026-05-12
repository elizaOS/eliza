# Action Selection Benchmark

**Selection Accuracy:** 15.6% (5/32)
**Latency:** avg 16470ms · p50 3197ms · p95 44984ms
**Planner Accuracy:** 15.6% (5/32)
**Execution Accuracy:** 15.6% (5/32)
**LLM Token Usage:** input 180184 · output 3467 · total 183651 (32/205 calls reported usage)
**Cache Read:** 0.0% (0/180184 input tokens)
**Cache Write:** 0.0% (0/180184 input tokens)

## By tag

| Tag | Passed | Total | Accuracy |
| --- | ---: | ---: | ---: |
| approval | 0 | 2 | 0.0% |
| blocking | 0 | 2 | 0.0% |
| browser | 0 | 1 | 0.0% |
| calendar | 0 | 3 | 0.0% |
| chat | 5 | 5 | 100.0% |
| computer-use | 0 | 1 | 0.0% |
| credentials | 0 | 1 | 0.0% |
| critical | 0 | 9 | 0.0% |
| email | 0 | 2 | 0.0% |
| focus | 0 | 2 | 0.0% |
| goals | 0 | 1 | 0.0% |
| habits | 0 | 1 | 0.0% |
| health | 0 | 1 | 0.0% |
| inbox | 0 | 1 | 0.0% |
| messaging | 0 | 1 | 0.0% |
| negative | 5 | 5 | 100.0% |
| password | 0 | 1 | 0.0% |
| relationships | 0 | 1 | 0.0% |
| remote-desktop | 0 | 1 | 0.0% |
| scheduling | 0 | 1 | 0.0% |
| screen-time | 0 | 1 | 0.0% |
| standard | 0 | 18 | 0.0% |
| subscriptions | 0 | 1 | 0.0% |
| todos | 0 | 2 | 0.0% |
| voice | 0 | 1 | 0.0% |
| x | 0 | 2 | 0.0% |

## By failure mode

| Mode | Count |
| --- | ---: |
| passed | 5 |
| validate_filtered | 0 |
| llm_chose_reply | 27 |
| llm_chose_other_action | 0 |
| no_response | 0 |
| error | 0 |

## Failures (27)

| Case | Expected | Planned | Completed | Failure Mode | Error |
| --- | --- | --- | --- | --- | --- |
| todo-add-simple | OWNER_TODOS | (none) | (none) | llm_chose_reply |  |
| todo-list-today | OWNER_TODOS | (none) | (none) | llm_chose_reply |  |
| habit-daily-meditation | OWNER_ROUTINES | (none) | (none) | llm_chose_reply |  |
| goal-save-money | OWNER_GOALS | (none) | (none) | llm_chose_reply |  |
| cal-next-event | CALENDAR | (none) | (none) | llm_chose_reply |  |
| cal-create-event | CALENDAR | (none) | (none) | llm_chose_reply |  |
| cal-week-ahead | CALENDAR | (none) | (none) | llm_chose_reply |  |
| email-triage-inbox | MESSAGE | (none) | (none) | llm_chose_reply |  |
| email-draft-reply | MESSAGE | (none) | (none) | llm_chose_reply |  |
| inbox-triage | MESSAGE | (none) | (none) | llm_chose_reply |  |
| block-sites-focus | BLOCK | (none) | (none) | llm_chose_reply |  |
| block-apps-games | BLOCK | (none) | (none) | llm_chose_reply |  |
| rel-list-contacts | ENTITY | (none) | (none) | llm_chose_reply |  |
| cross-send-telegram | MESSAGE | (none) | (none) | llm_chose_reply |  |
| x-read-dms | MESSAGE | (none) | (none) | llm_chose_reply |  |
| x-read-feed | POST | (none) | (none) | llm_chose_reply |  |
| screentime-today | OWNER_SCREENTIME | (none) | (none) | llm_chose_reply |  |
| sched-propose-times | CALENDAR | (none) | (none) | llm_chose_reply |  |
| twilio-call-dentist | VOICE_CALL | (none) | (none) | llm_chose_reply |  |
| browser-manage-settings | BROWSER | (none) | (none) | llm_chose_reply |  |
| approval-approve-request | RESOLVE_REQUEST | (none) | (none) | llm_chose_reply |  |
| approval-reject-request | RESOLVE_REQUEST | (none) | (none) | llm_chose_reply |  |
| computer-use-click | COMPUTER_USE | (none) | (none) | llm_chose_reply |  |
| subscriptions-cancel-netflix | OWNER_FINANCES | (none) | (none) | llm_chose_reply |  |
| password-manager-lookup | CREDENTIALS | (none) | (none) | llm_chose_reply |  |
| remote-desktop-start-session | REMOTE_DESKTOP | (none) | (none) | llm_chose_reply |  |
| health-sleep-last-night | OWNER_HEALTH | (none) | (none) | llm_chose_reply |  |
