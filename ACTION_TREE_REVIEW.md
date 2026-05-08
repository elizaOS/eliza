# Action Tree Review

Generated: 2026-05-08T06:33:00.698Z

## Summary

- Files scanned: 6143
- Actions scanned: 202
- Static sub-action parents: 4
- Duplicate action-name groups: 6
- Blocking duplicate action-name groups: 5
- Dynamic action factories / unresolved names: 14
- Sub-action visibility findings: 4
- Redundancy/uselessness heuristic findings: 3

## Direct Answers

- Context explosion: selected contexts are rendered through the v5 context object. Statically declared sub-action roots are `CALENDAR`, `CODE`, `RESEARCH`, `TODO`, and each child shares at least one parent context or context gate, so selecting the parent context exposes the parent and children before runtime role gates.
- Duplicate actions: 5 blocking same-runtime duplicate group(s) remain. Accepted low-risk cloud/local mirrors are still listed for parity tracking.
- Useless/redundant actions: no action is proven useless from static inspection alone, but the heuristic list flags placeholder wording, unstructured outputs, and redundant mirrors that should be reviewed before calling the action surface 100%.

## Runtime Behavior Notes

- `createV5MessageContextObject` appends selected context tools into the context object's event stream and trajectory prefix.
- `renderContextObject` displays selected contexts, expanded tools, and tool events; `collectPlannerTools` then converts those appended action events into native planner tools.
- `runSubPlanner` scopes a parent action's declared `subActions` when the parent itself is called. Static cycle detection protects recursive sub-action trees; normal iteration/token/time limits still apply.
- Duplicate action names are not merged by the runtime. `registerPlugin` and `registerAction` skip later duplicates, so duplicate names can hide tools from the planner depending on registration order.

## 100% Cleanup Checklist

1. Resolve blocking duplicate groups: `MESSAGE`, `CONTACT`, `SCHEDULE`, `STREAM`, `TODO`.
2. Fix the heuristic action-quality list: placeholder/deprecated wording should become real action descriptions; unstructured result actions should return `ActionResult` with `success`, `text`, and structured `data`.
3. Fix sub-action visibility findings so each child can be exposed when its parent context is selected.

## Main Findings

### Duplicate Action Names

| severity | name | count | classification | recommendation | locations |
| --- | --- | --- | --- | --- | --- |
| medium | MESSAGE | 10 | duplicate action name | Review registration order; duplicate action names are skipped after the first registration. | [packages/core/src/features/advanced-capabilities/actions/message.ts:2738](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/actions/message.ts:2738)<br>[packages/core/src/features/messaging/triage/actions/draftFollowup.ts:19](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/messaging/triage/actions/draftFollowup.ts:19)<br>[packages/core/src/features/messaging/triage/actions/draftReply.ts:35](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/messaging/triage/actions/draftReply.ts:35)<br>[packages/core/src/features/messaging/triage/actions/listInbox.ts:17](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/messaging/triage/actions/listInbox.ts:17)<br>[packages/core/src/features/messaging/triage/actions/manageMessage.ts:35](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/messaging/triage/actions/manageMessage.ts:35)<br>[packages/core/src/features/messaging/triage/actions/respondToMessage.ts:63](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/messaging/triage/actions/respondToMessage.ts:63)<br>[packages/core/src/features/messaging/triage/actions/scheduleDraftSend.ts:19](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/messaging/triage/actions/scheduleDraftSend.ts:19)<br>[packages/core/src/features/messaging/triage/actions/searchMessages.ts:16](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/messaging/triage/actions/searchMessages.ts:16)<br>[packages/core/src/features/messaging/triage/actions/sendDraft.ts:204](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/messaging/triage/actions/sendDraft.ts:204)<br>[packages/core/src/features/messaging/triage/actions/triageMessages.ts:21](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/messaging/triage/actions/triageMessages.ts:21) |
| medium | CONTACT | 2 | duplicate action name | Review registration order; duplicate action names are skipped after the first registration. | [packages/agent/src/actions/contact.ts:1671](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/contact.ts:1671)<br>[packages/core/src/features/advanced-capabilities/actions/contact.ts:932](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/actions/contact.ts:932) |
| low | MCP | 2 | cloud/local mirror | Confirm deployment isolation and keep contract parity. | [cloud/packages/lib/eliza/plugin-mcp/actions/mcp.ts:488](/Users/shawwalters/eliza-workspace/milady/eliza/cloud/packages/lib/eliza/plugin-mcp/actions/mcp.ts:488)<br>[plugins/plugin-mcp/src/actions/mcp.ts:364](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-mcp/src/actions/mcp.ts:364) |
| medium | SCHEDULE | 2 | duplicate action name | Review registration order; duplicate action names are skipped after the first registration. | [packages/agent/src/actions/schedule.ts:848](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/schedule.ts:848)<br>[plugins/app-lifeops/src/actions/schedule.ts:132](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/schedule.ts:132) |
| medium | STREAM | 2 | duplicate action name | Review registration order; duplicate action names are skipped after the first registration. | [packages/agent/src/actions/stream-control.ts:123](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/stream-control.ts:123)<br>[plugins/plugin-streaming/src/core.ts:551](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-streaming/src/core.ts:551) |
| medium | TODO | 2 | duplicate action name | Review registration order; duplicate action names are skipped after the first registration. | [packages/core/src/features/advanced-capabilities/todos/actions/todo.ts:10](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/todos/actions/todo.ts:10)<br>[plugins/plugin-todos/src/actions/todo.ts:418](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-todos/src/actions/todo.ts:418) |

### Dynamic Action Factories

These are intentionally not treated as duplicate names because the static expression is not the final runtime name.

| expression | source | contexts | location |
| --- | --- | --- | --- |
| actionName | cloud:plugin-mcp | connectors, automation, documents | [cloud/packages/lib/eliza/plugin-mcp/actions/dynamic-tool-actions.ts:91](/Users/shawwalters/eliza-workspace/milady/eliza/cloud/packages/lib/eliza/plugin-mcp/actions/dynamic-tool-actions.ts:91) |
| CalendlyActions.CALENDLY_OP | plugin:plugin-calendly | calendar, automation, connectors | [plugins/plugin-calendly/src/actions/calendly-op.ts:306](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-calendly/src/actions/calendly-op.ts:306) |
| config.name | agent | general, ...config.contexts | [packages/agent/src/actions/page-action-groups.ts:122](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/page-action-groups.ts:122) |
| def.name | agent | general, automation, connectors, agent_internal | [packages/agent/src/runtime/custom-actions.ts:613](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/runtime/custom-actions.ts:613) |
| definition.name | plugin:app-2004scape | game, automation, world, state | [plugins/app-2004scape/src/actions/routers.ts:181](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-2004scape/src/actions/routers.ts:181) |
| GitHubActions.GITHUB_ISSUE_OP | plugin:plugin-github | code, tasks, connectors, automation | [plugins/plugin-github/src/actions/issue-op.ts:292](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-github/src/actions/issue-op.ts:292) |
| GitHubActions.GITHUB_NOTIFICATION_TRIAGE | plugin:plugin-github | code, tasks, connectors, automation | [plugins/plugin-github/src/actions/notification-triage.ts:86](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-github/src/actions/notification-triage.ts:86) |
| GitHubActions.GITHUB_PR_OP | plugin:plugin-github | code, tasks, connectors, automation | [plugins/plugin-github/src/actions/pr-op.ts:208](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-github/src/actions/pr-op.ts:208) |
| spec.name | core | media, files | [packages/core/src/features/advanced-capabilities/actions/generateMedia.ts:373](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/actions/generateMedia.ts:373) |
| spec.name | core | - | [packages/core/src/features/advanced-capabilities/evaluators/reflection.ts:897](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/evaluators/reflection.ts:897) |
| spec.name | core | - | [packages/core/src/features/advanced-capabilities/evaluators/relationshipExtraction.ts:170](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/evaluators/relationshipExtraction.ts:170) |
| spec.name | plugin:plugin-wallet | finance, crypto, wallet, payments | [plugins/plugin-wallet/src/chains/evm/actions/bridge.ts:528](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-wallet/src/chains/evm/actions/bridge.ts:528) |
| spec.name | plugin:plugin-wallet | finance, crypto, wallet | [plugins/plugin-wallet/src/chains/evm/actions/swap.ts:675](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-wallet/src/chains/evm/actions/swap.ts:675) |
| spec.name | plugin:plugin-wallet | finance, crypto, wallet, payments | [plugins/plugin-wallet/src/chains/evm/actions/transfer.ts:131](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-wallet/src/chains/evm/actions/transfer.ts:131) |

### Sub-Action Visibility

| severity | parent | child | issue | parent source |
| --- | --- | --- | --- | --- |
| high | CODE | CREATE_WORKSPACE | sub-action reference does not resolve to a scanned action | [packages/agent/src/actions/code-umbrella.ts:34](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/code-umbrella.ts:34) |
| high | CODE | SUBMIT_WORKSPACE | sub-action reference does not resolve to a scanned action | [packages/agent/src/actions/code-umbrella.ts:34](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/code-umbrella.ts:34) |
| high | CODE | ARCHIVE_CODING_TASK | sub-action reference does not resolve to a scanned action | [packages/agent/src/actions/code-umbrella.ts:34](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/code-umbrella.ts:34) |
| high | CODE | REOPEN_CODING_TASK | sub-action reference does not resolve to a scanned action | [packages/agent/src/actions/code-umbrella.ts:34](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/code-umbrella.ts:34) |

### Redundant / Useless Heuristics

| action | issue | location |
| --- | --- | --- |
| BROWSER | placeholder/deprecated wording | [plugins/plugin-browser/src/actions/browser.ts:231](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-browser/src/actions/browser.ts:231) |
| MESSAGE | thin description | [packages/core/src/features/advanced-capabilities/actions/message.ts:2738](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/actions/message.ts:2738) |
| POST | thin description | [packages/core/src/features/advanced-capabilities/actions/post.ts:579](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/actions/post.ts:579) |

## Static Action Trees

- CODE (agent; code, files, tasks, automation, agent_internal; subPlanner)
  - CREATE_WORKSPACE (missing)
  - SUBMIT_WORKSPACE (missing)
  - ARCHIVE_CODING_TASK (missing)
  - REOPEN_CODING_TASK (missing)

- TODO (core; todos, agent_internal; subPlanner)
  - CREATE_TODO (core; todos, agent_internal; no subPlanner)
  - COMPLETE_TODO (core; todos, agent_internal; no subPlanner)
  - LIST_TODOS (core; todos, agent_internal; no subPlanner)
  - EDIT_TODO (core; todos, agent_internal; no subPlanner)
  - DELETE_TODO (core; todos, agent_internal; no subPlanner)

- RESEARCH (core; research, agent_internal; subPlanner)
  - CREATE_RESEARCH (core; research, agent_internal; no subPlanner)
  - CONTINUE_RESEARCH (core; research, agent_internal; no subPlanner)
  - READ_RESEARCH (core; research, agent_internal; no subPlanner)
  - LIST_RESEARCH (core; research, agent_internal; no subPlanner)
  - EDIT_RESEARCH (core; research, agent_internal; no subPlanner)
  - DELETE_RESEARCH (core; research, agent_internal; no subPlanner)

- CALENDAR (plugin:app-lifeops; calendar, contacts, tasks, connectors, web; subPlanner)
  - GOOGLE_CALENDAR (plugin:app-lifeops; calendar, contacts, tasks; no subPlanner)
  - PROPOSE_MEETING_TIMES (plugin:app-lifeops; calendar, contacts, tasks; no subPlanner)
  - CHECK_AVAILABILITY (plugin:app-lifeops; calendar, contacts, tasks; no subPlanner)
  - UPDATE_MEETING_PREFERENCES (plugin:app-lifeops; calendar, contacts, tasks, settings; no subPlanner)
  - CALENDLY (plugin:app-lifeops; calendar, contacts, tasks; no subPlanner)
  - SCHEDULING (plugin:app-lifeops; calendar, contacts, tasks, messaging; no subPlanner)

## Context Explosion Preview

This is the static approximation of what a selected context can expose before runtime role gates and validation checks.

<details><summary>admin (22 actions)</summary>

CHARACTER, CHOOSE_OPTION, COMPUTER_USE, DATABASE, EVALUATE_TRUST, LOGS, MANAGE_PLUGINS, PLUGIN, QUERY_TRAJECTORIES, RECORD_TRUST_INTERACTION, REMOTE_DESKTOP, REQUEST_ELEVATION, RESOLVE_REQUEST, ROLE, RUNTIME, SEARCH, SEND_TO_ADMIN, SETTINGS, SHELL_COMMAND, SKILL_COMMAND, TAILSCALE, TRUST_UPDATE_ROLE

</details>

<details><summary>agent_internal (34 actions)</summary>

AGENT_INBOX, CHARACTER, CODE, COMPLETE_TODO, CONTINUE_RESEARCH, CREATE_PLAN, CREATE_RESEARCH, CREATE_TODO, DATABASE, DELETE_RESEARCH, DELETE_TODO, EDIT_RESEARCH, EDIT_TODO, EVALUATE_TRUST, FINISH, LIST_RESEARCH, LIST_TODOS, LOGS, MEMORY, QUERY_TRAJECTORIES, READ_RESEARCH, RECORD_TRUST_INTERACTION, REQUEST_ELEVATION, RESEARCH, RUNTIME, SCHEDULE, SEARCH_EXPERIENCES, SEND_TO_ADMIN, SETTINGS, SKILL_COMMAND, TASKS, TODO, WORKFLOW, def.name

</details>

<details><summary>automation (88 actions)</summary>

ALARM, APP, APP_BLOCK, ASK_USER_QUESTION, AUTOFILL, BASH, BLOCK_UNTIL_TASK_COMPLETE, BROWSER, CLEAR_LINEAR_ACTIVITY, CODE, COMPUTER_USE, CREATE_LINEAR_COMMENT, CREATE_LINEAR_ISSUE, CREATE_PLAN, CalendlyActions.CALENDLY_OP, DELETE_LINEAR_COMMENT, DELETE_LINEAR_ISSUE, DESKTOP, EDIT, ENTER_WORKTREE, EXECUTE_CODE, EXECUTE_ROBLOX_ACTION, EXIT_WORKTREE, FORM_RESTORE, GET_LINEAR_ACTIVITY, GET_SKILL_DETAILS, GLOB, GREP, GitHubActions.GITHUB_ISSUE_OP, GitHubActions.GITHUB_NOTIFICATION_TRIAGE, GitHubActions.GITHUB_PR_OP, INSTALL_SKILL, LINEAR, LINEAR_COMMENT, LINEAR_ISSUE, LINEAR_WORKFLOW, LIST_ACTIVE_BLOCKS, LIST_LINEAR_COMMENTS, LS, MANAGE_LP_POSITIONS, MANAGE_ROUTING, MANAGE_ZONES, MCP, MC_ATTACK, MC_BLOCK, MC_CHAT, MC_CONNECT, MC_DISCONNECT, MC_LOCOMOTE, MC_WAYPOINT, MESSAGE, MUSIC_LIBRARY, PASSWORD_MANAGER, PLAYBACK, PLAY_AUDIO, READ, RELEASE_BLOCK, REMOTE_DESKTOP, RESOLVE_REQUEST, ROBLOX_ACTION, RS_2004_WALK_TO, SCAPE, SCHEDULE, SEARCH_SHOPIFY_STORE, SEARCH_SKILLS, SHOPIFY, SKILL_COMMAND, STREAM, SUBSCRIPTIONS, SYNC_SKILL_CATALOG, TASKS, TODO, TOGGLE_FEATURE, TOGGLE_SKILL, UNINSTALL_SKILL, UPDATE_LINEAR_COMMENT, UPDATE_LINEAR_ISSUE, USE_SKILL, VISION, VOICE_CALL, WEBSITE_BLOCK, WEB_FETCH, WORKFLOW, WRITE, actionName, def.name, definition.name, lp_management

</details>

<details><summary>browser (18 actions)</summary>

AUTOFILL, BLOCK_UNTIL_TASK_COMPLETE, BOOK_TRAVEL, BROWSER, BROWSER_AUTOFILL_LOGIN, COMPUTER_USE, CONNECTOR, DESKTOP, EXTRACT_PAGE, LIST_ACTIVE_BLOCKS, MANAGE_BROWSER_BRIDGE, PASSWORD_MANAGER, RELEASE_BLOCK, REMOTE_DESKTOP, SCREEN_TIME, SEARCH, SUBSCRIPTIONS, WEBSITE_BLOCK

</details>

<details><summary>calendar (21 actions)</summary>

ALARM, BOOK_TRAVEL, CALENDAR, CALENDLY, CHECK_AVAILABILITY, CONNECTOR, CalendlyActions.CALENDLY_OP, GOOGLE_CALENDAR, HEALTH, LIFE, LIST_OVERDUE_FOLLOWUPS, MARK_FOLLOWUP_DONE, MESSAGE, PROFILE, PROPOSE_MEETING_TIMES, RELATIONSHIP, RESOLVE_REQUEST, SCHEDULE, SCHEDULING, SET_FOLLOWUP_THRESHOLD, UPDATE_MEETING_PREFERENCES

</details>

<details><summary>code (24 actions)</summary>

APP, ASK_USER_QUESTION, BASH, CODE, CREATE_PLAN, DESKTOP, EDIT, ENTER_WORKTREE, EXECUTE_CODE, EXIT_WORKTREE, GLOB, GREP, GitHubActions.GITHUB_ISSUE_OP, GitHubActions.GITHUB_NOTIFICATION_TRIAGE, GitHubActions.GITHUB_PR_OP, LS, PLUGIN, READ, SCHEDULE, SHELL_COMMAND, TASKS, TODO, WEB_FETCH, WRITE

</details>

<details><summary>connectors (48 actions)</summary>

AGENT_INBOX, CALENDAR, CLEAR_LINEAR_ACTIVITY, CONNECTOR, CREATE_LINEAR_COMMENT, CREATE_LINEAR_ISSUE, CalendlyActions.CALENDLY_OP, DELETE_LINEAR_COMMENT, DELETE_LINEAR_ISSUE, DISCORD_CREATE_POLL, DISCORD_MEDIA, DISCORD_SETUP_CREDENTIALS, DISCORD_SUMMARIZE_CONVERSATION, GET_LINEAR_ACTIVITY, GET_LINEAR_ISSUE, GitHubActions.GITHUB_ISSUE_OP, GitHubActions.GITHUB_NOTIFICATION_TRIAGE, GitHubActions.GITHUB_PR_OP, INSTALL_SKILL, LIST_LINEAR_COMMENTS, MANAGE_BROWSER_BRIDGE, MANAGE_PLUGINS, MANAGE_SECRET, MCP, MC_CONNECT, MC_DISCONNECT, MESSAGE, NOSTR_PUBLISH_PROFILE, OAUTH, PLUGIN, POST, REQUEST_SECRET, RUNTIME, SEARCH_LINEAR_ISSUES, SEARCH_SHOPIFY_STORE, SECRETS_UPDATE_SETTINGS, SET_SECRET, SHOPIFY, STREAM, SYNC_SKILL_CATALOG, TAILSCALE, TASKS, TOGGLE_FEATURE, UPDATE_LINEAR_COMMENT, UPDATE_LINEAR_ISSUE, USE_SKILL, actionName, def.name

</details>

<details><summary>contacts (22 actions)</summary>

BOOK_TRAVEL, CALENDAR, CALENDLY, CHECK_AVAILABILITY, CONNECTOR, CONTACT, GOOGLE_CALENDAR, LIST_OVERDUE_FOLLOWUPS, MARK_FOLLOWUP_DONE, MESSAGE, PLACE_CALL, PROFILE, PROPOSE_MEETING_TIMES, RELATIONSHIP, RESOLVE_REQUEST, ROOM_OP, SCHEDULE, SCHEDULING, SET_FOLLOWUP_THRESHOLD, UPDATE_MEETING_PREFERENCES, VOICE_CALL, X

</details>

<details><summary>crypto (10 actions)</summary>

MANAGE_LP_POSITIONS, PAYMENTS, PREDICTION_MARKET, TOKEN_INFO, WALLET, WEB_SEARCH, lp_management, manage_positions, manage_raydium_positions, spec.name

</details>

<details><summary>documents (13 actions)</summary>

CONTACT, DATABASE, DOCUMENT, EXTRACT_PAGE, MCP, MEMORY, MESSAGE, QUERY_TRAJECTORIES, READ_ATTACHMENT, SEARCH, SEARCH_EXPERIENCES, WEB_SEARCH, actionName

</details>

<details><summary>email (4 actions)</summary>

AGENT_INBOX, CONNECTOR, MESSAGE, RESOLVE_REQUEST

</details>

<details><summary>files (12 actions)</summary>

ANALYZE_IMAGE, CODE, COMPUTER_USE, DESKTOP, GENERATE_MEDIA, MANAGE_BROWSER_BRIDGE, MCP, MUSIC_LIBRARY, PLUGIN, READ_ATTACHMENT, SHELL_COMMAND, spec.name

</details>

<details><summary>finance (13 actions)</summary>

BOOK_TRAVEL, MANAGE_LP_POSITIONS, PAYMENT, PAYMENTS, PREDICTION_MARKET, SUBSCRIPTIONS, TOKEN_INFO, WALLET, WEB_SEARCH, lp_management, manage_positions, manage_raydium_positions, spec.name

</details>

<details><summary>game (3 actions)</summary>

RS_2004_WALK_TO, SCAPE, definition.name

</details>

<details><summary>general (20 actions)</summary>

ANALYZE_IMAGE, CHOOSE_OPTION, FINISH, GENERATE_MEDIA, IGNORE, LINEAR, LINEAR_COMMENT, LINEAR_ISSUE, LINEAR_WORKFLOW, MCP, NONE, PLAY_EMOTE, READING, REPLY, RESOLVE_REQUEST, RUNTIME, SEARCH, STREAM, config.name, def.name

</details>

<details><summary>health (5 actions)</summary>

CONNECTOR, HEALTH, LIFE, SCHEDULE, SCREEN_TIME

</details>

<details><summary>knowledge (14 actions)</summary>

DISCORD_SUMMARIZE_CONVERSATION, GET_LINEAR_ISSUE, GET_SKILL_DETAILS, LINEAR, LINEAR_ISSUE, LINEAR_WORKFLOW, MCP, MUSIC_LIBRARY, READING, SEARCH_LINEAR_ISSUES, SEARCH_SHOPIFY_STORE, SEARCH_SKILLS, SHOPIFY, USE_SKILL

</details>

<details><summary>linear (1 actions)</summary>

LINEAR

</details>

<details><summary>linear_comment (1 actions)</summary>

LINEAR_COMMENT

</details>

<details><summary>linear_issue (1 actions)</summary>

LINEAR_ISSUE

</details>

<details><summary>linear_workflow (1 actions)</summary>

LINEAR_WORKFLOW

</details>

<details><summary>mcp (1 actions)</summary>

MCP

</details>

<details><summary>media (25 actions)</summary>

ANALYZE_IMAGE, CHARACTER, DISCORD_MEDIA, EXECUTE_ROBLOX_ACTION, GENERATE_MEDIA, MANAGE_ROUTING, MANAGE_ZONES, MC_ATTACK, MC_BLOCK, MC_CHAT, MC_CONNECT, MC_DISCONNECT, MC_LOCOMOTE, MC_WAYPOINT, MUSIC_GENERATION, MUSIC_LIBRARY, PLAYBACK, PLAY_AUDIO, PLAY_EMOTE, READ_ATTACHMENT, ROBLOX_ACTION, SEND_ROBLOX_MESSAGE, STREAM, VISION, spec.name

</details>

<details><summary>memory (9 actions)</summary>

CONTACT, DATABASE, FORM_RESTORE, MC_WAYPOINT, MEMORY, PROFILE, RELATIONSHIP, SEARCH_EXPERIENCES, VISION

</details>

<details><summary>messaging (23 actions)</summary>

AGENT_INBOX, CONNECTOR, CONTACT, DISCORD_CREATE_POLL, DISCORD_MEDIA, DISCORD_SETUP_CREDENTIALS, DISCORD_SUMMARIZE_CONVERSATION, LIST_OVERDUE_FOLLOWUPS, MARK_FOLLOWUP_DONE, MC_CHAT, MESSAGE, PLACE_CALL, READ_ATTACHMENT, RELATIONSHIP, REPLY, RESOLVE_REQUEST, ROOM_OP, SCAPE, SCHEDULING, SEND_ROBLOX_MESSAGE, SEND_TO_ADMIN, VOICE_CALL, X

</details>

<details><summary>payments (9 actions)</summary>

BOOK_TRAVEL, PAYMENT, PAYMENTS, PREDICTION_MARKET, RESOLVE_REQUEST, SEARCH_SHOPIFY_STORE, SHOPIFY, SUBSCRIPTIONS, spec.name

</details>

<details><summary>phone (2 actions)</summary>

PLACE_CALL, VOICE_CALL

</details>

<details><summary>prediction-market (1 actions)</summary>

PREDICTION_MARKET

</details>

<details><summary>research (7 actions)</summary>

CONTINUE_RESEARCH, CREATE_RESEARCH, DELETE_RESEARCH, EDIT_RESEARCH, LIST_RESEARCH, READ_RESEARCH, RESEARCH

</details>

<details><summary>screen_time (10 actions)</summary>

APP_BLOCK, BLOCK_UNTIL_TASK_COMPLETE, COMPUTER_USE, DESKTOP, LIST_ACTIVE_BLOCKS, RELEASE_BLOCK, SCHEDULE, SCREEN_TIME, VISION, WEBSITE_BLOCK

</details>

<details><summary>secrets (9 actions)</summary>

AUTOFILL, BROWSER_AUTOFILL_LOGIN, MANAGE_SECRET, OAUTH, PASSWORD_MANAGER, PLUGIN, REQUEST_SECRET, SECRETS_UPDATE_SETTINGS, SET_SECRET

</details>

<details><summary>settings (42 actions)</summary>

APP, APP_BLOCK, AUTOFILL, CHARACTER, CLEAR_SHELL_HISTORY, CONNECTOR, DISCORD_SETUP_CREDENTIALS, EVALUATE_TRUST, GET_SKILL_DETAILS, INSTALL_SKILL, LOGS, MANAGE_BROWSER_BRIDGE, MANAGE_PLUGINS, MANAGE_ROUTING, MANAGE_SECRET, MANAGE_ZONES, MCP, OAUTH, PLUGIN, PROFILE, RECORD_TRUST_INTERACTION, REMOTE_DESKTOP, REQUEST_ELEVATION, REQUEST_SECRET, ROLE, ROOM_OP, RUNTIME, SEARCH_SKILLS, SECRETS_UPDATE_SETTINGS, SETTINGS, SET_FOLLOWUP_THRESHOLD, SET_SECRET, STREAM, SYNC_SKILL_CATALOG, TAILSCALE, TOGGLE_FEATURE, TOGGLE_SKILL, TRUST_UPDATE_ROLE, UNINSTALL_SKILL, UPDATE_MEETING_PREFERENCES, VISION, WEBSITE_BLOCK

</details>

<details><summary>social_posting (4 actions)</summary>

NOSTR_PUBLISH_PROFILE, POST, SEARCH, X

</details>

<details><summary>state (3 actions)</summary>

RS_2004_WALK_TO, SCAPE, definition.name

</details>

<details><summary>subscriptions (2 actions)</summary>

PAYMENTS, SUBSCRIPTIONS

</details>

<details><summary>task (1 actions)</summary>

TODO

</details>

<details><summary>tasks (46 actions)</summary>

ALARM, APP_BLOCK, BLOCK_UNTIL_TASK_COMPLETE, BOOK_TRAVEL, CALENDAR, CALENDLY, CHECK_AVAILABILITY, CHOOSE_OPTION, CLEAR_LINEAR_ACTIVITY, CODE, CREATE_LINEAR_COMMENT, CREATE_LINEAR_ISSUE, CREATE_PLAN, DELETE_LINEAR_COMMENT, DELETE_LINEAR_ISSUE, FORM_RESTORE, GET_LINEAR_ACTIVITY, GET_LINEAR_ISSUE, GOOGLE_CALENDAR, GitHubActions.GITHUB_ISSUE_OP, GitHubActions.GITHUB_NOTIFICATION_TRIAGE, GitHubActions.GITHUB_PR_OP, HEALTH, LIFE, LIST_ACTIVE_BLOCKS, LIST_LINEAR_COMMENTS, LIST_OVERDUE_FOLLOWUPS, MARK_FOLLOWUP_DONE, MESSAGE, PROFILE, PROPOSE_MEETING_TIMES, RELATIONSHIP, RELEASE_BLOCK, RESOLVE_REQUEST, SCHEDULE, SCHEDULING, SCREEN_TIME, SEARCH_LINEAR_ISSUES, SET_FOLLOWUP_THRESHOLD, TASKS, UPDATE_LINEAR_COMMENT, UPDATE_LINEAR_ISSUE, UPDATE_MEETING_PREFERENCES, VOICE_CALL, WEBSITE_BLOCK, WORKFLOW

</details>

<details><summary>terminal (17 actions)</summary>

ASK_USER_QUESTION, BASH, CLEAR_SHELL_HISTORY, COMPUTER_USE, DESKTOP, EDIT, ENTER_WORKTREE, EXECUTE_CODE, EXIT_WORKTREE, GLOB, GREP, LS, READ, REMOTE_DESKTOP, SHELL_COMMAND, WEB_FETCH, WRITE

</details>

<details><summary>todos (6 actions)</summary>

COMPLETE_TODO, CREATE_TODO, DELETE_TODO, EDIT_TODO, LIST_TODOS, TODO

</details>

<details><summary>wallet (9 actions)</summary>

MANAGE_LP_POSITIONS, PAYMENTS, RUNTIME, TOKEN_INFO, WALLET, lp_management, manage_positions, manage_raydium_positions, spec.name

</details>

<details><summary>web (7 actions)</summary>

BROWSER, BROWSER_AUTOFILL_LOGIN, CALENDAR, EXTRACT_PAGE, MUSIC_LIBRARY, WEB_SEARCH, X

</details>

<details><summary>world (3 actions)</summary>

RS_2004_WALK_TO, SCAPE, definition.name

</details>

## All Sub-Action Parents

| parent | source | contexts | subPlanner | children | location |
| --- | --- | --- | --- | --- | --- |
| CALENDAR | plugin:app-lifeops | calendar, contacts, tasks, connectors, web | yes | GOOGLE_CALENDAR, PROPOSE_MEETING_TIMES, CHECK_AVAILABILITY, UPDATE_MEETING_PREFERENCES, CALENDLY, SCHEDULING | [plugins/app-lifeops/src/actions/calendar.ts:660](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/calendar.ts:660) |
| CODE | agent | code, files, tasks, automation, agent_internal | yes | CREATE_WORKSPACE (missing), SUBMIT_WORKSPACE (missing), ARCHIVE_CODING_TASK (missing), REOPEN_CODING_TASK (missing) | [packages/agent/src/actions/code-umbrella.ts:34](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/code-umbrella.ts:34) |
| RESEARCH | core | research, agent_internal | yes | CREATE_RESEARCH, CONTINUE_RESEARCH, READ_RESEARCH, LIST_RESEARCH, EDIT_RESEARCH, DELETE_RESEARCH | [packages/core/src/features/research/actions/research.ts:10](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/research/actions/research.ts:10) |
| TODO | core | todos, agent_internal | yes | CREATE_TODO, COMPLETE_TODO, LIST_TODOS, EDIT_TODO, DELETE_TODO | [packages/core/src/features/advanced-capabilities/todos/actions/todo.ts:10](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/todos/actions/todo.ts:10) |

## All Actions

| name | source | contexts | role gate | validation | result shape | sub-actions | location |
| --- | --- | --- | --- | --- | --- | --- | --- |
| actionName | cloud:plugin-mcp | connectors, automation, documents | { minRole: "ADMIN" } | always_true | success, text, data, values, error, delegated, callback | - | [cloud/packages/lib/eliza/plugin-mcp/actions/dynamic-tool-actions.ts:91](/Users/shawwalters/eliza-workspace/milady/eliza/cloud/packages/lib/eliza/plugin-mcp/actions/dynamic-tool-actions.ts:91) |
| AGENT_INBOX | agent | messaging, email, connectors, agent_internal | { minRole: "OWNER" } | always_true | delegated | - | [packages/agent/src/actions/agent-inbox.ts:59](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/agent-inbox.ts:59) |
| ALARM | package:native-plugins | tasks, calendar, automation | { minRole: "ADMIN" } | conditional | success, text, data, values, error, delegated, callback | - | [packages/native-plugins/macosalarm/src/actions.ts:387](/Users/shawwalters/eliza-workspace/milady/eliza/packages/native-plugins/macosalarm/src/actions.ts:387) |
| ANALYZE_IMAGE | agent | general, media, files | { minRole: "USER" } | conditional | success, text, data, delegated | - | [packages/agent/src/actions/media.ts:108](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/media.ts:108) |
| APP | plugin:plugin-app-control | automation, settings, code | { minRole: "USER" } | always_true | success, text, delegated | - | [plugins/plugin-app-control/src/actions/app.ts:150](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-app-control/src/actions/app.ts:150) |
| APP_BLOCK | plugin:app-lifeops | screen_time, automation, settings, tasks | { minRole: "OWNER" } | conditional | success, text, data, delegated | - | [plugins/app-lifeops/src/actions/app-block.ts:460](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/app-block.ts:460) |
| ASK_USER_QUESTION | plugin:plugin-coding-tools | code, terminal, automation | { minRole: "ADMIN" } | always_true | delegated, callback | - | [plugins/plugin-coding-tools/src/actions/ask-user-question.ts:120](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-coding-tools/src/actions/ask-user-question.ts:120) |
| AUTOFILL | plugin:app-lifeops | browser, secrets, settings, automation | { minRole: "OWNER" } | always_true | success, text, data, delegated | - | [plugins/app-lifeops/src/actions/autofill.ts:405](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/autofill.ts:405) |
| BASH | plugin:plugin-coding-tools | code, terminal, automation | - | always_true | delegated, callback | - | [plugins/plugin-coding-tools/src/actions/bash.ts:114](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-coding-tools/src/actions/bash.ts:114) |
| BLOCK_UNTIL_TASK_COMPLETE | plugin:app-lifeops | screen_time, browser, tasks, automation | { minRole: "OWNER" } | conditional | success, text, data, delegated | - | [plugins/app-lifeops/src/website-blocker/chat-integration/actions/blockUntilTaskComplete.ts:149](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/website-blocker/chat-integration/actions/blockUntilTaskComplete.ts:149) |
| BOOK_TRAVEL | plugin:app-lifeops | calendar, contacts, tasks, payments, finance, browser | { minRole: "OWNER" } | always_true | success, data, values, error, delegated, callback | - | [plugins/app-lifeops/src/actions/book-travel.ts:331](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/book-travel.ts:331) |
| BROWSER | plugin:plugin-browser | browser, web, automation | { minRole: "OWNER" } | always_true | success, text, data, values, error, delegated | - | [plugins/plugin-browser/src/actions/browser.ts:231](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-browser/src/actions/browser.ts:231) |
| BROWSER_AUTOFILL_LOGIN | plugin:plugin-browser | browser, web, secrets | { minRole: "OWNER" } | always_true | success, text, data, values, error, delegated | - | [plugins/plugin-browser/src/actions/browser-autofill-login.ts:143](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-browser/src/actions/browser-autofill-login.ts:143) |
| CALENDAR | plugin:app-lifeops | calendar, contacts, tasks, connectors, web | { minRole: "OWNER" } | conditional | success, data, error, delegated | GOOGLE_CALENDAR, PROPOSE_MEETING_TIMES, CHECK_AVAILABILITY, UPDATE_MEETING_PREFERENCES, CALENDLY, SCHEDULING | [plugins/app-lifeops/src/actions/calendar.ts:660](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/calendar.ts:660) |
| CALENDLY | plugin:app-lifeops | calendar, contacts, tasks | { minRole: "OWNER" } | conditional | error, delegated | - | [plugins/app-lifeops/src/actions/lib/calendly-handler.ts:244](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/lib/calendly-handler.ts:244) |
| CalendlyActions.CALENDLY_OP | plugin:plugin-calendly | calendar, automation, connectors | { minRole: "ADMIN" } | conditional | success, text, delegated | - | [plugins/plugin-calendly/src/actions/calendly-op.ts:306](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-calendly/src/actions/calendly-op.ts:306) |
| CHARACTER | core | settings, agent_internal, media, admin | - | conditional | success, data, values, error, delegated | - | [packages/core/src/features/advanced-capabilities/personality/actions/character.ts:89](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/personality/actions/character.ts:89) |
| CHECK_AVAILABILITY | plugin:app-lifeops | calendar, contacts, tasks | { minRole: "OWNER" } | conditional | success, data, error, delegated | - | [plugins/app-lifeops/src/actions/lib/scheduling-handler.ts:670](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/lib/scheduling-handler.ts:670) |
| CHOOSE_OPTION | core | general, tasks, admin | { minRole: "ADMIN" } | conditional | success, text, data, values, error, delegated, callback | - | [packages/core/src/features/basic-capabilities/actions/choice.ts:38](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/basic-capabilities/actions/choice.ts:38) |
| CLEAR_LINEAR_ACTIVITY | plugin:plugin-linear | tasks, connectors, automation | { minRole: "USER" } | conditional | success, text, data, delegated | - | [plugins/plugin-linear/src/actions/clearActivity.ts:18](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-linear/src/actions/clearActivity.ts:18) |
| CLEAR_SHELL_HISTORY | plugin:plugin-shell | terminal, settings | { minRole: "USER" } | conditional | success, text, error, delegated, callback | - | [plugins/plugin-shell/actions/clearHistory.ts:17](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-shell/actions/clearHistory.ts:17) |
| CODE | agent | code, files, tasks, automation, agent_internal | { minRole: "USER" } | always_true | success, data, values, error, delegated | CREATE_WORKSPACE, SUBMIT_WORKSPACE, ARCHIVE_CODING_TASK, REOPEN_CODING_TASK | [packages/agent/src/actions/code-umbrella.ts:34](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/code-umbrella.ts:34) |
| COMPLETE_TODO | core | todos, agent_internal | { minRole: "USER" } | conditional | success, text, data, delegated, callback | - | [packages/core/src/features/advanced-capabilities/todos/actions/complete-todo.ts:25](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/todos/actions/complete-todo.ts:25) |
| COMPUTER_USE | plugin:plugin-computeruse | browser, files, terminal, screen_time, automation, admin | { minRole: "OWNER" } | conditional | success, error, delegated | - | [plugins/plugin-computeruse/src/actions/use-computer.ts:160](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-computeruse/src/actions/use-computer.ts:160) |
| config.name | agent | general, ...config.contexts | { minRole: "OWNER" } | always_true | success, text, delegated | - | [packages/agent/src/actions/page-action-groups.ts:122](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/page-action-groups.ts:122) |
| CONNECTOR | plugin:app-lifeops | connectors, settings, calendar, email, messaging, contacts, health, browser | { minRole: "OWNER" } | always_true | success, text, data, error, delegated | - | [plugins/app-lifeops/src/actions/connector.ts:1324](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/connector.ts:1324) |
| CONTACT | agent | contacts, messaging, documents, memory, documents | { minRole: "ADMIN" } | conditional | delegated | - | [packages/agent/src/actions/contact.ts:1671](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/contact.ts:1671) |
| CONTACT | core | contacts, messaging, documents | { minRole: "ADMIN" } | conditional | success, text, error, delegated | - | [packages/core/src/features/advanced-capabilities/actions/contact.ts:932](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/actions/contact.ts:932) |
| CONTINUE_RESEARCH | core | research, agent_internal | { minRole: "USER" } | conditional | success, text, data, delegated, callback | - | [packages/core/src/features/research/actions/continue-research.ts:41](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/research/actions/continue-research.ts:41) |
| CREATE_LINEAR_COMMENT | plugin:plugin-linear | tasks, connectors, automation | { minRole: "USER" } | conditional | success, text, data | - | [plugins/plugin-linear/src/actions/createComment.ts:19](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-linear/src/actions/createComment.ts:19) |
| CREATE_LINEAR_ISSUE | plugin:plugin-linear | tasks, connectors, automation | { minRole: "USER" } | conditional | success, text, data | - | [plugins/plugin-linear/src/actions/createIssue.ts:24](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-linear/src/actions/createIssue.ts:24) |
| CREATE_PLAN | core | tasks, automation, code, agent_internal | { minRole: "ADMIN" } | conditional | success, text, data, delegated, callback | - | [packages/core/src/features/advanced-planning/actions/create-plan.ts:39](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-planning/actions/create-plan.ts:39) |
| CREATE_RESEARCH | core | research, agent_internal | { minRole: "USER" } | conditional | success, text, data, delegated, callback | - | [packages/core/src/features/research/actions/create-research.ts:46](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/research/actions/create-research.ts:46) |
| CREATE_TODO | core | todos, agent_internal | { minRole: "USER" } | conditional | success, text, data, delegated, callback | - | [packages/core/src/features/advanced-capabilities/todos/actions/create-todo.ts:37](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/todos/actions/create-todo.ts:37) |
| DATABASE | agent | admin, agent_internal, documents, memory | { minRole: "OWNER" } | always_true | delegated | - | [packages/agent/src/actions/database.ts:692](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/database.ts:692) |
| def.name | agent | general, automation, connectors, agent_internal | def.requiredRole && def.requiredRole !== "GUEST" ? { minRole: def.requiredRole } : { minRole: "USER" } | conditional | success, text, data, delegated | - | [packages/agent/src/runtime/custom-actions.ts:613](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/runtime/custom-actions.ts:613) |
| definition.name | plugin:app-2004scape | game, automation, world, state | { minRole: "ADMIN" } | conditional | text, delegated | - | [plugins/app-2004scape/src/actions/routers.ts:181](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-2004scape/src/actions/routers.ts:181) |
| DELETE_LINEAR_COMMENT | plugin:plugin-linear | tasks, connectors, automation | { minRole: "USER" } | conditional | success, text, data | - | [plugins/plugin-linear/src/actions/deleteComment.ts:16](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-linear/src/actions/deleteComment.ts:16) |
| DELETE_LINEAR_ISSUE | plugin:plugin-linear | tasks, connectors, automation | { minRole: "USER" } | conditional | success, text, data, delegated | - | [plugins/plugin-linear/src/actions/deleteIssue.ts:23](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-linear/src/actions/deleteIssue.ts:23) |
| DELETE_RESEARCH | core | research, agent_internal | { minRole: "USER" } | conditional | success, text, data, delegated, callback | - | [packages/core/src/features/research/actions/delete-research.ts:25](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/research/actions/delete-research.ts:25) |
| DELETE_TODO | core | todos, agent_internal | { minRole: "USER" } | conditional | success, text, data, delegated, callback | - | [packages/core/src/features/advanced-capabilities/todos/actions/delete-todo.ts:25](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/todos/actions/delete-todo.ts:25) |
| DESKTOP | plugin:plugin-computeruse | files, terminal, code, browser, screen_time, automation | { minRole: "USER" } | conditional | success, error, delegated | - | [plugins/plugin-computeruse/src/actions/desktop.ts:44](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-computeruse/src/actions/desktop.ts:44) |
| DISCORD_CREATE_POLL | plugin:plugin-discord | messaging, connectors | { minRole: "USER" } | conditional | success, text, data, error, delegated | - | [plugins/plugin-discord/actions/createPoll.ts:82](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-discord/actions/createPoll.ts:82) |
| DISCORD_MEDIA | plugin:plugin-discord | messaging, media, connectors | { minRole: "USER" } | always_true | success, text, error, delegated | - | [plugins/plugin-discord/actions/mediaOp.ts:413](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-discord/actions/mediaOp.ts:413) |
| DISCORD_SETUP_CREDENTIALS | plugin:plugin-discord | messaging, connectors, settings | { minRole: "USER" } | conditional | success, text, data, error, delegated, callback | - | [plugins/plugin-discord/actions/setup-credentials.ts:500](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-discord/actions/setup-credentials.ts:500) |
| DISCORD_SUMMARIZE_CONVERSATION | plugin:plugin-discord | messaging, knowledge, connectors | { minRole: "USER" } | conditional | success, text, data, error, delegated | - | [plugins/plugin-discord/actions/summarizeConversation.ts:231](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-discord/actions/summarizeConversation.ts:231) |
| DOCUMENT | core | documents | { minRole: "USER" } | conditional | values, error, delegated | - | [packages/core/src/features/documents/actions.ts:907](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/documents/actions.ts:907) |
| EDIT | plugin:plugin-coding-tools | code, terminal, automation | { minRole: "ADMIN" } | always_true | delegated, callback | - | [plugins/plugin-coding-tools/src/actions/edit.ts:49](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-coding-tools/src/actions/edit.ts:49) |
| EDIT_RESEARCH | core | research, agent_internal | { minRole: "USER" } | conditional | success, text, data, delegated, callback | - | [packages/core/src/features/research/actions/edit-research.ts:33](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/research/actions/edit-research.ts:33) |
| EDIT_TODO | core | todos, agent_internal | { minRole: "USER" } | conditional | success, text, data, delegated, callback | - | [packages/core/src/features/advanced-capabilities/todos/actions/edit-todo.ts:42](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/todos/actions/edit-todo.ts:42) |
| ENTER_WORKTREE | plugin:plugin-coding-tools | code, terminal, automation | { minRole: "ADMIN" } | always_true | delegated, callback | - | [plugins/plugin-coding-tools/src/actions/enter-worktree.ts:44](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-coding-tools/src/actions/enter-worktree.ts:44) |
| EVALUATE_TRUST | core | admin, settings, agent_internal | { minRole: "ADMIN" } | conditional | success, text, data, error, delegated | - | [packages/core/src/features/trust/actions/evaluateTrust.ts:15](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/trust/actions/evaluateTrust.ts:15) |
| EXECUTE_CODE | plugin:plugin-executecode | code, terminal, automation | { minRole: "USER" } | conditional | success, text, data, error, delegated, callback | - | [plugins/plugin-executecode/src/action.ts:201](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-executecode/src/action.ts:201) |
| EXECUTE_ROBLOX_ACTION | plugin:plugin-roblox | media, automation | { minRole: "USER" } | conditional | success, text, data, error, delegated | - | [plugins/plugin-roblox/actions/executeRobloxAction.ts:205](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-roblox/actions/executeRobloxAction.ts:205) |
| EXIT_WORKTREE | plugin:plugin-coding-tools | code, terminal, automation | { minRole: "ADMIN" } | always_true | delegated, callback | - | [plugins/plugin-coding-tools/src/actions/exit-worktree.ts:30](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-coding-tools/src/actions/exit-worktree.ts:30) |
| EXTRACT_PAGE | agent | web, browser, documents | { minRole: "OWNER" } | conditional | success, text, data, values, error, delegated | - | [packages/agent/src/actions/extract-page.ts:47](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/extract-page.ts:47) |
| FACT_EXTRACTOR | core | - | - | conditional | delegated | - | [packages/core/src/features/advanced-capabilities/evaluators/factExtractor.ts:905](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/evaluators/factExtractor.ts:905) |
| FINISH | cloud:plugin-cloud-bootstrap | general, agent_internal | { minRole: "USER" } | conditional | success, text, delegated | - | [cloud/packages/lib/eliza/plugin-cloud-bootstrap/actions/finish.ts:79](/Users/shawwalters/eliza-workspace/milady/eliza/cloud/packages/lib/eliza/plugin-cloud-bootstrap/actions/finish.ts:79) |
| FORM_RESTORE | plugin:plugin-form | tasks, automation, memory | { minRole: "USER" } | conditional | success, text, data, error, delegated | - | [plugins/plugin-form/src/actions/restore.ts:83](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-form/src/actions/restore.ts:83) |
| GENERATE_MEDIA | cloud:plugin-cloud-bootstrap | general, media, files | { minRole: "USER" } | conditional | success, text, data, values, error, delegated, callback | - | [cloud/packages/lib/eliza/plugin-cloud-bootstrap/actions/media-generation.ts:136](/Users/shawwalters/eliza-workspace/milady/eliza/cloud/packages/lib/eliza/plugin-cloud-bootstrap/actions/media-generation.ts:136) |
| GET_LINEAR_ACTIVITY | plugin:plugin-linear | tasks, connectors, automation | { minRole: "USER" } | conditional | success, text, data, error | - | [plugins/plugin-linear/src/actions/getActivity.ts:44](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-linear/src/actions/getActivity.ts:44) |
| GET_LINEAR_ISSUE | plugin:plugin-linear | tasks, connectors, knowledge | { minRole: "USER" } | conditional | success, text, data, delegated | - | [plugins/plugin-linear/src/actions/getIssue.ts:24](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-linear/src/actions/getIssue.ts:24) |
| GET_SKILL_DETAILS | plugin:plugin-agent-skills | knowledge, automation, settings | { minRole: "USER" } | conditional | success, text, data, error, delegated, callback | - | [plugins/plugin-agent-skills/src/actions/get-skill-details.ts:33](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-agent-skills/src/actions/get-skill-details.ts:33) |
| GitHubActions.GITHUB_ISSUE_OP | plugin:plugin-github | code, tasks, connectors, automation | { minRole: "USER" } | conditional | success, text, error, delegated | - | [plugins/plugin-github/src/actions/issue-op.ts:292](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-github/src/actions/issue-op.ts:292) |
| GitHubActions.GITHUB_NOTIFICATION_TRIAGE | plugin:plugin-github | code, tasks, connectors, automation | { minRole: "USER" } | conditional | success, text, data, error, delegated | - | [plugins/plugin-github/src/actions/notification-triage.ts:86](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-github/src/actions/notification-triage.ts:86) |
| GitHubActions.GITHUB_PR_OP | plugin:plugin-github | code, tasks, connectors, automation | { minRole: "USER" } | conditional | success, text, error, delegated | - | [plugins/plugin-github/src/actions/pr-op.ts:208](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-github/src/actions/pr-op.ts:208) |
| GLOB | plugin:plugin-coding-tools | code, terminal, automation | { minRole: "ADMIN" } | always_true | delegated, callback | - | [plugins/plugin-coding-tools/src/actions/glob.ts:138](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-coding-tools/src/actions/glob.ts:138) |
| GOOGLE_CALENDAR | plugin:app-lifeops | calendar, contacts, tasks | { minRole: "OWNER" } | conditional | success, text, data, error, delegated | - | [plugins/app-lifeops/src/actions/lib/calendar-handler.ts:2984](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/lib/calendar-handler.ts:2984) |
| GREP | plugin:plugin-coding-tools | code, terminal, automation | { minRole: "ADMIN" } | always_true | delegated, callback | - | [plugins/plugin-coding-tools/src/actions/grep.ts:42](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-coding-tools/src/actions/grep.ts:42) |
| HEALTH | plugin:app-lifeops | health, tasks, calendar | { minRole: "OWNER" } | always_true | success, data, values, error, delegated | - | [plugins/app-lifeops/src/actions/health.ts:278](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/health.ts:278) |
| IGNORE | core | general | { minRole: "USER" } | conditional | success, text, data, values, delegated, callback | - | [packages/core/src/features/basic-capabilities/actions/ignore.ts:16](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/basic-capabilities/actions/ignore.ts:16) |
| INSTALL_SKILL | plugin:plugin-agent-skills | automation, settings, connectors | { minRole: "USER" } | conditional | success, text, data, error, delegated, callback | - | [plugins/plugin-agent-skills/src/actions/install-skill.ts:30](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-agent-skills/src/actions/install-skill.ts:30) |
| LIFE | plugin:app-lifeops | tasks, calendar, health | { minRole: "OWNER" } | conditional | success, text, data, values, error, delegated | - | [plugins/app-lifeops/src/actions/life.ts:1978](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/life.ts:1978) |
| LINEAR | plugin:plugin-linear | general, automation, knowledge, linear | { minRole: "USER" } | conditional | success, data, values, error, delegated | - | [plugins/plugin-linear/src/actions/linear.ts:164](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-linear/src/actions/linear.ts:164) |
| LINEAR_COMMENT | plugin:plugin-linear | general, automation, linear_comment | { minRole: "USER" } | conditional | delegated | - | [plugins/plugin-linear/src/actions/routers.ts:425](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-linear/src/actions/routers.ts:425) |
| LINEAR_ISSUE | plugin:plugin-linear | general, automation, knowledge, linear_issue | { minRole: "USER" } | conditional | delegated | - | [plugins/plugin-linear/src/actions/routers.ts:373](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-linear/src/actions/routers.ts:373) |
| LINEAR_WORKFLOW | plugin:plugin-linear | general, automation, knowledge, linear_workflow | { minRole: "USER" } | conditional | delegated | - | [plugins/plugin-linear/src/actions/routers.ts:477](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-linear/src/actions/routers.ts:477) |
| LIST_ACTIVE_BLOCKS | plugin:app-lifeops | screen_time, browser, tasks, automation | { minRole: "OWNER" } | conditional | success, text, data, delegated | - | [plugins/app-lifeops/src/website-blocker/chat-integration/actions/listActiveBlocks.ts:62](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/website-blocker/chat-integration/actions/listActiveBlocks.ts:62) |
| LIST_LINEAR_COMMENTS | plugin:plugin-linear | tasks, connectors, automation | { minRole: "USER" } | conditional | success, text, delegated | - | [plugins/plugin-linear/src/actions/listComments.ts:16](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-linear/src/actions/listComments.ts:16) |
| LIST_OVERDUE_FOLLOWUPS | plugin:app-lifeops | contacts, tasks, calendar, messaging | { minRole: "OWNER" } | always_true | success, text, data, delegated | - | [plugins/app-lifeops/src/followup/actions/listOverdueFollowups.ts:23](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/followup/actions/listOverdueFollowups.ts:23) |
| LIST_RESEARCH | core | research, agent_internal | { minRole: "USER" } | conditional | success, text, data, delegated, callback | - | [packages/core/src/features/research/actions/list-research.ts:38](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/research/actions/list-research.ts:38) |
| LIST_TODOS | core | todos, agent_internal | { minRole: "USER" } | conditional | success, text, data, delegated, callback | - | [packages/core/src/features/advanced-capabilities/todos/actions/list-todos.ts:40](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/todos/actions/list-todos.ts:40) |
| LOGS | agent | admin, agent_internal, settings | { minRole: "OWNER" } | always_true | text, delegated, callback | - | [packages/agent/src/actions/logs.ts:232](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/logs.ts:232) |
| lp_management | plugin:plugin-wallet | finance, crypto, wallet, automation | { minRole: "USER" } | always_true | success, text, error, delegated | - | [plugins/plugin-wallet/src/lp/actions/LpManagementAgentAction.ts:584](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-wallet/src/lp/actions/LpManagementAgentAction.ts:584) |
| LS | plugin:plugin-coding-tools | code, terminal, automation | { minRole: "ADMIN" } | always_true | delegated, callback | - | [plugins/plugin-coding-tools/src/actions/ls.ts:75](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-coding-tools/src/actions/ls.ts:75) |
| MANAGE_BROWSER_BRIDGE | plugin:plugin-browser | browser, files, connectors, settings | { minRole: "OWNER" } | conditional | success, text, data, values, error, delegated | - | [plugins/plugin-browser/src/actions/manage-browser-bridge.ts:531](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-browser/src/actions/manage-browser-bridge.ts:531) |
| MANAGE_LP_POSITIONS | plugin:plugin-wallet | finance, crypto, wallet, automation | { minRole: "USER" } | always_true | delegated | - | [plugins/plugin-wallet/src/chains/solana/dex/manage-lp-positions.ts:111](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-wallet/src/chains/solana/dex/manage-lp-positions.ts:111) |
| MANAGE_PLUGINS | core | admin, settings, connectors | { minRole: "OWNER" } | conditional | success, text, delegated | - | [packages/core/src/features/plugin-manager/actions/plugin.ts:318](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/plugin-manager/actions/plugin.ts:318) |
| manage_positions | plugin:plugin-wallet | finance, crypto, wallet | { minRole: "USER" } | always_true | delegated | - | [plugins/plugin-wallet/src/chains/solana/dex/orca/actions/managePositions.ts:126](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-wallet/src/chains/solana/dex/orca/actions/managePositions.ts:126) |
| manage_raydium_positions | plugin:plugin-wallet | finance, crypto, wallet | { minRole: "USER" } | always_true | delegated | - | [plugins/plugin-wallet/src/chains/solana/dex/raydium/actions/managePositions.ts:133](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-wallet/src/chains/solana/dex/raydium/actions/managePositions.ts:133) |
| MANAGE_ROUTING | plugin:plugin-music-player | media, automation, settings | { minRole: "USER" } | always_true | error, delegated | - | [plugins/plugin-music-player/src/actions/manageRouting.ts:175](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-music-player/src/actions/manageRouting.ts:175) |
| MANAGE_SECRET | core | secrets, settings, connectors | { minRole: "OWNER" } | conditional | success, text, data, delegated, callback | - | [packages/core/src/features/secrets/actions/manage-secret.ts:43](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/secrets/actions/manage-secret.ts:43) |
| MANAGE_ZONES | plugin:plugin-music-player | media, automation, settings | { minRole: "USER" } | always_true | error, delegated | - | [plugins/plugin-music-player/src/actions/manageZones.ts:171](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-music-player/src/actions/manageZones.ts:171) |
| MARK_FOLLOWUP_DONE | plugin:app-lifeops | contacts, tasks, calendar, messaging | { minRole: "OWNER" } | always_true | success, text, data, delegated | - | [plugins/app-lifeops/src/followup/actions/markFollowupDone.ts:56](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/followup/actions/markFollowupDone.ts:56) |
| MC_ATTACK | plugin:plugin-minecraft | automation, media | { minRole: "USER" } | conditional | success, text, data, error, delegated | - | [plugins/plugin-minecraft/src/actions/attack.ts:26](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-minecraft/src/actions/attack.ts:26) |
| MC_BLOCK | plugin:plugin-minecraft | automation, media | { minRole: "USER" } | conditional | success, text, data, error, delegated | - | [plugins/plugin-minecraft/src/actions/block-op.ts:47](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-minecraft/src/actions/block-op.ts:47) |
| MC_CHAT | plugin:plugin-minecraft | messaging, automation, media | { minRole: "USER" } | conditional | success, text, data, values, error, delegated | - | [plugins/plugin-minecraft/src/actions/chat.ts:17](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-minecraft/src/actions/chat.ts:17) |
| MC_CONNECT | plugin:plugin-minecraft | connectors, automation, media | { minRole: "USER" } | conditional | success, text, data, values, error, delegated | - | [plugins/plugin-minecraft/src/actions/connect.ts:33](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-minecraft/src/actions/connect.ts:33) |
| MC_DISCONNECT | plugin:plugin-minecraft | connectors, automation, media | { minRole: "USER" } | conditional | success, text, data, values, error, delegated | - | [plugins/plugin-minecraft/src/actions/disconnect.ts:17](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-minecraft/src/actions/disconnect.ts:17) |
| MC_LOCOMOTE | plugin:plugin-minecraft | automation, media | { minRole: "USER" } | conditional | success, text, data, error, delegated | - | [plugins/plugin-minecraft/src/actions/locomote-op.ts:103](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-minecraft/src/actions/locomote-op.ts:103) |
| MC_WAYPOINT | plugin:plugin-minecraft | automation, memory, media | { minRole: "USER" } | conditional | success, text, data, values, error, delegated | - | [plugins/plugin-minecraft/src/actions/waypoint-op.ts:48](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-minecraft/src/actions/waypoint-op.ts:48) |
| MCP | cloud:plugin-mcp | connectors, automation, knowledge, documents, files, settings | { minRole: "ADMIN" } | conditional | text, delegated | - | [cloud/packages/lib/eliza/plugin-mcp/actions/mcp.ts:488](/Users/shawwalters/eliza-workspace/milady/eliza/cloud/packages/lib/eliza/plugin-mcp/actions/mcp.ts:488) |
| MCP | plugin:plugin-mcp | general, automation, knowledge, connectors, mcp, files | { minRole: "USER" } | conditional | success, data, values, error, delegated | - | [plugins/plugin-mcp/src/actions/mcp.ts:364](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-mcp/src/actions/mcp.ts:364) |
| MEMORY | agent | memory, documents, agent_internal | { minRole: "OWNER" } | always_true | success, text, data, error, delegated | - | [packages/agent/src/actions/memories.ts:297](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/memories.ts:297) |
| MESSAGE | core | messaging, email, contacts, connectors | { minRole: "ADMIN" } | conditional | delegated | - | [packages/core/src/features/advanced-capabilities/actions/message.ts:2738](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/actions/message.ts:2738) |
| MESSAGE | core | messaging, email, contacts, tasks | { minRole: "ADMIN" } | conditional | success, text, data, error, delegated, callback | - | [packages/core/src/features/messaging/triage/actions/draftFollowup.ts:19](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/messaging/triage/actions/draftFollowup.ts:19) |
| MESSAGE | core | messaging, email, contacts | { minRole: "ADMIN" } | conditional | success, text, data, error, delegated, callback | - | [packages/core/src/features/messaging/triage/actions/draftReply.ts:35](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/messaging/triage/actions/draftReply.ts:35) |
| MESSAGE | core | messaging, email, connectors | { minRole: "ADMIN" } | conditional | success, text, data, error, delegated, callback | - | [packages/core/src/features/messaging/triage/actions/listInbox.ts:17](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/messaging/triage/actions/listInbox.ts:17) |
| MESSAGE | core | messaging, email, contacts | { minRole: "ADMIN" } | conditional | success, text, data, error, delegated, callback | - | [packages/core/src/features/messaging/triage/actions/manageMessage.ts:35](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/messaging/triage/actions/manageMessage.ts:35) |
| MESSAGE | core | messaging, email, contacts | { minRole: "ADMIN" } | conditional | success, text, data, error, delegated, callback | - | [packages/core/src/features/messaging/triage/actions/respondToMessage.ts:63](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/messaging/triage/actions/respondToMessage.ts:63) |
| MESSAGE | core | messaging, email, calendar, automation | { minRole: "ADMIN" } | conditional | success, text, data, error, delegated, callback | - | [packages/core/src/features/messaging/triage/actions/scheduleDraftSend.ts:19](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/messaging/triage/actions/scheduleDraftSend.ts:19) |
| MESSAGE | core | messaging, email, documents | { minRole: "ADMIN" } | conditional | success, data, delegated, callback | - | [packages/core/src/features/messaging/triage/actions/searchMessages.ts:16](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/messaging/triage/actions/searchMessages.ts:16) |
| MESSAGE | core | messaging, email, contacts | { minRole: "ADMIN" } | conditional | success, text, data, error, delegated, callback | - | [packages/core/src/features/messaging/triage/actions/sendDraft.ts:204](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/messaging/triage/actions/sendDraft.ts:204) |
| MESSAGE | core | messaging, email, documents | { minRole: "ADMIN" } | conditional | success, text, data, delegated, callback | - | [packages/core/src/features/messaging/triage/actions/triageMessages.ts:21](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/messaging/triage/actions/triageMessages.ts:21) |
| MUSIC_GENERATION | plugin:plugin-suno | media | { minRole: 'USER' } | conditional | success, text, data, error, delegated | - | [plugins/plugin-suno/src/actions/musicGeneration.ts:99](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-suno/src/actions/musicGeneration.ts:99) |
| MUSIC_LIBRARY | plugin:plugin-music-library | media, automation, knowledge, web, files | { minRole: "USER" } | conditional | success, error, delegated, callback | - | [plugins/plugin-music-library/src/actions/musicLibrary.ts:158](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-music-library/src/actions/musicLibrary.ts:158) |
| NONE | core | general | { minRole: "USER" } | conditional | success, text, data, values, delegated | - | [packages/core/src/features/basic-capabilities/actions/none.ts:15](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/basic-capabilities/actions/none.ts:15) |
| NOSTR_PUBLISH_PROFILE | plugin:plugin-nostr | social_posting, connectors | { minRole: "USER" } | conditional | success, text, data, error, delegated, callback | - | [plugins/plugin-nostr/src/actions/publishProfile.ts:47](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-nostr/src/actions/publishProfile.ts:47) |
| OAUTH | cloud:plugin-oauth | connectors, settings, secrets | { minRole: "ADMIN" } | conditional | success, text, data, values, error, delegated, callback | - | [cloud/packages/lib/eliza/plugin-oauth/actions/oauth.ts:507](/Users/shawwalters/eliza-workspace/milady/eliza/cloud/packages/lib/eliza/plugin-oauth/actions/oauth.ts:507) |
| PASSWORD_MANAGER | plugin:app-lifeops | secrets, browser, automation | { minRole: "OWNER" } | always_true | success, text, data, values, error, delegated | - | [plugins/app-lifeops/src/actions/password-manager.ts:128](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/password-manager.ts:128) |
| PAYMENT | plugin:plugin-mysticism | finance, payments | { minRole: "OWNER" } | conditional | success, text, data, delegated | - | [plugins/plugin-mysticism/src/actions/payment-op.ts:44](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-mysticism/src/actions/payment-op.ts:44) |
| PAYMENTS | plugin:app-lifeops | payments, finance, wallet, crypto, subscriptions | { minRole: "OWNER" } | always_true | success, text, data, delegated | - | [plugins/app-lifeops/src/actions/payments.ts:270](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/payments.ts:270) |
| PLACE_CALL | plugin:app-phone | phone, contacts, messaging | { minRole: "USER" } | conditional | success, text, data, delegated | - | [plugins/app-phone/src/actions/place-call.ts:103](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-phone/src/actions/place-call.ts:103) |
| PLAY_AUDIO | plugin:plugin-music-player | media, automation | { minRole: "USER" } | conditional | success, text, data, error, delegated, callback | - | [plugins/plugin-music-player/src/actions/playAudio.ts:538](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-music-player/src/actions/playAudio.ts:538) |
| PLAY_EMOTE | plugin:app-companion | media, general | { minRole: "USER" } | conditional | success, text, data, delegated | - | [plugins/app-companion/src/actions/emote.ts:21](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-companion/src/actions/emote.ts:21) |
| PLAYBACK | plugin:plugin-music-player | media, automation | { minRole: "USER" } | always_true | delegated, callback | - | [plugins/plugin-music-player/src/actions/playbackOp.ts:480](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-music-player/src/actions/playbackOp.ts:480) |
| PLUGIN | agent | admin, settings, connectors, secrets, code, files | { minRole: "OWNER" } | conditional | delegated | - | [packages/agent/src/actions/plugin.ts:770](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/plugin.ts:770) |
| POST | core | social_posting, connectors | { minRole: "ADMIN" } | conditional | delegated | - | [packages/core/src/features/advanced-capabilities/actions/post.ts:579](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/actions/post.ts:579) |
| PREDICTION_MARKET | plugin:app-polymarket | finance, crypto, prediction-market, payments | { minRole: "USER" } | conditional | delegated | - | [plugins/app-polymarket/src/actions.ts:718](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-polymarket/src/actions.ts:718) |
| PROFILE | plugin:app-lifeops | memory, contacts, tasks, settings, calendar | { minRole: "OWNER" } | always_true | success, text, data, error, delegated | - | [plugins/app-lifeops/src/actions/profile.ts:341](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/profile.ts:341) |
| PROPOSE_MEETING_TIMES | plugin:app-lifeops | calendar, contacts, tasks | { minRole: "OWNER" } | conditional | success, text, data, error, delegated | - | [plugins/app-lifeops/src/actions/lib/scheduling-handler.ts:446](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/lib/scheduling-handler.ts:446) |
| QUERY_TRAJECTORIES | agent | agent_internal, admin, documents | { minRole: "OWNER" } | always_true | success, text, data, values, delegated | - | [packages/agent/src/actions/trajectories.ts:28](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/trajectories.ts:28) |
| READ | plugin:plugin-coding-tools | code, terminal, automation | { minRole: "ADMIN" } | always_true | text, delegated, callback | - | [plugins/plugin-coding-tools/src/actions/read.ts:33](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-coding-tools/src/actions/read.ts:33) |
| READ_ATTACHMENT | core | files, media, messaging, documents | { minRole: "ADMIN" } | conditional | success, text, data, error, delegated, callback | - | [packages/core/src/features/working-memory/readAttachmentAction.ts:189](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/working-memory/readAttachmentAction.ts:189) |
| READ_RESEARCH | core | research, agent_internal | { minRole: "USER" } | conditional | success, text, data, delegated, callback | - | [packages/core/src/features/research/actions/read-research.ts:25](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/research/actions/read-research.ts:25) |
| READING | plugin:plugin-mysticism | knowledge, general | { minRole: "USER" } | conditional | success, text, delegated | - | [plugins/plugin-mysticism/src/actions/reading-op.ts:456](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-mysticism/src/actions/reading-op.ts:456) |
| RECORD_TRUST_INTERACTION | core | admin, settings, agent_internal | { minRole: "ADMIN" } | conditional | success, text, data, error, delegated | - | [packages/core/src/features/trust/actions/recordTrustInteraction.ts:14](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/trust/actions/recordTrustInteraction.ts:14) |
| RELATIONSHIP | plugin:app-lifeops | contacts, tasks, calendar, messaging, memory | { minRole: "OWNER" } | always_true | success, data, values, error, delegated | - | [plugins/app-lifeops/src/actions/relationship.ts:564](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/relationship.ts:564) |
| RELEASE_BLOCK | plugin:app-lifeops | screen_time, browser, tasks, automation | { minRole: "OWNER" } | conditional | success, text, data, delegated | - | [plugins/app-lifeops/src/website-blocker/chat-integration/actions/releaseBlock.ts:108](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/website-blocker/chat-integration/actions/releaseBlock.ts:108) |
| REMOTE_DESKTOP | plugin:app-lifeops | browser, automation, settings, admin, terminal | { minRole: "OWNER" } | always_true | success, text, data, values, error, delegated | - | [plugins/app-lifeops/src/actions/remote-desktop.ts:304](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/remote-desktop.ts:304) |
| REPLY | core | general, messaging | { minRole: "USER" } | conditional | success, text, data, values, error, delegated, callback | - | [packages/core/src/features/basic-capabilities/actions/reply.ts:35](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/basic-capabilities/actions/reply.ts:35) |
| REQUEST_ELEVATION | core | admin, settings, agent_internal | { minRole: "USER" } | conditional | success, text, data, error, delegated | - | [packages/core/src/features/trust/actions/requestElevation.ts:12](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/trust/actions/requestElevation.ts:12) |
| REQUEST_SECRET | core | secrets, settings, connectors | { minRole: "OWNER" } | conditional | success, text, data, error, delegated, callback | - | [packages/core/src/features/secrets/actions/request-secret.ts:19](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/secrets/actions/request-secret.ts:19) |
| RESEARCH | core | research, agent_internal | { minRole: "USER" } | conditional | success, text, data, delegated | CREATE_RESEARCH, CONTINUE_RESEARCH, READ_RESEARCH, LIST_RESEARCH, EDIT_RESEARCH, DELETE_RESEARCH | [packages/core/src/features/research/actions/research.ts:10](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/research/actions/research.ts:10) |
| RESOLVE_REQUEST | plugin:app-lifeops | email, messaging, calendar, tasks, contacts, payments, automation, admin, general | { minRole: "OWNER" } | always_true | success, text, data, delegated | - | [plugins/app-lifeops/src/actions/resolve-request.ts:400](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/resolve-request.ts:400) |
| ROBLOX_ACTION | plugin:plugin-roblox | media, automation | { minRole: "USER" } | conditional | success, text, error, delegated | - | [plugins/plugin-roblox/actions/robloxAction.ts:411](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-roblox/actions/robloxAction.ts:411) |
| ROLE | core | admin, settings | { minRole: "OWNER" } | always_true | success, text, data, error, delegated | - | [packages/core/src/features/advanced-capabilities/actions/role.ts:607](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/actions/role.ts:607) |
| ROOM_OP | core | messaging, contacts, settings | { minRole: "ADMIN" } | always_true | success, text, data, values, error, delegated | - | [packages/core/src/features/advanced-capabilities/actions/room.ts:401](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/actions/room.ts:401) |
| RS_2004_WALK_TO | plugin:app-2004scape | game, automation, world, state | { minRole: "ADMIN" } | conditional | text, delegated | - | [plugins/app-2004scape/src/actions/routers.ts:262](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-2004scape/src/actions/routers.ts:262) |
| RUNTIME | agent | admin, agent_internal, settings, general, connectors, wallet | { minRole: "OWNER" } | always_true | success, text, data, values, error, delegated | - | [packages/agent/src/actions/runtime.ts:406](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/runtime.ts:406) |
| SCAPE | plugin:app-scape | game, automation, world, state, messaging | { minRole: "ADMIN" } | conditional | success, data, error, delegated | - | [plugins/app-scape/src/actions/scape.ts:265](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-scape/src/actions/scape.ts:265) |
| SCHEDULE | agent | tasks, automation, calendar, contacts, code, agent_internal | { minRole: "ADMIN" } | conditional | text, delegated, callback | - | [packages/agent/src/actions/schedule.ts:848](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/schedule.ts:848) |
| SCHEDULE | plugin:app-lifeops | calendar, tasks, health, screen_time | { minRole: "OWNER" } | conditional | success, data, error, delegated | - | [plugins/app-lifeops/src/actions/schedule.ts:132](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/schedule.ts:132) |
| SCHEDULING | plugin:app-lifeops | calendar, contacts, tasks, messaging | { minRole: "OWNER" } | always_true | success, text, data, values, error, delegated | - | [plugins/app-lifeops/src/actions/lib/scheduling-handler.ts:1169](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/lib/scheduling-handler.ts:1169) |
| SCREEN_TIME | plugin:app-lifeops | screen_time, browser, health, tasks | { minRole: "OWNER" } | conditional | success, text, data, error, delegated | - | [plugins/app-lifeops/src/actions/screen-time.ts:241](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/screen-time.ts:241) |
| SEARCH | agent | general, documents, browser, admin, social_posting | { minRole: "USER" } | conditional | success, text, data, values, error, delegated | - | [packages/agent/src/actions/web-search.ts:680](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/web-search.ts:680) |
| SEARCH_EXPERIENCES | core | memory, documents, agent_internal | { minRole: "USER" } | conditional | success, text, data, values, delegated, callback | - | [packages/core/src/features/advanced-capabilities/experience/actions/search-experiences.ts:54](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/experience/actions/search-experiences.ts:54) |
| SEARCH_LINEAR_ISSUES | plugin:plugin-linear | tasks, connectors, knowledge | { minRole: "USER" } | conditional | success, text, data | - | [plugins/plugin-linear/src/actions/searchIssues.ts:27](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-linear/src/actions/searchIssues.ts:27) |
| SEARCH_SHOPIFY_STORE | plugin:plugin-shopify | payments, connectors, automation, knowledge | { minRole: "USER" } | conditional | success, text, data, error, delegated | - | [plugins/plugin-shopify/src/actions/search-store.ts:140](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-shopify/src/actions/search-store.ts:140) |
| SEARCH_SKILLS | plugin:plugin-agent-skills | knowledge, automation, settings | { minRole: "USER" } | conditional | success, text, error, delegated, callback | - | [plugins/plugin-agent-skills/src/actions/search-skills.ts:182](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-agent-skills/src/actions/search-skills.ts:182) |
| SECRETS_UPDATE_SETTINGS | core | settings, secrets, connectors | { minRole: "ADMIN" } | conditional | success, text, data, values, delegated, callback | - | [packages/core/src/features/secrets/onboarding/action.ts:316](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/secrets/onboarding/action.ts:316) |
| SEND_ROBLOX_MESSAGE | plugin:plugin-roblox | media, messaging | { minRole: "USER" } | conditional | success, text, data, error, delegated | - | [plugins/plugin-roblox/actions/sendRobloxMessage.ts:101](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-roblox/actions/sendRobloxMessage.ts:101) |
| SEND_TO_ADMIN | core | admin, messaging, agent_internal | { minRole: "ADMIN" } | conditional | success, text, data, error, delegated, callback | - | [packages/core/src/features/autonomy/action.ts:35](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/autonomy/action.ts:35) |
| SET_FOLLOWUP_THRESHOLD | plugin:app-lifeops | contacts, tasks, calendar, settings | { minRole: "OWNER" } | always_true | success, text, data, delegated | - | [plugins/app-lifeops/src/followup/actions/setFollowupThreshold.ts:32](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/followup/actions/setFollowupThreshold.ts:32) |
| SET_SECRET | core | secrets, settings, connectors | { minRole: "OWNER" } | conditional | success, text, data, error, delegated, callback | - | [packages/core/src/features/secrets/actions/set-secret.ts:47](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/secrets/actions/set-secret.ts:47) |
| SETTINGS | agent | settings, admin, agent_internal | { minRole: "OWNER" } | always_true | delegated | - | [packages/agent/src/actions/settings-actions.ts:521](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/settings-actions.ts:521) |
| SHELL_COMMAND | agent | terminal, code, files, admin | { minRole: "OWNER" } | always_true | success, text, data, delegated | - | [packages/agent/src/actions/terminal.ts:260](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/terminal.ts:260) |
| SHOPIFY | plugin:plugin-shopify | payments, connectors, automation, knowledge | { minRole: "USER" } | conditional | success, data, values, error, delegated | - | [plugins/plugin-shopify/src/actions/shopify.ts:95](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-shopify/src/actions/shopify.ts:95) |
| SKILL | plugin:plugin-agent-skills | - | { minRole: "USER" } | conditional | success, data, values, error, delegated | - | [plugins/plugin-agent-skills/src/actions/skill.ts:131](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-agent-skills/src/actions/skill.ts:131) |
| SKILL_COMMAND | agent | admin, agent_internal, automation | { minRole: "ADMIN" } | conditional | text, delegated | - | [packages/agent/src/actions/skill-command.ts:74](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/skill-command.ts:74) |
| spec.name | core | media, files | { minRole: "USER" } | always_true | success, text, data, values, error, delegated, callback | - | [packages/core/src/features/advanced-capabilities/actions/generateMedia.ts:373](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/actions/generateMedia.ts:373) |
| spec.name | core | - | - | conditional | delegated | - | [packages/core/src/features/advanced-capabilities/evaluators/reflection.ts:897](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/evaluators/reflection.ts:897) |
| spec.name | core | - | - | conditional | delegated | - | [packages/core/src/features/advanced-capabilities/evaluators/relationshipExtraction.ts:170](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/evaluators/relationshipExtraction.ts:170) |
| spec.name | plugin:plugin-wallet | finance, crypto, wallet, payments | { minRole: "USER" } | conditional | success, text, data, values, delegated, callback | - | [plugins/plugin-wallet/src/chains/evm/actions/bridge.ts:528](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-wallet/src/chains/evm/actions/bridge.ts:528) |
| spec.name | plugin:plugin-wallet | finance, crypto, wallet | { minRole: "USER" } | conditional | success, text, data, values, delegated, callback | - | [plugins/plugin-wallet/src/chains/evm/actions/swap.ts:675](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-wallet/src/chains/evm/actions/swap.ts:675) |
| spec.name | plugin:plugin-wallet | finance, crypto, wallet, payments | { minRole: "USER" } | conditional | success, text, data, values, delegated, callback | - | [plugins/plugin-wallet/src/chains/evm/actions/transfer.ts:131](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-wallet/src/chains/evm/actions/transfer.ts:131) |
| STREAM | agent | general, media, automation, settings | { minRole: "OWNER" } | conditional | success, text, error, delegated | - | [packages/agent/src/actions/stream-control.ts:123](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/stream-control.ts:123) |
| STREAM | plugin:plugin-streaming | media, automation, connectors | { minRole: "ADMIN" } | conditional | success, data, error, delegated, callback | - | [plugins/plugin-streaming/src/core.ts:551](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-streaming/src/core.ts:551) |
| SUBSCRIPTIONS | plugin:app-lifeops | subscriptions, payments, finance, browser, automation | { minRole: "OWNER" } | always_true | success, text, data, delegated | - | [plugins/app-lifeops/src/actions/subscriptions.ts:482](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/subscriptions.ts:482) |
| SYNC_SKILL_CATALOG | plugin:plugin-agent-skills | automation, settings, connectors | { minRole: "USER" } | conditional | success, text, data, error, delegated, callback | - | [plugins/plugin-agent-skills/src/actions/sync-catalog.ts:20](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-agent-skills/src/actions/sync-catalog.ts:20) |
| TAILSCALE | plugin:plugin-tailscale | connectors, settings, admin | { minRole: 'USER' } | conditional | success, error, delegated, callback | - | [plugins/plugin-tailscale/src/actions/tailscale.ts:213](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-tailscale/src/actions/tailscale.ts:213) |
| TASKS | plugin:plugin-agent-orchestrator | tasks, code, automation, agent_internal, connectors | { minRole: "USER" } | always_true | delegated | - | [plugins/plugin-agent-orchestrator/src/actions/tasks.ts:2048](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-agent-orchestrator/src/actions/tasks.ts:2048) |
| TODO | core | todos, agent_internal | { minRole: "USER" } | conditional | success, text, data, delegated | CREATE_TODO, COMPLETE_TODO, LIST_TODOS, EDIT_TODO, DELETE_TODO | [packages/core/src/features/advanced-capabilities/todos/actions/todo.ts:10](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/advanced-capabilities/todos/actions/todo.ts:10) |
| TODO | plugin:plugin-todos | code, task, automation | - | always_true | delegated | - | [plugins/plugin-todos/src/actions/todo.ts:418](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-todos/src/actions/todo.ts:418) |
| TOGGLE_FEATURE | plugin:app-lifeops | settings, automation, connectors | { minRole: "OWNER" } | always_true | success, data, values, error, delegated | - | [plugins/app-lifeops/src/actions/toggle-feature.ts:149](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/toggle-feature.ts:149) |
| TOGGLE_SKILL | plugin:plugin-agent-skills | automation, settings | { minRole: "USER" } | conditional | success, text, data, error, delegated, callback | - | [plugins/plugin-agent-skills/src/actions/toggle-skill.ts:21](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-agent-skills/src/actions/toggle-skill.ts:21) |
| TOKEN_INFO | plugin:plugin-wallet | finance, crypto, wallet | { minRole: "USER" } | conditional | data, error, delegated | - | [plugins/plugin-wallet/src/analytics/token-info/action.ts:66](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-wallet/src/analytics/token-info/action.ts:66) |
| TRUST_UPDATE_ROLE | core | admin, settings | { minRole: "OWNER" } | conditional | success, text, data, error, delegated | - | [packages/core/src/features/trust/actions/roles.ts:118](/Users/shawwalters/eliza-workspace/milady/eliza/packages/core/src/features/trust/actions/roles.ts:118) |
| UNINSTALL_SKILL | plugin:plugin-agent-skills | automation, settings | { minRole: "USER" } | conditional | success, text, data, error, delegated, callback | - | [plugins/plugin-agent-skills/src/actions/uninstall-skill.ts:23](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-agent-skills/src/actions/uninstall-skill.ts:23) |
| UPDATE_LINEAR_COMMENT | plugin:plugin-linear | tasks, connectors, automation | { minRole: "USER" } | conditional | success, text, data | - | [plugins/plugin-linear/src/actions/updateComment.ts:16](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-linear/src/actions/updateComment.ts:16) |
| UPDATE_LINEAR_ISSUE | plugin:plugin-linear | tasks, connectors, automation | { minRole: "USER" } | conditional | success, text, data, delegated | - | [plugins/plugin-linear/src/actions/updateIssue.ts:28](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-linear/src/actions/updateIssue.ts:28) |
| UPDATE_MEETING_PREFERENCES | plugin:app-lifeops | calendar, contacts, tasks, settings | { minRole: "OWNER" } | conditional | success, data, error, delegated | - | [plugins/app-lifeops/src/actions/lib/scheduling-handler.ts:829](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/lib/scheduling-handler.ts:829) |
| USE_SKILL | plugin:plugin-agent-skills | automation, knowledge, connectors | { minRole: "USER" } | conditional | success, text, data, values, error, delegated, callback | - | [plugins/plugin-agent-skills/src/actions/use-skill.ts:165](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-agent-skills/src/actions/use-skill.ts:165) |
| VISION | plugin:plugin-vision | media, screen_time, automation, memory, settings | { minRole: "USER" } | conditional | success, data, values, error, delegated, callback | - | [plugins/plugin-vision/src/action.ts:1321](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-vision/src/action.ts:1321) |
| VOICE_CALL | plugin:app-lifeops | contacts, messaging, phone, tasks, automation | { minRole: "OWNER" } | always_true | success, text, data, delegated | - | [plugins/app-lifeops/src/actions/voice-call.ts:775](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/voice-call.ts:775) |
| WALLET | plugin:plugin-wallet | finance, crypto, wallet | { minRole: "USER" } | always_true | success, data, values, error, delegated | - | [plugins/plugin-wallet/src/chains/wallet-action.ts:255](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-wallet/src/chains/wallet-action.ts:255) |
| WEB_FETCH | plugin:plugin-coding-tools | code, terminal, automation | { minRole: "ADMIN" } | always_true | delegated, callback | - | [plugins/plugin-coding-tools/src/actions/web-fetch.ts:45](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-coding-tools/src/actions/web-fetch.ts:45) |
| WEB_SEARCH | cloud:plugin-web-search | web, documents, finance, crypto | { minRole: "USER" } | conditional | success, text, data, error, delegated, callback | - | [cloud/packages/lib/eliza/plugin-web-search/src/actions/webSearch.ts:179](/Users/shawwalters/eliza-workspace/milady/eliza/cloud/packages/lib/eliza/plugin-web-search/src/actions/webSearch.ts:179) |
| WEBSITE_BLOCK | plugin:app-lifeops | screen_time, browser, automation, tasks, settings | { minRole: "OWNER" } | conditional | success, text, data, delegated | - | [plugins/app-lifeops/src/actions/website-block.ts:787](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/website-block.ts:787) |
| WORKFLOW | agent | automation, tasks, agent_internal | { minRole: "OWNER" } | always_true | success, text, delegated | - | [packages/agent/src/actions/workflow/workflow.ts:1040](/Users/shawwalters/eliza-workspace/milady/eliza/packages/agent/src/actions/workflow/workflow.ts:1040) |
| WRITE | plugin:plugin-coding-tools | code, terminal, automation | { minRole: "ADMIN" } | always_true | delegated, callback | - | [plugins/plugin-coding-tools/src/actions/write.ts:29](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/plugin-coding-tools/src/actions/write.ts:29) |
| X | plugin:app-lifeops | social_posting, messaging, contacts, web | { minRole: "OWNER" } | always_true | success, text, data, values, error, delegated | - | [plugins/app-lifeops/src/actions/x.ts:489](/Users/shawwalters/eliza-workspace/milady/eliza/plugins/app-lifeops/src/actions/x.ts:489) |
