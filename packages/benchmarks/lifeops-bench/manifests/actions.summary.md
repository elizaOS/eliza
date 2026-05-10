# LifeOps Action Manifest — Summary

Generated: 2026-05-10T09:25:39.200Z
Filter: include=[app-contacts, app-lifeops, app-phone, plugin-bluebubbles, plugin-imessage, plugin-todos] exclude=[none] tags=[any]
Total actions: 91

## Plugin breakdown

| Plugin | Actions |
| --- | ---: |
| @elizaos/app-lifeops | 89 |
| @elizaos/app-phone | 1 |
| @elizaos/plugin-todos | 1 |

## Actions

| Action | Plugin | Description | Params | Examples? |
| --- | --- | --- | ---: | :---: |
| `BLOCK` | @elizaos/app-lifeops | block app\|website (phone-Family-Controls\|hosts-file/SelfControl): block unblock… | 12 | yes |
| `BLOCK_BLOCK` | @elizaos/app-lifeops | block app\|website (phone-Family-Controls\|hosts-file/SelfControl): block unblock… | 12 | no |
| `BLOCK_LIST_ACTIVE` | @elizaos/app-lifeops | block app\|website (phone-Family-Controls\|hosts-file/SelfControl): block unblock… | 12 | no |
| `BLOCK_RELEASE` | @elizaos/app-lifeops | block app\|website (phone-Family-Controls\|hosts-file/SelfControl): block unblock… | 12 | no |
| `BLOCK_REQUEST_PERMISSION` | @elizaos/app-lifeops | block app\|website (phone-Family-Controls\|hosts-file/SelfControl): block unblock… | 12 | no |
| `BLOCK_STATUS` | @elizaos/app-lifeops | block app\|website (phone-Family-Controls\|hosts-file/SelfControl): block unblock… | 12 | no |
| `BLOCK_UNBLOCK` | @elizaos/app-lifeops | block app\|website (phone-Family-Controls\|hosts-file/SelfControl): block unblock… | 12 | no |
| `BOOK_TRAVEL` | @elizaos/app-lifeops | approval-gated real travel booking flights/hotels missing-detail collection dra… | 7 | yes |
| `CALENDAR` | @elizaos/app-lifeops | calendar+availability+prefs: feed next-event search create update delete trip-w… | 19 | yes |
| `CALENDAR_BULK_RESCHEDULE` | @elizaos/app-lifeops | calendar+availability+prefs: feed next-event search create update delete trip-w… | 19 | no |
| `CALENDAR_CHECK_AVAILABILITY` | @elizaos/app-lifeops | calendar+availability+prefs: feed next-event search create update delete trip-w… | 19 | no |
| `CALENDAR_CREATE_EVENT` | @elizaos/app-lifeops | calendar+availability+prefs: feed next-event search create update delete trip-w… | 19 | no |
| `CALENDAR_DELETE_EVENT` | @elizaos/app-lifeops | calendar+availability+prefs: feed next-event search create update delete trip-w… | 19 | no |
| `CALENDAR_FEED` | @elizaos/app-lifeops | calendar+availability+prefs: feed next-event search create update delete trip-w… | 19 | no |
| `CALENDAR_NEXT_EVENT` | @elizaos/app-lifeops | calendar+availability+prefs: feed next-event search create update delete trip-w… | 19 | no |
| `CALENDAR_PROPOSE_TIMES` | @elizaos/app-lifeops | calendar+availability+prefs: feed next-event search create update delete trip-w… | 19 | no |
| `CALENDAR_SEARCH_EVENTS` | @elizaos/app-lifeops | calendar+availability+prefs: feed next-event search create update delete trip-w… | 19 | no |
| `CALENDAR_TRIP_WINDOW` | @elizaos/app-lifeops | calendar+availability+prefs: feed next-event search create update delete trip-w… | 19 | no |
| `CALENDAR_UPDATE_EVENT` | @elizaos/app-lifeops | calendar+availability+prefs: feed next-event search create update delete trip-w… | 19 | no |
| `CALENDAR_UPDATE_PREFERENCES` | @elizaos/app-lifeops | calendar+availability+prefs: feed next-event search create update delete trip-w… | 19 | no |
| `CALENDLY` | @elizaos/app-lifeops | Work with Calendly specifically (calendly.com / api.calendly.com): list event t… | 6 | yes |
| `CONNECTOR` | @elizaos/app-lifeops | connector lifecycle+verify-probes (registry-driven): connect disconnect verify … | 12 | yes |
| `CONNECTOR_CONNECT` | @elizaos/app-lifeops | connector lifecycle+verify-probes (registry-driven): connect disconnect verify … | 12 | no |
| `CONNECTOR_DISCONNECT` | @elizaos/app-lifeops | connector lifecycle+verify-probes (registry-driven): connect disconnect verify … | 12 | no |
| `CONNECTOR_LIST` | @elizaos/app-lifeops | connector lifecycle+verify-probes (registry-driven): connect disconnect verify … | 12 | no |
| `CONNECTOR_STATUS` | @elizaos/app-lifeops | connector lifecycle+verify-probes (registry-driven): connect disconnect verify … | 12 | no |
| `CONNECTOR_VERIFY` | @elizaos/app-lifeops | connector lifecycle+verify-probes (registry-driven): connect disconnect verify … | 12 | no |
| `CREDENTIALS` | @elizaos/app-lifeops | credentials owner-only: fill(field,domain) whitelist_add(domain,confirm) whitel… | 9 | yes |
| `CREDENTIALS_FILL` | @elizaos/app-lifeops | credentials owner-only: fill(field,domain) whitelist_add(domain,confirm) whitel… | 9 | no |
| `CREDENTIALS_INJECT_PASSWORD` | @elizaos/app-lifeops | credentials owner-only: fill(field,domain) whitelist_add(domain,confirm) whitel… | 9 | no |
| `CREDENTIALS_INJECT_USERNAME` | @elizaos/app-lifeops | credentials owner-only: fill(field,domain) whitelist_add(domain,confirm) whitel… | 9 | no |
| `CREDENTIALS_LIST` | @elizaos/app-lifeops | credentials owner-only: fill(field,domain) whitelist_add(domain,confirm) whitel… | 9 | no |
| `CREDENTIALS_SEARCH` | @elizaos/app-lifeops | credentials owner-only: fill(field,domain) whitelist_add(domain,confirm) whitel… | 9 | no |
| `CREDENTIALS_WHITELIST_ADD` | @elizaos/app-lifeops | credentials owner-only: fill(field,domain) whitelist_add(domain,confirm) whitel… | 9 | no |
| `CREDENTIALS_WHITELIST_LIST` | @elizaos/app-lifeops | credentials owner-only: fill(field,domain) whitelist_add(domain,confirm) whitel… | 9 | no |
| `DEVICE_INTENT` | @elizaos/app-lifeops | broadcast device intent/reminder: target all\|mobile\|desktop\|specific title body… | 6 | yes |
| `ENTITY` | @elizaos/app-lifeops | ENTITY = people/relationships. subactions add list log_interaction set_identity… | 19 | yes |
| `FIRST_RUN` | @elizaos/app-lifeops | owner first-run: defaults\|customize\|replay; defaults asks wake time once | 2 | yes |
| `HEALTH` | @elizaos/app-lifeops | health/fitness telemetry HealthKit/GoogleFit/Strava/Fitbit/Withings/Oura: today… | 5 | yes |
| `LIFE` | @elizaos/app-lifeops | life:subaction=create\|update\|delete(kind=definition\|goal) + complete\|skip\|snooz… | 7 | yes |
| `LIFE_COMPLETE` | @elizaos/app-lifeops | life:subaction=create\|update\|delete(kind=definition\|goal) + complete\|skip\|snooz… | 7 | no |
| `LIFE_CREATE` | @elizaos/app-lifeops | life:subaction=create\|update\|delete(kind=definition\|goal) + complete\|skip\|snooz… | 7 | no |
| `LIFE_DELETE` | @elizaos/app-lifeops | life:subaction=create\|update\|delete(kind=definition\|goal) + complete\|skip\|snooz… | 7 | no |
| `LIFE_POLICY_CONFIGURE_ESCALATION` | @elizaos/app-lifeops | life:subaction=create\|update\|delete(kind=definition\|goal) + complete\|skip\|snooz… | 7 | no |
| `LIFE_POLICY_SET_REMINDER` | @elizaos/app-lifeops | life:subaction=create\|update\|delete(kind=definition\|goal) + complete\|skip\|snooz… | 7 | no |
| `LIFE_REVIEW` | @elizaos/app-lifeops | life:subaction=create\|update\|delete(kind=definition\|goal) + complete\|skip\|snooz… | 7 | no |
| `LIFE_SKIP` | @elizaos/app-lifeops | life:subaction=create\|update\|delete(kind=definition\|goal) + complete\|skip\|snooz… | 7 | no |
| `LIFE_SNOOZE` | @elizaos/app-lifeops | life:subaction=create\|update\|delete(kind=definition\|goal) + complete\|skip\|snooz… | 7 | no |
| `LIFE_UPDATE` | @elizaos/app-lifeops | life:subaction=create\|update\|delete(kind=definition\|goal) + complete\|skip\|snooz… | 7 | no |
| `LIFEOPS` | @elizaos/app-lifeops | owner LIFEOPS verb: pause\|resume\|wipe; wipe requires confirmed:true | 6 | yes |
| `MESSAGE` | @elizaos/app-lifeops | primary message action ops send read_channel read_with_contact search list_chan… | 62 | yes |
| `MESSAGE_HANDOFF` | @elizaos/app-lifeops | MESSAGE_HANDOFF verb: enter\|resume\|status; gates agent contributions per resume… | 6 | yes |
| `MONEY` | @elizaos/app-lifeops | money: payments(dashboard list-sources add-source remove-source import-csv list… | 24 | yes |
| `MONEY_ADD_SOURCE` | @elizaos/app-lifeops | money: payments(dashboard list-sources add-source remove-source import-csv list… | 24 | no |
| `MONEY_DASHBOARD` | @elizaos/app-lifeops | money: payments(dashboard list-sources add-source remove-source import-csv list… | 24 | no |
| `MONEY_IMPORT_CSV` | @elizaos/app-lifeops | money: payments(dashboard list-sources add-source remove-source import-csv list… | 24 | no |
| `MONEY_LIST_SOURCES` | @elizaos/app-lifeops | money: payments(dashboard list-sources add-source remove-source import-csv list… | 24 | no |
| `MONEY_LIST_TRANSACTIONS` | @elizaos/app-lifeops | money: payments(dashboard list-sources add-source remove-source import-csv list… | 24 | no |
| `MONEY_RECURRING_CHARGES` | @elizaos/app-lifeops | money: payments(dashboard list-sources add-source remove-source import-csv list… | 24 | no |
| `MONEY_REMOVE_SOURCE` | @elizaos/app-lifeops | money: payments(dashboard list-sources add-source remove-source import-csv list… | 24 | no |
| `MONEY_SPENDING_SUMMARY` | @elizaos/app-lifeops | money: payments(dashboard list-sources add-source remove-source import-csv list… | 24 | no |
| `MONEY_SUBSCRIPTION_AUDIT` | @elizaos/app-lifeops | money: payments(dashboard list-sources add-source remove-source import-csv list… | 24 | no |
| `MONEY_SUBSCRIPTION_CANCEL` | @elizaos/app-lifeops | money: payments(dashboard list-sources add-source remove-source import-csv list… | 24 | no |
| `MONEY_SUBSCRIPTION_STATUS` | @elizaos/app-lifeops | money: payments(dashboard list-sources add-source remove-source import-csv list… | 24 | no |
| `PLACE_CALL` | @elizaos/app-phone | Place a phone call via Android Telecom. Requires CALL_PHONE permission. | 1 | no |
| `PROFILE` | @elizaos/app-lifeops | persist owner state: save(name,location,age,prefs) + capture_phone(number); rem… | 14 | yes |
| `PROFILE_CAPTURE_PHONE` | @elizaos/app-lifeops | persist owner state: save(name,location,age,prefs) + capture_phone(number); rem… | 14 | no |
| `PROFILE_SAVE` | @elizaos/app-lifeops | persist owner state: save(name,location,age,prefs) + capture_phone(number); rem… | 14 | no |
| `REMOTE_DESKTOP` | @elizaos/app-lifeops | remote-desktop session lifecycle: start(confirmed,pairing-code) status(sessionI… | 6 | yes |
| `RESOLVE_REQUEST` | @elizaos/app-lifeops | approve\|reject pending request from queue, requestId optional: send_email send_… | 3 | yes |
| `RESOLVE_REQUEST_APPROVE` | @elizaos/app-lifeops | approve\|reject pending request from queue, requestId optional: send_email send_… | 3 | no |
| `RESOLVE_REQUEST_REJECT` | @elizaos/app-lifeops | approve\|reject pending request from queue, requestId optional: send_email send_… | 3 | no |
| `SCHEDULE` | @elizaos/app-lifeops | passive schedule inference activity+screen-time+health: summary \| inspect(sleep… | 2 | yes |
| `SCHEDULED_TASK` | @elizaos/app-lifeops | scheduled-task umbrella: list get create update snooze skip complete dismiss ca… | 21 | yes |
| `SCHEDULED_TASK_CANCEL` | @elizaos/app-lifeops | scheduled-task umbrella: list get create update snooze skip complete dismiss ca… | 21 | no |
| `SCHEDULED_TASK_COMPLETE` | @elizaos/app-lifeops | scheduled-task umbrella: list get create update snooze skip complete dismiss ca… | 21 | no |
| `SCHEDULED_TASK_CREATE` | @elizaos/app-lifeops | scheduled-task umbrella: list get create update snooze skip complete dismiss ca… | 21 | no |
| `SCHEDULED_TASK_DISMISS` | @elizaos/app-lifeops | scheduled-task umbrella: list get create update snooze skip complete dismiss ca… | 21 | no |
| `SCHEDULED_TASK_GET` | @elizaos/app-lifeops | scheduled-task umbrella: list get create update snooze skip complete dismiss ca… | 21 | no |
| `SCHEDULED_TASK_HISTORY` | @elizaos/app-lifeops | scheduled-task umbrella: list get create update snooze skip complete dismiss ca… | 21 | no |
| `SCHEDULED_TASK_LIST` | @elizaos/app-lifeops | scheduled-task umbrella: list get create update snooze skip complete dismiss ca… | 21 | no |
| `SCHEDULED_TASK_REOPEN` | @elizaos/app-lifeops | scheduled-task umbrella: list get create update snooze skip complete dismiss ca… | 21 | no |
| `SCHEDULED_TASK_SKIP` | @elizaos/app-lifeops | scheduled-task umbrella: list get create update snooze skip complete dismiss ca… | 21 | no |
| `SCHEDULED_TASK_SNOOZE` | @elizaos/app-lifeops | scheduled-task umbrella: list get create update snooze skip complete dismiss ca… | 21 | no |
| `SCHEDULED_TASK_UPDATE` | @elizaos/app-lifeops | scheduled-task umbrella: list get create update snooze skip complete dismiss ca… | 21 | no |
| `SCHEDULING_NEGOTIATION` | @elizaos/app-lifeops | Multi-turn scheduling negotiation lifecycle: start, propose, respond, finalize,… | 10 | yes |
| `SCREEN_TIME` | @elizaos/app-lifeops | screen-time+activity+browser focus mins: summary today weekly weekly-avg-by-app… | 11 | yes |
| `TODO` | @elizaos/plugin-todos | todo manage list; op: write\|create\|update\|complete\|cancel\|delete\|list\|clear; us… | 9 | yes |
| `TOGGLE_FEATURE` | @elizaos/app-lifeops | toggle LifeOps feature flight-booking push-notifs browser-automation escalation… | 3 | yes |
| `VOICE_CALL` | @elizaos/app-lifeops | Twilio voice dial: recipientKind=owner\|external\|e164; draft-confirm; approval-q… | 7 | yes |
| `VOICE_CALL_DIAL` | @elizaos/app-lifeops | Twilio voice dial: recipientKind=owner\|external\|e164; draft-confirm; approval-q… | 7 | no |
