# Action Selection Benchmark

**Selection Accuracy:** 0.0% (0/78)
**Latency:** avg 35ms · p50 22ms · p95 89ms
**Planner Accuracy:** 0.0% (0/78)
**Execution Accuracy:** 0.0% (0/78)

## By tag

| Tag | Passed | Total | Accuracy |
| --- | ---: | ---: | ---: |
| approval | 0 | 2 | 0.0% |
| blocking | 0 | 5 | 0.0% |
| browser | 0 | 2 | 0.0% |
| calendar | 0 | 5 | 0.0% |
| calendly | 0 | 2 | 0.0% |
| chat | 0 | 11 | 0.0% |
| checkin | 0 | 2 | 0.0% |
| computer-use | 0 | 2 | 0.0% |
| credentials | 0 | 2 | 0.0% |
| critical | 0 | 14 | 0.0% |
| dossier | 0 | 2 | 0.0% |
| email | 0 | 5 | 0.0% |
| focus | 0 | 5 | 0.0% |
| goals | 0 | 3 | 0.0% |
| habits | 0 | 2 | 0.0% |
| health | 0 | 2 | 0.0% |
| inbox | 0 | 3 | 0.0% |
| intent-sync | 0 | 2 | 0.0% |
| messaging | 0 | 3 | 0.0% |
| negative | 0 | 11 | 0.0% |
| password | 0 | 2 | 0.0% |
| profile | 0 | 1 | 0.0% |
| relationships | 0 | 3 | 0.0% |
| remote-desktop | 0 | 2 | 0.0% |
| scheduling | 0 | 4 | 0.0% |
| screen-time | 0 | 2 | 0.0% |
| standard | 0 | 53 | 0.0% |
| subscriptions | 0 | 4 | 0.0% |
| todos | 0 | 3 | 0.0% |
| travel | 0 | 1 | 0.0% |
| voice | 0 | 2 | 0.0% |
| x | 0 | 3 | 0.0% |

## By failure mode

| Mode | Count |
| --- | ---: |
| passed | 0 |
| validate_filtered | 0 |
| llm_chose_reply | 0 |
| llm_chose_other_action | 0 |
| no_response | 0 |
| error | 78 |

## Failures (78)

| Case | Expected | Planned | Completed | Failure Mode | Error |
| --- | --- | --- | --- | --- | --- |
| chat-greeting-hi | (no action) | (none) | (none) | error | roomId is not defined |
| chat-greeting-hello-how-are-you | (no action) | (none) | (none) | error | roomId is not defined |
| chat-thanks | (no action) | (none) | (none) | error | roomId is not defined |
| chat-smalltalk-weather | (no action) | (none) | (none) | error | roomId is not defined |
| chat-opinion-question | (no action) | (none) | (none) | error | roomId is not defined |
| todo-add-simple | LIFE | (none) | (none) | error | roomId is not defined |
| todo-remember-to-call | LIFE | (none) | (none) | error | roomId is not defined |
| habit-daily-meditation | LIFE | (none) | (none) | error | roomId is not defined |
| habit-weekly-gym | LIFE | (none) | (none) | error | roomId is not defined |
| todo-list-today | LIFE | (none) | (none) | error | roomId is not defined |
| goal-save-money | LIFE | (none) | (none) | error | roomId is not defined |
| goal-read-books | LIFE | (none) | (none) | error | roomId is not defined |
| goal-career | LIFE | (none) | (none) | error | roomId is not defined |
| checkin-morning | RUN_MORNING_CHECKIN | (none) | (none) | error | roomId is not defined |
| checkin-night | RUN_NIGHT_CHECKIN | (none) | (none) | error | roomId is not defined |
| owner-profile-travel-prefs | UPDATE_OWNER_PROFILE | (none) | (none) | error | roomId is not defined |
| cal-next-event | OWNER_CALENDAR | (none) | (none) | error | roomId is not defined |
| cal-today | OWNER_CALENDAR | (none) | (none) | error | roomId is not defined |
| cal-create-event | OWNER_CALENDAR | (none) | (none) | error | roomId is not defined |
| cal-create-event-meeting | OWNER_CALENDAR | (none) | (none) | error | roomId is not defined |
| cal-week-ahead | OWNER_CALENDAR | (none) | (none) | error | roomId is not defined |
| email-triage-inbox | OWNER_INBOX | (none) | (none) | error | roomId is not defined |
| email-unread | OWNER_INBOX | (none) | (none) | error | roomId is not defined |
| email-draft-reply | OWNER_INBOX | (none) | (none) | error | roomId is not defined |
| email-send-reply | OWNER_INBOX | (none) | (none) | error | roomId is not defined |
| email-unsubscribe-sender | EMAIL_UNSUBSCRIBE | (none) | (none) | error | roomId is not defined |
| inbox-triage | OWNER_INBOX | (none) | (none) | error | roomId is not defined |
| inbox-digest | OWNER_INBOX | (none) | (none) | error | roomId is not defined |
| inbox-respond | OWNER_INBOX | (none) | (none) | error | roomId is not defined |
| block-sites-focus | OWNER_WEBSITE_BLOCK | (none) | (none) | error | roomId is not defined |
| block-sites-social | OWNER_WEBSITE_BLOCK | (none) | (none) | error | roomId is not defined |
| block-sites-youtube | OWNER_WEBSITE_BLOCK | (none) | (none) | error | roomId is not defined |
| block-apps-games | OWNER_APP_BLOCK | (none) | (none) | error | roomId is not defined |
| block-apps-slack | OWNER_APP_BLOCK | (none) | (none) | error | roomId is not defined |
| rel-list-contacts | OWNER_RELATIONSHIP | (none) | (none) | error | roomId is not defined |
| rel-follow-up | OWNER_RELATIONSHIP | (none) | (none) | error | roomId is not defined |
| rel-days-since | OWNER_RELATIONSHIP | (none) | (none) | error | roomId is not defined |
| cross-send-telegram | OWNER_SEND_MESSAGE | (none) | (none) | error | roomId is not defined |
| cross-send-discord | OWNER_SEND_MESSAGE | (none) | (none) | error | roomId is not defined |
| cross-send-signal | OWNER_SEND_MESSAGE | (none) | (none) | error | roomId is not defined |
| x-read-dms | X_READ | (none) | (none) | error | roomId is not defined |
| x-read-feed | X_READ | (none) | (none) | error | roomId is not defined |
| x-search | X_READ | (none) | (none) | error | roomId is not defined |
| screentime-today | OWNER_SCREEN_TIME | (none) | (none) | error | roomId is not defined |
| screentime-by-app | OWNER_SCREEN_TIME | (none) | (none) | error | roomId is not defined |
| sched-start-flow | OWNER_CALENDAR | (none) | (none) | error | roomId is not defined |
| sched-propose-times | SCHEDULING | (none) | (none) | error | roomId is not defined |
| dossier-person | DOSSIER | (none) | (none) | error | roomId is not defined |
| dossier-prep | DOSSIER | (none) | (none) | error | roomId is not defined |
| twilio-call-dentist | CALL_EXTERNAL | (none) | (none) | error | roomId is not defined |
| twilio-call-support | CALL_EXTERNAL | (none) | (none) | error | roomId is not defined |
| book-travel-flight | BOOK_TRAVEL | (none) | (none) | error | roomId is not defined |
| browser-manage-settings | MANAGE_LIFEOPS_BROWSER | (none) | (none) | error | roomId is not defined |
| autofill-password-field | REQUEST_FIELD_FILL | (none) | (none) | error | roomId is not defined |
| approval-approve-request | APPROVE_REQUEST | (none) | (none) | error | roomId is not defined |
| approval-reject-request | REJECT_REQUEST | (none) | (none) | error | roomId is not defined |
| computer-use-click | LIFEOPS_COMPUTER_USE | (none) | (none) | error | roomId is not defined |
| computer-use-screenshot | LIFEOPS_COMPUTER_USE | (none) | (none) | error | roomId is not defined |
| subscriptions-cancel-netflix | SUBSCRIPTIONS | (none) | (none) | error | roomId is not defined |
| subscriptions-cancel-hulu-browser | SUBSCRIPTIONS | (none) | (none) | error | roomId is not defined |
| subscriptions-cancel-google-play | SUBSCRIPTIONS | (none) | (none) | error | roomId is not defined |
| subscriptions-cancel-app-store | SUBSCRIPTIONS | (none) | (none) | error | roomId is not defined |
| neg-email-chatter | (no action) | (none) | (none) | error | roomId is not defined |
| neg-calendar-chatter | (no action) | (none) | (none) | error | roomId is not defined |
| neg-goal-advice | (no action) | (none) | (none) | error | roomId is not defined |
| neg-block-hypothetical | (no action) | (none) | (none) | error | roomId is not defined |
| neg-call-hypothetical | (no action) | (none) | (none) | error | roomId is not defined |
| neg-screentime-chatter | (no action) | (none) | (none) | error | roomId is not defined |
| password-manager-lookup | PASSWORD_MANAGER | (none) | (none) | error | roomId is not defined |
| password-manager-list-logins | PASSWORD_MANAGER | (none) | (none) | error | roomId is not defined |
| remote-desktop-start-session | OWNER_REMOTE_DESKTOP | (none) | (none) | error | roomId is not defined |
| remote-desktop-connect-from-phone | OWNER_REMOTE_DESKTOP | (none) | (none) | error | roomId is not defined |
| intent-sync-broadcast-reminder | INTENT_SYNC | (none) | (none) | error | roomId is not defined |
| intent-sync-mobile-routine-reminder | INTENT_SYNC | (none) | (none) | error | roomId is not defined |
| calendly-check-availability | OWNER_CALENDAR | (none) | (none) | error | roomId is not defined |
| calendly-create-single-use-link | OWNER_CALENDAR | (none) | (none) | error | roomId is not defined |
| health-sleep-last-night | HEALTH | (none) | (none) | error | roomId is not defined |
| health-step-count-today | HEALTH | (none) | (none) | error | roomId is not defined |
