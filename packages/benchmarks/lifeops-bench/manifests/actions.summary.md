# LifeOps Action Manifest — Summary

Generated: 2026-05-10T10:49:54.978Z
Filter: include=[app-contacts, app-lifeops, app-phone, plugin-bluebubbles, plugin-imessage, plugin-todos] exclude=[none] tags=[any] domains=[any] capabilities=[any] surfaces=[any] excludeRisks=[none]
Total actions: 91

## Plugin breakdown

| Plugin | Actions |
| --- | ---: |
| @elizaos/app-lifeops | 89 |
| @elizaos/app-phone | 1 |
| @elizaos/plugin-todos | 1 |

## Domain breakdown

| Domain | Actions |
| --- | ---: |
| domain:calendar | 14 |
| domain:contacts | 1 |
| domain:finance | 12 |
| domain:focus | 8 |
| domain:health | 1 |
| domain:messages | 1 |
| domain:meta | 30 |
| domain:reminders | 23 |
| domain:travel | 1 |

## Risk breakdown

| Risk | Actions |
| --- | ---: |
| (no risk) | 53 |
| risk:financial | 13 |
| risk:irreversible | 21 |
| risk:user-visible | 4 |

## Actions by domain

### domain:calendar

| Action | Plugin | Risk | Capabilities | Surfaces | Description |
| --- | --- | :---: | --- | --- | --- |
| `CALENDAR` | @elizaos/app-lifeops | — | read, write, update, delete | remote-api, internal | calendar event CRUD + availability + prefs; subactions create_event\|update_even… |
| `CALENDAR_BULK_RESCHEDULE` | @elizaos/app-lifeops | — | read, write, update, delete | remote-api, internal | calendar event CRUD + availability + prefs; subactions create_event\|update_even… |
| `CALENDAR_CHECK_AVAILABILITY` | @elizaos/app-lifeops | — | read, write, update, delete | remote-api, internal | calendar event CRUD + availability + prefs; subactions create_event\|update_even… |
| `CALENDAR_CREATE_EVENT` | @elizaos/app-lifeops | — | read, write, update, delete | remote-api, internal | calendar event CRUD + availability + prefs; subactions create_event\|update_even… |
| `CALENDAR_DELETE_EVENT` | @elizaos/app-lifeops | — | read, write, update, delete | remote-api, internal | calendar event CRUD + availability + prefs; subactions create_event\|update_even… |
| `CALENDAR_FEED` | @elizaos/app-lifeops | — | read, write, update, delete | remote-api, internal | calendar event CRUD + availability + prefs; subactions create_event\|update_even… |
| `CALENDAR_NEXT_EVENT` | @elizaos/app-lifeops | — | read, write, update, delete | remote-api, internal | calendar event CRUD + availability + prefs; subactions create_event\|update_even… |
| `CALENDAR_PROPOSE_TIMES` | @elizaos/app-lifeops | — | read, write, update, delete | remote-api, internal | calendar event CRUD + availability + prefs; subactions create_event\|update_even… |
| `CALENDAR_SEARCH_EVENTS` | @elizaos/app-lifeops | — | read, write, update, delete | remote-api, internal | calendar event CRUD + availability + prefs; subactions create_event\|update_even… |
| `CALENDAR_TRIP_WINDOW` | @elizaos/app-lifeops | — | read, write, update, delete | remote-api, internal | calendar event CRUD + availability + prefs; subactions create_event\|update_even… |
| `CALENDAR_UPDATE_EVENT` | @elizaos/app-lifeops | — | read, write, update, delete | remote-api, internal | calendar event CRUD + availability + prefs; subactions create_event\|update_even… |
| `CALENDAR_UPDATE_PREFERENCES` | @elizaos/app-lifeops | — | read, write, update, delete | remote-api, internal | calendar event CRUD + availability + prefs; subactions create_event\|update_even… |
| `CALENDLY` | @elizaos/app-lifeops | — | read, write | remote-api | calendly: list_event_types\|availability\|upcoming_events\|single_use_link; route … |
| `SCHEDULING_NEGOTIATION` | @elizaos/app-lifeops | — | read, write, update | internal | multi-turn meeting negotiation: start\|propose\|respond\|finalize\|cancel\|list; onl… |

### domain:contacts

| Action | Plugin | Risk | Capabilities | Surfaces | Description |
| --- | --- | :---: | --- | --- | --- |
| `ENTITY` | @elizaos/app-lifeops | — | read, write, update, delete | internal | people+relationships: add\|list\|set_identity\|set_relationship\|log_interaction\|me… |

### domain:finance

| Action | Plugin | Risk | Capabilities | Surfaces | Description |
| --- | --- | :---: | --- | --- | --- |
| `MONEY` | @elizaos/app-lifeops | risk:financial | read, write, update, delete, execute | remote-api, internal | payments+subscriptions: dashboard\|list_sources\|add_source\|remove_source\|import_… |
| `MONEY_ADD_SOURCE` | @elizaos/app-lifeops | risk:financial | read, write, update, delete, execute | remote-api, internal | payments+subscriptions: dashboard\|list_sources\|add_source\|remove_source\|import_… |
| `MONEY_DASHBOARD` | @elizaos/app-lifeops | risk:financial | read, write, update, delete, execute | remote-api, internal | payments+subscriptions: dashboard\|list_sources\|add_source\|remove_source\|import_… |
| `MONEY_IMPORT_CSV` | @elizaos/app-lifeops | risk:financial | read, write, update, delete, execute | remote-api, internal | payments+subscriptions: dashboard\|list_sources\|add_source\|remove_source\|import_… |
| `MONEY_LIST_SOURCES` | @elizaos/app-lifeops | risk:financial | read, write, update, delete, execute | remote-api, internal | payments+subscriptions: dashboard\|list_sources\|add_source\|remove_source\|import_… |
| `MONEY_LIST_TRANSACTIONS` | @elizaos/app-lifeops | risk:financial | read, write, update, delete, execute | remote-api, internal | payments+subscriptions: dashboard\|list_sources\|add_source\|remove_source\|import_… |
| `MONEY_RECURRING_CHARGES` | @elizaos/app-lifeops | risk:financial | read, write, update, delete, execute | remote-api, internal | payments+subscriptions: dashboard\|list_sources\|add_source\|remove_source\|import_… |
| `MONEY_REMOVE_SOURCE` | @elizaos/app-lifeops | risk:financial | read, write, update, delete, execute | remote-api, internal | payments+subscriptions: dashboard\|list_sources\|add_source\|remove_source\|import_… |
| `MONEY_SPENDING_SUMMARY` | @elizaos/app-lifeops | risk:financial | read, write, update, delete, execute | remote-api, internal | payments+subscriptions: dashboard\|list_sources\|add_source\|remove_source\|import_… |
| `MONEY_SUBSCRIPTION_AUDIT` | @elizaos/app-lifeops | risk:financial | read, write, update, delete, execute | remote-api, internal | payments+subscriptions: dashboard\|list_sources\|add_source\|remove_source\|import_… |
| `MONEY_SUBSCRIPTION_CANCEL` | @elizaos/app-lifeops | risk:financial | read, write, update, delete, execute | remote-api, internal | payments+subscriptions: dashboard\|list_sources\|add_source\|remove_source\|import_… |
| `MONEY_SUBSCRIPTION_STATUS` | @elizaos/app-lifeops | risk:financial | read, write, update, delete, execute | remote-api, internal | payments+subscriptions: dashboard\|list_sources\|add_source\|remove_source\|import_… |

### domain:focus

| Action | Plugin | Risk | Capabilities | Surfaces | Description |
| --- | --- | :---: | --- | --- | --- |
| `BLOCK` | @elizaos/app-lifeops | risk:irreversible | write, update, delete, read, execute | device | block/unblock apps+websites; subactions block\|unblock\|status\|request_permission… |
| `BLOCK_BLOCK` | @elizaos/app-lifeops | risk:irreversible | write, update, delete, read, execute | device | block/unblock apps+websites; subactions block\|unblock\|status\|request_permission… |
| `BLOCK_LIST_ACTIVE` | @elizaos/app-lifeops | risk:irreversible | write, update, delete, read, execute | device | block/unblock apps+websites; subactions block\|unblock\|status\|request_permission… |
| `BLOCK_RELEASE` | @elizaos/app-lifeops | risk:irreversible | write, update, delete, read, execute | device | block/unblock apps+websites; subactions block\|unblock\|status\|request_permission… |
| `BLOCK_REQUEST_PERMISSION` | @elizaos/app-lifeops | risk:irreversible | write, update, delete, read, execute | device | block/unblock apps+websites; subactions block\|unblock\|status\|request_permission… |
| `BLOCK_STATUS` | @elizaos/app-lifeops | risk:irreversible | write, update, delete, read, execute | device | block/unblock apps+websites; subactions block\|unblock\|status\|request_permission… |
| `BLOCK_UNBLOCK` | @elizaos/app-lifeops | risk:irreversible | write, update, delete, read, execute | device | block/unblock apps+websites; subactions block\|unblock\|status\|request_permission… |
| `SCREEN_TIME` | @elizaos/app-lifeops | — | read | device | screen-time+activity reads: summary\|today\|weekly\|weekly_average_by_app\|by_app\|b… |

### domain:health

| Action | Plugin | Risk | Capabilities | Surfaces | Description |
| --- | --- | :---: | --- | --- | --- |
| `HEALTH` | @elizaos/app-lifeops | — | read | remote-api | read health/fitness telemetry; subactions today\|trend\|by_metric\|status; metrics… |

### domain:messages

| Action | Plugin | Risk | Capabilities | Surfaces | Description |
| --- | --- | :---: | --- | --- | --- |
| `MESSAGE` | @elizaos/app-lifeops | risk:irreversible | read, write, update, delete, send, schedule | remote-api | primary message action ops send read_channel read_with_contact search list_chan… |

### domain:meta

| Action | Plugin | Risk | Capabilities | Surfaces | Description |
| --- | --- | :---: | --- | --- | --- |
| `CONNECTOR` | @elizaos/app-lifeops | — | read, write, update, delete | remote-api, internal | connector lifecycle: connect\|disconnect\|verify\|status\|list; registry-driven kin… |
| `CONNECTOR_CONNECT` | @elizaos/app-lifeops | — | read, write, update, delete | remote-api, internal | connector lifecycle: connect\|disconnect\|verify\|status\|list; registry-driven kin… |
| `CONNECTOR_DISCONNECT` | @elizaos/app-lifeops | — | read, write, update, delete | remote-api, internal | connector lifecycle: connect\|disconnect\|verify\|status\|list; registry-driven kin… |
| `CONNECTOR_LIST` | @elizaos/app-lifeops | — | read, write, update, delete | remote-api, internal | connector lifecycle: connect\|disconnect\|verify\|status\|list; registry-driven kin… |
| `CONNECTOR_STATUS` | @elizaos/app-lifeops | — | read, write, update, delete | remote-api, internal | connector lifecycle: connect\|disconnect\|verify\|status\|list; registry-driven kin… |
| `CONNECTOR_VERIFY` | @elizaos/app-lifeops | — | read, write, update, delete | remote-api, internal | connector lifecycle: connect\|disconnect\|verify\|status\|list; registry-driven kin… |
| `CREDENTIALS` | @elizaos/app-lifeops | risk:irreversible | read, write, update, execute | device, internal | credentials: fill\|whitelist_add\|whitelist_list\|search\|list\|inject_username\|inje… |
| `CREDENTIALS_FILL` | @elizaos/app-lifeops | risk:irreversible | read, write, update, execute | device, internal | credentials: fill\|whitelist_add\|whitelist_list\|search\|list\|inject_username\|inje… |
| `CREDENTIALS_INJECT_PASSWORD` | @elizaos/app-lifeops | risk:irreversible | read, write, update, execute | device, internal | credentials: fill\|whitelist_add\|whitelist_list\|search\|list\|inject_username\|inje… |
| `CREDENTIALS_INJECT_USERNAME` | @elizaos/app-lifeops | risk:irreversible | read, write, update, execute | device, internal | credentials: fill\|whitelist_add\|whitelist_list\|search\|list\|inject_username\|inje… |
| `CREDENTIALS_LIST` | @elizaos/app-lifeops | risk:irreversible | read, write, update, execute | device, internal | credentials: fill\|whitelist_add\|whitelist_list\|search\|list\|inject_username\|inje… |
| `CREDENTIALS_SEARCH` | @elizaos/app-lifeops | risk:irreversible | read, write, update, execute | device, internal | credentials: fill\|whitelist_add\|whitelist_list\|search\|list\|inject_username\|inje… |
| `CREDENTIALS_WHITELIST_ADD` | @elizaos/app-lifeops | risk:irreversible | read, write, update, execute | device, internal | credentials: fill\|whitelist_add\|whitelist_list\|search\|list\|inject_username\|inje… |
| `CREDENTIALS_WHITELIST_LIST` | @elizaos/app-lifeops | risk:irreversible | read, write, update, execute | device, internal | credentials: fill\|whitelist_add\|whitelist_list\|search\|list\|inject_username\|inje… |
| `DEVICE_INTENT` | @elizaos/app-lifeops | risk:user-visible | execute, send | device | ONE-SHOT push fan-out to paired devices NOW. NOT for habits/routines/recurring … |
| `FIRST_RUN` | @elizaos/app-lifeops | — | execute, write | internal | owner first-run: defaults\|customize\|replay; defaults asks wake time once |
| `LIFEOPS` | @elizaos/app-lifeops | risk:irreversible | execute, update, delete | internal | owner LIFEOPS verb: pause\|resume\|wipe; wipe requires confirmed:true |
| `MESSAGE_HANDOFF` | @elizaos/app-lifeops | — | execute, update, read | internal | room handoff: enter\|resume\|status; gates agent per resumeOn condition |
| `PLACE_CALL` | @elizaos/app-phone | risk:user-visible | execute, send | device | Place a phone call via Android Telecom. Requires CALL_PHONE permission. |
| `PROFILE` | @elizaos/app-lifeops | — | read, write, update | internal | save owner facts+prefs: subactions save\|capture_phone; reminder/escalation poli… |
| `PROFILE_CAPTURE_PHONE` | @elizaos/app-lifeops | — | read, write, update | internal | save owner facts+prefs: subactions save\|capture_phone; reminder/escalation poli… |
| `PROFILE_SAVE` | @elizaos/app-lifeops | — | read, write, update | internal | save owner facts+prefs: subactions save\|capture_phone; reminder/escalation poli… |
| `REMOTE_DESKTOP` | @elizaos/app-lifeops | risk:irreversible | read, write, execute, delete | device, internal | remote-desktop sessions: start\|status\|end\|list\|revoke; start requires confirmed… |
| `RESOLVE_REQUEST` | @elizaos/app-lifeops | risk:irreversible | execute, update | internal | approve\|reject queued action; requestId optional; covers send_email\|send_messag… |
| `RESOLVE_REQUEST_APPROVE` | @elizaos/app-lifeops | risk:irreversible | execute, update | internal | approve\|reject queued action; requestId optional; covers send_email\|send_messag… |
| `RESOLVE_REQUEST_REJECT` | @elizaos/app-lifeops | risk:irreversible | execute, update | internal | approve\|reject queued action; requestId optional; covers send_email\|send_messag… |
| `SCHEDULE` | @elizaos/app-lifeops | — | read | internal | passive schedule inference activity+screen-time+health: summary \| inspect(sleep… |
| `TOGGLE_FEATURE` | @elizaos/app-lifeops | — | update | internal | enable\|disable LifeOps feature flag; registry-driven keys (flight-booking, push… |
| `VOICE_CALL` | @elizaos/app-lifeops | risk:user-visible | execute, send | remote-api | Twilio voice dial: recipientKind=owner\|external\|e164; draft-confirm; approval-q… |
| `VOICE_CALL_DIAL` | @elizaos/app-lifeops | risk:user-visible | execute, send | remote-api | Twilio voice dial: recipientKind=owner\|external\|e164; draft-confirm; approval-q… |

### domain:reminders

| Action | Plugin | Risk | Capabilities | Surfaces | Description |
| --- | --- | :---: | --- | --- | --- |
| `LIFE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | manage personal habits+routines+reminders+alarms+todos+goals; subactions create… |
| `LIFE_COMPLETE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | manage personal habits+routines+reminders+alarms+todos+goals; subactions create… |
| `LIFE_CREATE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | manage personal habits+routines+reminders+alarms+todos+goals; subactions create… |
| `LIFE_DELETE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | manage personal habits+routines+reminders+alarms+todos+goals; subactions create… |
| `LIFE_POLICY_CONFIGURE_ESCALATION` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | manage personal habits+routines+reminders+alarms+todos+goals; subactions create… |
| `LIFE_POLICY_SET_REMINDER` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | manage personal habits+routines+reminders+alarms+todos+goals; subactions create… |
| `LIFE_REVIEW` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | manage personal habits+routines+reminders+alarms+todos+goals; subactions create… |
| `LIFE_SKIP` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | manage personal habits+routines+reminders+alarms+todos+goals; subactions create… |
| `LIFE_SNOOZE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | manage personal habits+routines+reminders+alarms+todos+goals; subactions create… |
| `LIFE_UPDATE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | manage personal habits+routines+reminders+alarms+todos+goals; subactions create… |
| `SCHEDULED_TASK` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|dismiss\|cancel\|reo… |
| `SCHEDULED_TASK_CANCEL` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|dismiss\|cancel\|reo… |
| `SCHEDULED_TASK_COMPLETE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|dismiss\|cancel\|reo… |
| `SCHEDULED_TASK_CREATE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|dismiss\|cancel\|reo… |
| `SCHEDULED_TASK_DISMISS` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|dismiss\|cancel\|reo… |
| `SCHEDULED_TASK_GET` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|dismiss\|cancel\|reo… |
| `SCHEDULED_TASK_HISTORY` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|dismiss\|cancel\|reo… |
| `SCHEDULED_TASK_LIST` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|dismiss\|cancel\|reo… |
| `SCHEDULED_TASK_REOPEN` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|dismiss\|cancel\|reo… |
| `SCHEDULED_TASK_SKIP` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|dismiss\|cancel\|reo… |
| `SCHEDULED_TASK_SNOOZE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|dismiss\|cancel\|reo… |
| `SCHEDULED_TASK_UPDATE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|dismiss\|cancel\|reo… |
| `TODO` | @elizaos/plugin-todos | — | read, write, update, delete | internal | todos: write\|create\|update\|complete\|cancel\|delete\|list\|clear; user-scoped (enti… |

### domain:travel

| Action | Plugin | Risk | Capabilities | Surfaces | Description |
| --- | --- | :---: | --- | --- | --- |
| `BOOK_TRAVEL` | @elizaos/app-lifeops | risk:financial | read, write, execute | remote-api | book real flights+hotels; drafts then requires owner approval; syncs calendar |
