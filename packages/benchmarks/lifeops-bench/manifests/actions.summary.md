# LifeOps Action Manifest — Summary

Generated: 2026-05-12T01:28:57.675Z
Filter: include=[app-contacts, app-lifeops, app-phone, plugin-bluebubbles, plugin-imessage, plugin-todos] exclude=[none] tags=[any] domains=[any] capabilities=[any] surfaces=[any] excludeRisks=[none]
Total actions: 150

## Plugin breakdown

| Plugin | Actions |
| --- | ---: |
| @elizaos/app-lifeops | 149 |
| @elizaos/plugin-todos | 1 |

## Domain breakdown

| Domain | Actions |
| --- | ---: |
| (untagged) | 48 |
| domain:calendar | 16 |
| domain:contacts | 1 |
| domain:focus | 11 |
| domain:messages | 1 |
| domain:meta | 20 |
| domain:reminders | 53 |

## Risk breakdown

| Risk | Actions |
| --- | ---: |
| (no risk) | 128 |
| risk:irreversible | 20 |
| risk:user-visible | 2 |

## Actions by domain

### (untagged)

| Action | Plugin | Risk | Capabilities | Surfaces | Description |
| --- | --- | :---: | --- | --- | --- |
| `BRIEF` | @elizaos/app-lifeops | — | read | internal | briefing: compose_morning\|compose_evening\|compose_weekly; LifeOpsBriefing shape… |
| `BRIEF_COMPOSE_EVENING` | @elizaos/app-lifeops | — | read | internal | briefing: compose_morning\|compose_evening\|compose_weekly; LifeOpsBriefing shape… |
| `BRIEF_COMPOSE_MORNING` | @elizaos/app-lifeops | — | read | internal | briefing: compose_morning\|compose_evening\|compose_weekly; LifeOpsBriefing shape… |
| `BRIEF_COMPOSE_WEEKLY` | @elizaos/app-lifeops | — | read | internal | briefing: compose_morning\|compose_evening\|compose_weekly; LifeOpsBriefing shape… |
| `DOC` | @elizaos/app-lifeops | — | read, write, update, schedule | internal | docs: request_signature\|request_approval\|track_deadline\|upload_asset\|collect_id… |
| `DOC_CLOSE_REQUEST` | @elizaos/app-lifeops | — | read, write, update, schedule | internal | docs: request_signature\|request_approval\|track_deadline\|upload_asset\|collect_id… |
| `DOC_COLLECT_ID` | @elizaos/app-lifeops | — | read, write, update, schedule | internal | docs: request_signature\|request_approval\|track_deadline\|upload_asset\|collect_id… |
| `DOC_REQUEST_APPROVAL` | @elizaos/app-lifeops | — | read, write, update, schedule | internal | docs: request_signature\|request_approval\|track_deadline\|upload_asset\|collect_id… |
| `DOC_REQUEST_SIGNATURE` | @elizaos/app-lifeops | — | read, write, update, schedule | internal | docs: request_signature\|request_approval\|track_deadline\|upload_asset\|collect_id… |
| `DOC_TRACK_DEADLINE` | @elizaos/app-lifeops | — | read, write, update, schedule | internal | docs: request_signature\|request_approval\|track_deadline\|upload_asset\|collect_id… |
| `DOC_UPLOAD_ASSET` | @elizaos/app-lifeops | — | read, write, update, schedule | internal | docs: request_signature\|request_approval\|track_deadline\|upload_asset\|collect_id… |
| `INBOX_UNIFIED` | @elizaos/app-lifeops | — | read | internal | unified inbox: list\|search\|summarize across gmail\|slack\|discord\|telegram\|signal… |
| `INBOX_UNIFIED_LIST` | @elizaos/app-lifeops | — | read | internal | unified inbox: list\|search\|summarize across gmail\|slack\|discord\|telegram\|signal… |
| `INBOX_UNIFIED_SEARCH` | @elizaos/app-lifeops | — | read | internal | unified inbox: list\|search\|summarize across gmail\|slack\|discord\|telegram\|signal… |
| `INBOX_UNIFIED_SUMMARIZE` | @elizaos/app-lifeops | — | read | internal | unified inbox: list\|search\|summarize across gmail\|slack\|discord\|telegram\|signal… |
| `OWNER_FINANCES` | @elizaos/app-lifeops | — |  |  | owner finances: dashboard\|list_sources\|add_source\|remove_source\|import_csv\|list… |
| `OWNER_FINANCES_ADD_SOURCE` | @elizaos/app-lifeops | — |  |  | owner finances: dashboard\|list_sources\|add_source\|remove_source\|import_csv\|list… |
| `OWNER_FINANCES_DASHBOARD` | @elizaos/app-lifeops | — |  |  | owner finances: dashboard\|list_sources\|add_source\|remove_source\|import_csv\|list… |
| `OWNER_FINANCES_IMPORT_CSV` | @elizaos/app-lifeops | — |  |  | owner finances: dashboard\|list_sources\|add_source\|remove_source\|import_csv\|list… |
| `OWNER_FINANCES_LIST_SOURCES` | @elizaos/app-lifeops | — |  |  | owner finances: dashboard\|list_sources\|add_source\|remove_source\|import_csv\|list… |
| `OWNER_FINANCES_LIST_TRANSACTIONS` | @elizaos/app-lifeops | — |  |  | owner finances: dashboard\|list_sources\|add_source\|remove_source\|import_csv\|list… |
| `OWNER_FINANCES_RECURRING_CHARGES` | @elizaos/app-lifeops | — |  |  | owner finances: dashboard\|list_sources\|add_source\|remove_source\|import_csv\|list… |
| `OWNER_FINANCES_REMOVE_SOURCE` | @elizaos/app-lifeops | — |  |  | owner finances: dashboard\|list_sources\|add_source\|remove_source\|import_csv\|list… |
| `OWNER_FINANCES_SPENDING_SUMMARY` | @elizaos/app-lifeops | — |  |  | owner finances: dashboard\|list_sources\|add_source\|remove_source\|import_csv\|list… |
| `OWNER_FINANCES_SUBSCRIPTION_AUDIT` | @elizaos/app-lifeops | — |  |  | owner finances: dashboard\|list_sources\|add_source\|remove_source\|import_csv\|list… |
| `OWNER_FINANCES_SUBSCRIPTION_CANCEL` | @elizaos/app-lifeops | — |  |  | owner finances: dashboard\|list_sources\|add_source\|remove_source\|import_csv\|list… |
| `OWNER_FINANCES_SUBSCRIPTION_STATUS` | @elizaos/app-lifeops | — |  |  | owner finances: dashboard\|list_sources\|add_source\|remove_source\|import_csv\|list… |
| `OWNER_HEALTH` | @elizaos/app-lifeops | — |  |  | owner health: today\|trend\|by_metric\|status; read-only telemetry |
| `OWNER_HEALTH_BY_METRIC` | @elizaos/app-lifeops | — |  |  | owner health: today\|trend\|by_metric\|status; read-only telemetry |
| `OWNER_HEALTH_STATUS` | @elizaos/app-lifeops | — |  |  | owner health: today\|trend\|by_metric\|status; read-only telemetry |
| `OWNER_HEALTH_TODAY` | @elizaos/app-lifeops | — |  |  | owner health: today\|trend\|by_metric\|status; read-only telemetry |
| `OWNER_HEALTH_TREND` | @elizaos/app-lifeops | — |  |  | owner health: today\|trend\|by_metric\|status; read-only telemetry |
| `OWNER_SCREENTIME` | @elizaos/app-lifeops | — |  |  | owner screentime: summary\|today\|weekly\|by_app\|by_website\|activity_report\|time_o… |
| `OWNER_SCREENTIME_ACTIVITY_REPORT` | @elizaos/app-lifeops | — |  |  | owner screentime: summary\|today\|weekly\|by_app\|by_website\|activity_report\|time_o… |
| `OWNER_SCREENTIME_BROWSER_ACTIVITY` | @elizaos/app-lifeops | — |  |  | owner screentime: summary\|today\|weekly\|by_app\|by_website\|activity_report\|time_o… |
| `OWNER_SCREENTIME_BY_APP` | @elizaos/app-lifeops | — |  |  | owner screentime: summary\|today\|weekly\|by_app\|by_website\|activity_report\|time_o… |
| `OWNER_SCREENTIME_BY_WEBSITE` | @elizaos/app-lifeops | — |  |  | owner screentime: summary\|today\|weekly\|by_app\|by_website\|activity_report\|time_o… |
| `OWNER_SCREENTIME_SUMMARY` | @elizaos/app-lifeops | — |  |  | owner screentime: summary\|today\|weekly\|by_app\|by_website\|activity_report\|time_o… |
| `OWNER_SCREENTIME_TIME_ON_APP` | @elizaos/app-lifeops | — |  |  | owner screentime: summary\|today\|weekly\|by_app\|by_website\|activity_report\|time_o… |
| `OWNER_SCREENTIME_TIME_ON_SITE` | @elizaos/app-lifeops | — |  |  | owner screentime: summary\|today\|weekly\|by_app\|by_website\|activity_report\|time_o… |
| `OWNER_SCREENTIME_TODAY` | @elizaos/app-lifeops | — |  |  | owner screentime: summary\|today\|weekly\|by_app\|by_website\|activity_report\|time_o… |
| `OWNER_SCREENTIME_WEEKLY` | @elizaos/app-lifeops | — |  |  | owner screentime: summary\|today\|weekly\|by_app\|by_website\|activity_report\|time_o… |
| `OWNER_SCREENTIME_WEEKLY_AVERAGE_BY_APP` | @elizaos/app-lifeops | — |  |  | owner screentime: summary\|today\|weekly\|by_app\|by_website\|activity_report\|time_o… |
| `PERSONAL_ASSISTANT` | @elizaos/app-lifeops | — |  |  | personal assistant workflows: action=book_travel\|scheduling\|sign_document |
| `PERSONAL_ASSISTANT_BOOK_TRAVEL` | @elizaos/app-lifeops | — |  |  | personal assistant workflows: action=book_travel\|scheduling\|sign_document |
| `PERSONAL_ASSISTANT_SCHEDULING` | @elizaos/app-lifeops | — |  |  | personal assistant workflows: action=book_travel\|scheduling\|sign_document |
| `PERSONAL_ASSISTANT_SIGN_DOCUMENT` | @elizaos/app-lifeops | — |  |  | personal assistant workflows: action=book_travel\|scheduling\|sign_document |
| `WORK_THREAD` | @elizaos/app-lifeops | — |  |  | work-thread lifecycle: create\|steer\|stop\|mark_waiting\|mark_completed\|merge\|atta… |

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
| `CONFLICT_DETECT` | @elizaos/app-lifeops | — | read | internal | calendar conflicts: scan_today\|scan_week\|scan_event_proposal; severity warning\|… |
| `CONFLICT_DETECT_SCAN_EVENT_PROPOSAL` | @elizaos/app-lifeops | — | read | internal | calendar conflicts: scan_today\|scan_week\|scan_event_proposal; severity warning\|… |
| `CONFLICT_DETECT_SCAN_TODAY` | @elizaos/app-lifeops | — | read | internal | calendar conflicts: scan_today\|scan_week\|scan_event_proposal; severity warning\|… |
| `CONFLICT_DETECT_SCAN_WEEK` | @elizaos/app-lifeops | — | read | internal | calendar conflicts: scan_today\|scan_week\|scan_event_proposal; severity warning\|… |

### domain:contacts

| Action | Plugin | Risk | Capabilities | Surfaces | Description |
| --- | --- | :---: | --- | --- | --- |
| `ENTITY` | @elizaos/app-lifeops | — | read, write, update, delete | internal | people+relationships: create\|read\|set_identity\|set_relationship\|log_interaction… |

### domain:focus

| Action | Plugin | Risk | Capabilities | Surfaces | Description |
| --- | --- | :---: | --- | --- | --- |
| `BLOCK` | @elizaos/app-lifeops | risk:irreversible | write, update, delete, read, execute | device | block/unblock phone apps + desktop websites only (NOT calendar time-blocks/focu… |
| `BLOCK_BLOCK` | @elizaos/app-lifeops | risk:irreversible | write, update, delete, read, execute | device | block/unblock phone apps + desktop websites only (NOT calendar time-blocks/focu… |
| `BLOCK_LIST_ACTIVE` | @elizaos/app-lifeops | risk:irreversible | write, update, delete, read, execute | device | block/unblock phone apps + desktop websites only (NOT calendar time-blocks/focu… |
| `BLOCK_RELEASE` | @elizaos/app-lifeops | risk:irreversible | write, update, delete, read, execute | device | block/unblock phone apps + desktop websites only (NOT calendar time-blocks/focu… |
| `BLOCK_REQUEST_PERMISSION` | @elizaos/app-lifeops | risk:irreversible | write, update, delete, read, execute | device | block/unblock phone apps + desktop websites only (NOT calendar time-blocks/focu… |
| `BLOCK_STATUS` | @elizaos/app-lifeops | risk:irreversible | write, update, delete, read, execute | device | block/unblock phone apps + desktop websites only (NOT calendar time-blocks/focu… |
| `BLOCK_UNBLOCK` | @elizaos/app-lifeops | risk:irreversible | write, update, delete, read, execute | device | block/unblock phone apps + desktop websites only (NOT calendar time-blocks/focu… |
| `PRIORITIZE` | @elizaos/app-lifeops | — | read | internal | prioritize: rank_todos\|rank_threads\|rank_decisions; topN ranking by urgency × i… |
| `PRIORITIZE_RANK_DECISIONS` | @elizaos/app-lifeops | — | read | internal | prioritize: rank_todos\|rank_threads\|rank_decisions; topN ranking by urgency × i… |
| `PRIORITIZE_RANK_THREADS` | @elizaos/app-lifeops | — | read | internal | prioritize: rank_todos\|rank_threads\|rank_decisions; topN ranking by urgency × i… |
| `PRIORITIZE_RANK_TODOS` | @elizaos/app-lifeops | — | read | internal | prioritize: rank_todos\|rank_threads\|rank_decisions; topN ranking by urgency × i… |

### domain:messages

| Action | Plugin | Risk | Capabilities | Surfaces | Description |
| --- | --- | :---: | --- | --- | --- |
| `MESSAGE` | @elizaos/app-lifeops | risk:irreversible | read, write, update, delete, send, schedule | remote-api | primary message action send read_channel read_with_contact search list_channels… |

### domain:meta

| Action | Plugin | Risk | Capabilities | Surfaces | Description |
| --- | --- | :---: | --- | --- | --- |
| `CONNECTOR` | @elizaos/app-lifeops | — | read, write, update, delete | remote-api, internal | account-level connector lifecycle: connect(log in)\|disconnect(log out)\|verify\|s… |
| `CONNECTOR_CONNECT` | @elizaos/app-lifeops | — | read, write, update, delete | remote-api, internal | account-level connector lifecycle: connect(log in)\|disconnect(log out)\|verify\|s… |
| `CONNECTOR_DISCONNECT` | @elizaos/app-lifeops | — | read, write, update, delete | remote-api, internal | account-level connector lifecycle: connect(log in)\|disconnect(log out)\|verify\|s… |
| `CONNECTOR_LIST` | @elizaos/app-lifeops | — | read, write, update, delete | remote-api, internal | account-level connector lifecycle: connect(log in)\|disconnect(log out)\|verify\|s… |
| `CONNECTOR_STATUS` | @elizaos/app-lifeops | — | read, write, update, delete | remote-api, internal | account-level connector lifecycle: connect(log in)\|disconnect(log out)\|verify\|s… |
| `CONNECTOR_VERIFY` | @elizaos/app-lifeops | — | read, write, update, delete | remote-api, internal | account-level connector lifecycle: connect(log in)\|disconnect(log out)\|verify\|s… |
| `CREDENTIALS` | @elizaos/app-lifeops | risk:irreversible | read, write, update, execute | device, internal | credentials: fill\|whitelist_add\|whitelist_list\|search\|list\|inject_username\|inje… |
| `CREDENTIALS_FILL` | @elizaos/app-lifeops | risk:irreversible | read, write, update, execute | device, internal | credentials: fill\|whitelist_add\|whitelist_list\|search\|list\|inject_username\|inje… |
| `CREDENTIALS_INJECT_PASSWORD` | @elizaos/app-lifeops | risk:irreversible | read, write, update, execute | device, internal | credentials: fill\|whitelist_add\|whitelist_list\|search\|list\|inject_username\|inje… |
| `CREDENTIALS_INJECT_USERNAME` | @elizaos/app-lifeops | risk:irreversible | read, write, update, execute | device, internal | credentials: fill\|whitelist_add\|whitelist_list\|search\|list\|inject_username\|inje… |
| `CREDENTIALS_LIST` | @elizaos/app-lifeops | risk:irreversible | read, write, update, execute | device, internal | credentials: fill\|whitelist_add\|whitelist_list\|search\|list\|inject_username\|inje… |
| `CREDENTIALS_SEARCH` | @elizaos/app-lifeops | risk:irreversible | read, write, update, execute | device, internal | credentials: fill\|whitelist_add\|whitelist_list\|search\|list\|inject_username\|inje… |
| `CREDENTIALS_WHITELIST_ADD` | @elizaos/app-lifeops | risk:irreversible | read, write, update, execute | device, internal | credentials: fill\|whitelist_add\|whitelist_list\|search\|list\|inject_username\|inje… |
| `CREDENTIALS_WHITELIST_LIST` | @elizaos/app-lifeops | risk:irreversible | read, write, update, execute | device, internal | credentials: fill\|whitelist_add\|whitelist_list\|search\|list\|inject_username\|inje… |
| `REMOTE_DESKTOP` | @elizaos/app-lifeops | risk:irreversible | read, write, execute, delete | device, internal | remote-desktop sessions: start\|status\|end\|list\|revoke; start requires confirmed… |
| `RESOLVE_REQUEST` | @elizaos/app-lifeops | risk:irreversible | execute, update | internal | approve\|reject queued action; requestId optional; covers send_email\|send_messag… |
| `RESOLVE_REQUEST_APPROVE` | @elizaos/app-lifeops | risk:irreversible | execute, update | internal | approve\|reject queued action; requestId optional; covers send_email\|send_messag… |
| `RESOLVE_REQUEST_REJECT` | @elizaos/app-lifeops | risk:irreversible | execute, update | internal | approve\|reject queued action; requestId optional; covers send_email\|send_messag… |
| `VOICE_CALL` | @elizaos/app-lifeops | risk:user-visible | execute, send | remote-api | Twilio voice dial: recipientKind=owner\|external\|e164; draft-confirm; approval-q… |
| `VOICE_CALL_DIAL` | @elizaos/app-lifeops | risk:user-visible | execute, send | remote-api | Twilio voice dial: recipientKind=owner\|external\|e164; draft-confirm; approval-q… |

### domain:reminders

| Action | Plugin | Risk | Capabilities | Surfaces | Description |
| --- | --- | :---: | --- | --- | --- |
| `OWNER_ALARMS` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner alarms: action=create\|update\|delete\|complete\|skip\|snooze\|review |
| `OWNER_ALARMS_COMPLETE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner alarms: action=create\|update\|delete\|complete\|skip\|snooze\|review |
| `OWNER_ALARMS_CREATE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner alarms: action=create\|update\|delete\|complete\|skip\|snooze\|review |
| `OWNER_ALARMS_DELETE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner alarms: action=create\|update\|delete\|complete\|skip\|snooze\|review |
| `OWNER_ALARMS_REVIEW` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner alarms: action=create\|update\|delete\|complete\|skip\|snooze\|review |
| `OWNER_ALARMS_SKIP` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner alarms: action=create\|update\|delete\|complete\|skip\|snooze\|review |
| `OWNER_ALARMS_SNOOZE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner alarms: action=create\|update\|delete\|complete\|skip\|snooze\|review |
| `OWNER_ALARMS_UPDATE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner alarms: action=create\|update\|delete\|complete\|skip\|snooze\|review |
| `OWNER_GOALS` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner goals: action=create\|update\|delete\|review; backing kind=goal |
| `OWNER_GOALS_CREATE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner goals: action=create\|update\|delete\|review; backing kind=goal |
| `OWNER_GOALS_DELETE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner goals: action=create\|update\|delete\|review; backing kind=goal |
| `OWNER_GOALS_REVIEW` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner goals: action=create\|update\|delete\|review; backing kind=goal |
| `OWNER_GOALS_UPDATE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner goals: action=create\|update\|delete\|review; backing kind=goal |
| `OWNER_REMINDERS` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner reminders: action=create\|update\|delete\|complete\|skip\|snooze\|review |
| `OWNER_REMINDERS_COMPLETE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner reminders: action=create\|update\|delete\|complete\|skip\|snooze\|review |
| `OWNER_REMINDERS_CREATE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner reminders: action=create\|update\|delete\|complete\|skip\|snooze\|review |
| `OWNER_REMINDERS_DELETE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner reminders: action=create\|update\|delete\|complete\|skip\|snooze\|review |
| `OWNER_REMINDERS_REVIEW` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner reminders: action=create\|update\|delete\|complete\|skip\|snooze\|review |
| `OWNER_REMINDERS_SKIP` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner reminders: action=create\|update\|delete\|complete\|skip\|snooze\|review |
| `OWNER_REMINDERS_SNOOZE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner reminders: action=create\|update\|delete\|complete\|skip\|snooze\|review |
| `OWNER_REMINDERS_UPDATE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner reminders: action=create\|update\|delete\|complete\|skip\|snooze\|review |
| `OWNER_ROUTINES` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner routines: action=create\|update\|delete\|complete\|skip\|snooze\|review\|schedul… |
| `OWNER_ROUTINES_COMPLETE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner routines: action=create\|update\|delete\|complete\|skip\|snooze\|review\|schedul… |
| `OWNER_ROUTINES_CREATE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner routines: action=create\|update\|delete\|complete\|skip\|snooze\|review\|schedul… |
| `OWNER_ROUTINES_DELETE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner routines: action=create\|update\|delete\|complete\|skip\|snooze\|review\|schedul… |
| `OWNER_ROUTINES_REVIEW` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner routines: action=create\|update\|delete\|complete\|skip\|snooze\|review\|schedul… |
| `OWNER_ROUTINES_SCHEDULE_INSPECT` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner routines: action=create\|update\|delete\|complete\|skip\|snooze\|review\|schedul… |
| `OWNER_ROUTINES_SCHEDULE_SUMMARY` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner routines: action=create\|update\|delete\|complete\|skip\|snooze\|review\|schedul… |
| `OWNER_ROUTINES_SKIP` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner routines: action=create\|update\|delete\|complete\|skip\|snooze\|review\|schedul… |
| `OWNER_ROUTINES_SNOOZE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner routines: action=create\|update\|delete\|complete\|skip\|snooze\|review\|schedul… |
| `OWNER_ROUTINES_UPDATE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner routines: action=create\|update\|delete\|complete\|skip\|snooze\|review\|schedul… |
| `OWNER_TODOS` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner todos: action=create\|update\|delete\|complete\|skip\|snooze\|review |
| `OWNER_TODOS_COMPLETE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner todos: action=create\|update\|delete\|complete\|skip\|snooze\|review |
| `OWNER_TODOS_CREATE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner todos: action=create\|update\|delete\|complete\|skip\|snooze\|review |
| `OWNER_TODOS_DELETE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner todos: action=create\|update\|delete\|complete\|skip\|snooze\|review |
| `OWNER_TODOS_REVIEW` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner todos: action=create\|update\|delete\|complete\|skip\|snooze\|review |
| `OWNER_TODOS_SKIP` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner todos: action=create\|update\|delete\|complete\|skip\|snooze\|review |
| `OWNER_TODOS_SNOOZE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner todos: action=create\|update\|delete\|complete\|skip\|snooze\|review |
| `OWNER_TODOS_UPDATE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | owner todos: action=create\|update\|delete\|complete\|skip\|snooze\|review |
| `SCHEDULED_TASKS` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|acknowledge\|dismis… |
| `SCHEDULED_TASKS_ACKNOWLEDGE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|acknowledge\|dismis… |
| `SCHEDULED_TASKS_CANCEL` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|acknowledge\|dismis… |
| `SCHEDULED_TASKS_COMPLETE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|acknowledge\|dismis… |
| `SCHEDULED_TASKS_CREATE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|acknowledge\|dismis… |
| `SCHEDULED_TASKS_DISMISS` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|acknowledge\|dismis… |
| `SCHEDULED_TASKS_GET` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|acknowledge\|dismis… |
| `SCHEDULED_TASKS_HISTORY` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|acknowledge\|dismis… |
| `SCHEDULED_TASKS_LIST` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|acknowledge\|dismis… |
| `SCHEDULED_TASKS_REOPEN` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|acknowledge\|dismis… |
| `SCHEDULED_TASKS_SKIP` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|acknowledge\|dismis… |
| `SCHEDULED_TASKS_SNOOZE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|acknowledge\|dismis… |
| `SCHEDULED_TASKS_UPDATE` | @elizaos/app-lifeops | — | read, write, update, delete, schedule | internal | scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|acknowledge\|dismis… |
| `TODO` | @elizaos/plugin-todos | — | read, write, update, delete | internal | todos: write\|create\|update\|complete\|cancel\|delete\|list\|clear; user-scoped (enti… |
