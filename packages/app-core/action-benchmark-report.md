# Action Selection Benchmark

**Selection Accuracy:** 96.2% (75/78)
**Latency:** avg 6448ms · p50 4713ms · p95 10870ms
**Planner Accuracy:** 96.2% (75/78)
**Execution Accuracy:** 70.5% (55/78)

## By tag

| Tag | Passed | Total | Accuracy |
| --- | ---: | ---: | ---: |
| approval | 2 | 2 | 100.0% |
| blocking | 5 | 5 | 100.0% |
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
| standard | 50 | 53 | 94.3% |
| subscriptions | 4 | 4 | 100.0% |
| todos | 3 | 3 | 100.0% |
| travel | 1 | 1 | 100.0% |
| voice | 2 | 2 | 100.0% |
| x | 0 | 3 | 0.0% |

## By failure mode

| Mode | Count |
| --- | ---: |
| passed | 65 |
| validate_filtered | 3 |
| llm_chose_reply | 0 |
| llm_chose_other_action | 0 |
| no_response | 0 |
| error | 10 |

## Failures (3)

| Case | Expected | Planned | Completed | Failure Mode | Error |
| --- | --- | --- | --- | --- | --- |
| x-read-dms | X_READ | OWNER_SEND_MESSAGE | (none) | validate_filtered |  |
| x-read-feed | X_READ | OWNER_SEND_MESSAGE | (none) | validate_filtered |  |
| x-search | X_READ | SEARCH_ACROSS_CHANNELS | OWNER_INBOX | validate_filtered |  |

## Execution Issues (20)

| Case | Planned | Started | Completed | Error |
| --- | --- | --- | --- | --- |
| cal-next-event | OWNER_CALENDAR | (none) | (none) | Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project. |
| cal-today | OWNER_CALENDAR | (none) | (none) | Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project. |
| cal-create-event | OWNER_CALENDAR | OWNER_CALENDAR | (none) |  |
| cal-create-event-meeting | OWNER_CALENDAR | OWNER_CALENDAR | (none) |  |
| cal-week-ahead | OWNER_CALENDAR | (none) | (none) | Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project. |
| email-triage-inbox | OWNER_INBOX | OWNER_INBOX | (none) |  |
| email-draft-reply | OWNER_INBOX | (none) | (none) | Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project. |
| email-send-reply | OWNER_INBOX | OWNER_INBOX | (none) |  |
| inbox-triage | OWNER_INBOX | (none) | (none) | Google connector needs re-authentication: Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project. |
| block-apps-games | OWNER_APP_BLOCK | (none) | (none) | [app-blocker] AppBlocker Capacitor plugin is not available. App blocking is mobile-only. |
| block-apps-slack | OWNER_APP_BLOCK | (none) | (none) | [app-blocker] AppBlocker Capacitor plugin is not available. App blocking is mobile-only. |
| sched-propose-times | OWNER_CALENDAR | (none) | (none) | Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project. |
| twilio-call-dentist | CALL_EXTERNAL | CALL_EXTERNAL | (none) |  |
| twilio-call-support | CALL_EXTERNAL | CALL_EXTERNAL | (none) |  |
| subscriptions-cancel-google-play | SUBSCRIPTIONS | SUBSCRIPTIONS | (none) |  |
| subscriptions-cancel-app-store | SUBSCRIPTIONS | SUBSCRIPTIONS | (none) |  |
| password-manager-lookup | PASSWORD_MANAGER | (none) | (none) | No password manager backend available (install 1Password CLI `op` or ProtonPass/`pass`) |
| password-manager-list-logins | PASSWORD_MANAGER | (none) | (none) | No password manager backend available (install 1Password CLI `op` or ProtonPass/`pass`) |
| remote-desktop-start-session | OWNER_REMOTE_DESKTOP | OWNER_REMOTE_DESKTOP | (none) |  |
| remote-desktop-connect-from-phone | OWNER_REMOTE_DESKTOP | OWNER_REMOTE_DESKTOP | (none) |  |
