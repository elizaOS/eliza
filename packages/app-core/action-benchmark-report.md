# Action Selection Benchmark

**Selection Accuracy:** 93.6% (73/78)
**Latency:** avg 6857ms · p50 4792ms · p95 35671ms
**Planner Accuracy:** 93.6% (73/78)
**Execution Accuracy:** 74.4% (58/78)

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
| computer-use | 0 | 2 | 0.0% |
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
| standard | 48 | 53 | 90.6% |
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

## Failures (5)

| Case | Expected | Planned | Completed | Failure Mode | Error |
| --- | --- | --- | --- | --- | --- |
| x-read-dms | X_READ | OWNER_INBOX | OWNER_INBOX | validate_filtered |  |
| x-read-feed | X_READ | SEARCH_ACROSS_CHANNELS | OWNER_INBOX | validate_filtered |  |
| x-search | X_READ | SEARCH_ACROSS_CHANNELS | OWNER_INBOX | validate_filtered |  |
| computer-use-click | LIFEOPS_COMPUTER_USE | MANAGE_LIFEOPS_BROWSER | (none) | error | Unsupported browser command create_folder |
| computer-use-screenshot | LIFEOPS_COMPUTER_USE | MANAGE_LIFEOPS_BROWSER | (none) | error | Unsupported browser command take_screenshot |

## Execution Issues (15)

| Case | Planned | Started | Completed | Error |
| --- | --- | --- | --- | --- |
| cal-next-event | OWNER_CALENDAR | (none) | (none) | Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project. |
| cal-today | OWNER_CALENDAR | (none) | (none) | Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project. |
| cal-create-event | OWNER_CALENDAR | OWNER_CALENDAR | (none) |  |
| cal-create-event-meeting | OWNER_CALENDAR | OWNER_CALENDAR | (none) |  |
| cal-week-ahead | OWNER_CALENDAR | (none) | (none) | Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project. |
| block-apps-games | OWNER_APP_BLOCK | (none) | (none) | [app-blocker] AppBlocker Capacitor plugin is not available. App blocking is mobile-only. |
| block-apps-slack | OWNER_APP_BLOCK | (none) | (none) | [app-blocker] AppBlocker Capacitor plugin is not available. App blocking is mobile-only. |
| sched-propose-times | OWNER_CALENDAR | (none) | (none) | Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project. |
| twilio-call-dentist | CALL_EXTERNAL | CALL_EXTERNAL | (none) |  |
| twilio-call-support | CALL_EXTERNAL | CALL_EXTERNAL | (none) |  |
| subscriptions-cancel-app-store | SUBSCRIPTIONS | SUBSCRIPTIONS | (none) |  |
| password-manager-lookup | PASSWORD_MANAGER | (none) | (none) | No password manager backend available (install 1Password CLI `op` or ProtonPass/`pass`) |
| password-manager-list-logins | PASSWORD_MANAGER | (none) | (none) | No password manager backend available (install 1Password CLI `op` or ProtonPass/`pass`) |
| remote-desktop-start-session | OWNER_REMOTE_DESKTOP | OWNER_REMOTE_DESKTOP | (none) |  |
| remote-desktop-connect-from-phone | OWNER_REMOTE_DESKTOP | OWNER_REMOTE_DESKTOP | (none) |  |
