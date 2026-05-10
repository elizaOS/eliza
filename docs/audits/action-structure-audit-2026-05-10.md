# Action and Subaction Structure Audit - 2026-05-10

Scope: production action surfaces under `packages/core/src`, `packages/agent/src`,
and `plugins/`, excluding tests, benchmark datasets, examples, templates,
`dist`, `node_modules`, and `packages/app`. Generated specs were excluded from
the primary enumeration but spot-checked for stale action names because core
imports the generated action-doc registry.

This is a structural review. It treats examples and similes as routing evidence
only; they are not counted as actions unless a real action definition or plugin
registration exposes them.

## Terms

- Parent action: the planner-visible umbrella name, such as `MESSAGE`, `FILE`,
  `OWNER_TODOS`, or `GITHUB`.
- Child action / subaction: the discriminator value under the parent, now
  intended to use the canonical parameter name `action`.
- Promoted virtual action: a generated action named `<PARENT>_<CHILD>` from
  `promoteSubactionsToActions(parent)`. It delegates to the parent and injects
  the child discriminator.
- Family: the higher-level domain bucket that explains why the parent exists at
  all: conversation, owner operations, runtime/admin, developer tools, provider
  integrations, media, finance, or games.
- Exposed: registered by a plugin/capability action list.
- Implementation-only: still present as code or export, but not registered by
  the owning plugin in the current source.

## High Priority Misses

| Issue | Evidence | Why It Matters | Recommendation |
|---|---|---|---|
| `SHELL_COMMAND` is still exposed by the agent plugin. | `packages/agent/src/runtime/eliza-plugin.ts` registers `terminalAction`; `terminalAction` still has `name = "SHELL_COMMAND"`. | The earlier consolidation normalized coding-tools to `SHELL`, but the default agent still exposes a second shell parent. Planner and audit output can choose either. | Rename agent `terminalAction` to `SHELL` or stop registering it when `coding-tools` is active. Keep `SHELL_COMMAND` as simile only. |
| Generated docs and prompt repair artifacts still contain legacy names. | `packages/core/src/generated/action-docs.ts`, `packages/core/src/services/message.ts`, `packages/agent/src/runtime/prompt-compaction.ts`, and `plugins/app-training/src/core/context-catalog.ts` still reference names such as `SHELL_COMMAND`, `DISCORD_SETUP_CREDENTIALS`, `NOSTR_PUBLISH_PROFILE`, and `PLACE_CALL`. | Even if runtime action lists are cleaned up, generated docs and repair/context hints can reintroduce old names into planner prompts or correction logic. | Regenerate action docs after consolidation and add a retired-name lint over generated docs, prompt compaction, context catalogs, and repair maps. |
| `TASKS` has a name collision. | `plugins/app-lifeops/src/actions/scheduled-task.ts` exposes LifeOps scheduled tasks as `TASKS`; `plugins/plugin-agent-orchestrator/src/actions/tasks.ts` also exposes orchestrator tasks as `TASKS`. | Both are large parents with different semantics: personal scheduled tasks vs coding/sub-agent work. If both plugins are active, action selection and promoted virtuals collide. | Rename one. Preferred: `SCHEDULED_TASKS` or `OWNER_TASKS` for LifeOps ScheduledTask CRUD, and reserve `TASKS` for orchestrator only if that is already established. |
| The core repair layer still maps planner aliases to removed LifeOps names. | `packages/core/src/services/message.ts` maps todo/reminder aliases to `LIFE`, profile aliases to `PROFILE`, check-ins to `CHECKIN`, block aliases to `APP_BLOCK`/`WEBSITE_BLOCK`, and defaults still inject `subaction`. | A repair pass can rewrite a correct canonical action into a removed or non-registered action. This is worse than stale docs because it changes runtime behavior. | Update aliases to `OWNER_TODOS`, `OWNER_REMINDERS`, `OWNER_GOALS`, `OWNER_ROUTINES`, `OWNER_HEALTH`, `OWNER_SCREENTIME`, `OWNER_FINANCES`, `BLOCK`, `CALENDAR`, and `PERSONAL_ASSISTANT`; inject `action`, not `subaction`. |
| The LifeOps provider still instructs the planner to use removed actions. | `plugins/app-lifeops/src/providers/lifeops.ts` still says `Use LIFE`, `Use PROFILE`, `Use SCREEN_TIME`, `Use APP_BLOCK`, `Use WEBSITE_BLOCK`, and `Use SUBSCRIPTIONS`, and still names `BOOK_TRAVEL` and `AUTOFILL` in routing guidance. | The planner sees canonical and legacy names in the same context. That defeats the consolidation even if the old actions are not registered. | Rewrite provider text around owner surfaces and provider-backed parents: `OWNER_*`, `BLOCK`, `CREDENTIALS`, `CALENDAR`, `MESSAGE`, `PERSONAL_ASSISTANT`, `CONNECTOR`, `RESOLVE_REQUEST`. |
| `PLACE_CALL` is still a separate exposed action. | `plugins/app-phone/src/plugin.ts` registers `placeCallAction` with name `PLACE_CALL`. | User requested `PLACE_CALL` and `VOICE_CALL` to be a single action with providers. Current split leaves Android phone calls separate from Twilio/owner escalation calls. | Create one `VOICE_CALL` parent with provider/source selection. Register Android/app-phone as a provider or child implementation. |
| `DISCORD_SETUP_CREDENTIALS` is still exposed. | `plugins/plugin-discord/index.ts` registers `setupCredentials`. | User requested connector setup to live under generic `CONNECTOR` and `CREDENTIALS`. A provider-specific credential action creates audit and planner ambiguity. | Move Discord pairing/setup behind `CONNECTOR action=connect/status/verify` and credential requests behind `CREDENTIALS`; keep this as internal compatibility only. |
| `NOSTR_PUBLISH_PROFILE` is still exposed. | `plugins/plugin-nostr/src/index.ts` registers `publishProfile`. | User called this out as generic connector/credentials territory. It is identity metadata, not a planner-level universal action. | Fold into `CONNECTOR` or a future `IDENTITY` provider capability; keep Nostr service-specific code internal. |
| `CALENDLY` remains provider-specific. | `plugins/plugin-calendly/src/index.ts` registers `CALENDLY`. | User wanted calendar providers to register capabilities under the standard calendar surface, with provider-only features marked as provider-only. | Register Calendly capabilities under `CALENDAR` provider metadata where equivalent. Keep true Calendly-only `book/cancel` either as `CALENDAR action=provider_operation provider=calendly` or clearly page-scoped. |
| `LIFEOPS_ACTIONS` and `LIFEOPS_THREAD_CONTROL` preserve the name the user wanted destroyed. | `packages/agent/src/actions/page-action-groups.ts` exposes `LIFEOPS_ACTIONS`; `plugins/app-lifeops/src/actions/work-thread.ts` exposes `LIFEOPS_THREAD_CONTROL`. | Even after removing `LIFE`/`LIFEOPS`, the planner still sees LifeOps as an action namespace. | Rename page group to `OWNER_ACTIONS` or `PERSONAL_ASSISTANT_ACTIONS`; rename thread control to `WORK_THREAD` or `THREAD_CONTROL`. |
| `PROFILE` was removed as an action but the replacement evaluator is not present. | No LifeOps profile/owner-fact response-handler evaluator for stable details, nicknames, handles, or relationship search hints was found. | The user explicitly wanted profile extraction as an evaluator registered to the response handler, not as a planner action. Removing the action without adding the evaluator loses capability. | Add an owner/entity fact evaluator that extracts stable owner facts, nicknames, handles, and relationship aliases into the owner fact/entity stores with auditability. |
| `CHECKIN` is no longer registered, but stale routing still points to it. | Core alias maps and LifeOps default-pack comments still reference `CHECKIN`. | The desired model was "task/workflow/default initialization", not an action. Stale planner hints can still choose it. | Remove planner-facing references and express morning/night check-ins only as default `ScheduledTask` packs and workflow tests. |
| `READ_ATTACHMENT` is implementation-only but still referenced by providers and repair code. | `readAttachmentAction` exists and provider text says "use READ_ATTACHMENT"; no production plugin registration was found. | The planner may be told to call an unavailable action. User also asked for an attachment parent with `READ` and `SAVE_ATTACHMENT_AS_DOCUMENT`. | Add an `ATTACHMENT` parent or register `READ_ATTACHMENT` intentionally. Preferred parent: `ATTACHMENT action=read|save_as_document`, with automatic link extraction still happening outside the action. |
| `PAYMENT` is generic but plugin-local. | `plugins/plugin-mysticism` exposes `PAYMENT action=check|request`. | User wanted `PAYMENT` for agent charging/checking/paying money generally. Mysticism-specific payment status/request squats the generic name. | Rename to `MYSTICISM_PAYMENT`, or move it under a generic `PAYMENT` provider model only after defining the global payment contract. |
| Canonical `action` is not yet normalized across major actions. | Many exposed parents still declare `subaction`, `op`, `operation`, or `verb` as the primary schema field. | The dispatcher accepts aliases, but planner-facing schemas still teach the old names. | Make schema docs and first-class parameters use `action`; keep legacy aliases second and clearly marked. |

## Current Target Ordering

The clean taxonomy should be ordered by who owns the state and side effects:

1. Conversation turn control: `REPLY`, `IGNORE`, `NONE`, `CHOICE`.
2. Cross-channel communications: `MESSAGE`, `POST`, `ROOM`, `CONTACT`, `ENTITY`.
3. Owner operations: `OWNER_REMINDERS`, `OWNER_ALARMS`, `OWNER_GOALS`,
   `OWNER_TODOS`, `OWNER_ROUTINES`, `OWNER_HEALTH`, `OWNER_SCREENTIME`,
   `OWNER_FINANCES`, `CALENDAR`, `BLOCK`, `CREDENTIALS`, `PERSONAL_ASSISTANT`,
   `CONNECTOR`, `RESOLVE_REQUEST`, `VOICE_CALL`.
4. Runtime/admin state: `SETTINGS`, `RUNTIME`, `LOGS`, `DATABASE`, `MEMORY`,
   `TRIGGER`, `WORKFLOW`, `PLUGIN`/`MANAGE_PLUGINS`, secrets/trust actions.
5. Developer tools: `FILE`, `SHELL`, `WORKTREE`, `BROWSER`, `COMPUTER_USE`,
   `MCP`.
6. Provider integrations: `GITHUB`, `LINEAR`, `TUNNEL`, `MUSIC`, `WALLET`,
   `SHOPIFY`, etc.
7. App/game-specific actions: `ROBLOX`, `SCAPE`, `RS_2004`, `MC`,
   `PREDICTION_MARKET`, `PLAY_EMOTE`, etc.

This order matters because it keeps personal owner state separate from generic
runtime state, provider-specific capabilities, and low-level automation.

## Detailed Catalog

### Conversation And Messaging

| Parent | Children | What It Does | Why This Parent And Name | Defects / Opportunities |
|---|---|---|---|---|
| `REPLY` | none | Sends a normal response in the current conversation. | Leaf because it has no external side effect. Name is exact. | Good. |
| `IGNORE` | none | Intentionally emits no response. | Leaf turn-control action. Name is exact. | Good. |
| `NONE` | none | Marks no tool/action work needed. | Leaf no-op action. Name is terse but established. | Good. |
| `CHOICE` | option selection flow | Handles structured choice/selection UI. | Conversation/UI primitive, not a domain side effect. | Good, but action naming is less obvious than `SELECT_OPTION`. |
| `SEND_TO_ADMIN` | none | Sends an autonomy/escalation message to an admin. | Parent is autonomy, but exposed as a leaf because message content carries the operation. | Optional/autonomy only. Consider whether this should be `MESSAGE action=send_draft target=admin`. |
| `MESSAGE` | `send`, `read_channel`, `read_with_contact`, `search`, `list_channels`, `list_servers`, `join`, `leave`, `react`, `edit`, `delete`, `pin`, `get_user`, `triage`, `list_inbox`, `search_inbox`, `draft_reply`, `draft_followup`, `respond`, `send_draft`, `schedule_draft_send`, `manage` | Unified addressed messaging: DMs, channels, rooms, inboxes, drafts, replies, sends, and message management. | Correct parent because all children share message connector accounts, room/thread addressing, and message result semantics. Name is broad but accurate. | Still declares `subaction`/`operation`/`op`; should declare `action`. It also mixes low-level connector ops with assistant workflows. Subgroup docs should explicitly separate connector ops, inbox triage, drafting, and message management. |
| `POST` | `send`, `read`, `search` | Public feed/timeline operations. | Correct sibling of `MESSAGE`: public posts are not addressed messages. Name is short and domain-clear. | Still declares `subaction`. Good parent boundary. |
| `ROOM` | `follow`, `unfollow`, `mute`, `unmute` | Current or named room/chat notification policy. | Parent is room state, not message content. Name fits. | Still declares `subaction`. Stale LifeOps provider references `ROOM_OP`; normalize to `ROOM`. |
| `CONTACT` | `create`, `read`, `search`, `update`, `delete`, `link`, `merge`, `activity`, `followup` | Rolodex contact records, identity links, activity, and contact follow-ups. | Correct parent for contact entity UX. Name is concrete and user-facing. | Overlaps LifeOps `ENTITY` and legacy `RELATIONSHIP`. It declares `subaction`, while `action` is also used for merge accept/reject, which complicates canonical migration. |
| `ENTITY` | `add`, `list`, `log_interaction`, `set_identity`, `set_relationship`, `merge` | LifeOps entity/relationship graph operations. | Correct parent for identity and relationship records when the operation is graph-level rather than contact-list UX. | Registered as an unpromoted parent in LifeOps. Still declares `subaction`. Needs clear boundary with `CONTACT`. |

### Owner Operations And LifeOps

| Parent | Children | What It Does | Why This Parent And Name | Defects / Opportunities |
|---|---|---|---|---|
| `OWNER_REMINDERS` | `create`, `update`, `delete`, `complete`, `skip`, `snooze`, `review` | Owner reminders backed by LifeOps definitions/ScheduledTask flows. | Good parent: owner-specific reminder UX. Name is explicit and avoids vague `LIFE`. | Delegates to legacy `lifeAction` internally and injects both `action` and `subaction`. That is acceptable during migration but should be retired. |
| `OWNER_ALARMS` | `create`, `update`, `delete`, `complete`, `skip`, `snooze`, `review` | Alarm-like reminders. | Good parent because alarms have distinct user intent from generic reminders even if the backing model is shared. | Same legacy delegation caveat as `OWNER_REMINDERS`. |
| `OWNER_GOALS` | `create`, `update`, `delete`, `review` | Long-term owner goals and progress review. | Good parent because goals are durable aspirations/progress records, not transient tasks. | Internal backing kind is `goal`; expose that only as an implementation detail. |
| `OWNER_TODOS` | `create`, `update`, `delete`, `complete`, `skip`, `snooze`, `review` | Personal todos/tasks for the owner. | Good parent because it separates personal tasks from orchestrator/coding tasks. | Collision pressure from core advanced todo leaves and `plugin-todos` `TODO`. Need routing priority docs. |
| `OWNER_ROUTINES` | `create`, `update`, `delete`, `complete`, `skip`, `snooze`, `review`, `schedule_summary`, `schedule_inspect` | Daily habits/routines plus passive schedule inspection. | Parent is owner routines/habits. Name is good. | `schedule_summary` and `schedule_inspect` are read-only schedule inference, not routine CRUD. Consider a separate `OWNER_SCHEDULE` or `SCHEDULE_INFERENCE` child under `OWNER_ROUTINES` only if it truly helps routine management. |
| `OWNER_HEALTH` | `today`, `trend`, `by_metric`, `status` | Health/wearable telemetry reads. | Correct owner-scoped health parent. Name is clear and avoids generic app/plugin `HEALTH`. | Inherits `healthAction` schema with `subaction`; should expose `action`. |
| `OWNER_SCREENTIME` | `summary`, `today`, `weekly`, `weekly_average_by_app`, `by_app`, `by_website`, `activity_report`, `time_on_app`, `time_on_site`, `browser_activity` | Screen/app/site usage analytics. | Correct owner telemetry parent. Name is clear. | Inherits `screenTimeAction` schema with `subaction`; should expose `action`. |
| `OWNER_FINANCES` | `dashboard`, `list_sources`, `add_source`, `remove_source`, `import_csv`, `list_transactions`, `spending_summary`, `recurring_charges`, `subscription_audit`, `subscription_cancel`, `subscription_status` | Owner financial sources, transactions, recurring charges, and subscription audit/cancel/status. | Better than `MONEY`: owner scope and finance domain are explicit. | Still inherits `moneyAction` schema with `subaction`. Also conflates financial subscriptions and email subscriptions. Email unsubscribe should stay under `MESSAGE manage` or an email-specific capability. |
| `BLOCK` | `block`, `unblock`, `status`, `request_permission`, `release`, `list_active`; target is `app` or `website` | Consolidated app/website blocking. | Correct parent because block lifecycle, permissioning, confirmation, and active-rule state are shared. | Good consolidation. Stale provider/repair text still points to `APP_BLOCK`/`WEBSITE_BLOCK`; fix those references. |
| `CREDENTIALS` | `fill`, `whitelist_add`, `whitelist_list`, `search`, `list`, `inject_username`, `inject_password` | Browser autofill, password manager lookup, and credential injection. | Correct parent for credential handling. Name is broad enough for setup and use. | Still declares `subaction`. `DISCORD_SETUP_CREDENTIALS` and Nostr profile setup have not been folded into it. |
| `CALENDAR` | `feed`, `next_event`, `search_events`, `create_event`, `update_event`, `delete_event`, `trip_window`, `bulk_reschedule`, `check_availability`, `propose_times`, `update_preferences` | Owner calendar reads/writes, availability, meeting options, travel windows, and preferences. | Correct parent because all children depend on calendar providers or scheduling preferences. | Still declares `subaction`. Calendly remains a separate exposed action instead of registering provider capabilities. |
| `PERSONAL_ASSISTANT` | `book_travel`, `scheduling` | Travel booking and scheduling negotiation workflows. | Correct parent for assistant workflows that are broader than CRUD over a single store. Name is broad but acceptable because children are explicit. | This is the replacement for `BOOK_TRAVEL` and `SCHEDULING_NEGOTIATION`, but old provider text still names the old actions. Scheduling workflow may still be too many hidden steps; surface state/provider info more clearly. |
| `CONNECTOR` | `connect`, `disconnect`, `verify`, `status`, `list` | Owner/agent connector account lifecycle. | Correct parent for external account connection state. Name is clear and should own provider setup. | Still declares `subaction`. Discord/Nostr/Calendly still expose provider-specific action surfaces. |
| `RESOLVE_REQUEST` | `approve`, `reject` | Owner approval queue decisions. | Correct parent for approval resolution. Name says what it does. | Still declares `subaction`. Good boundary. |
| `VOICE_CALL` | `dial` | Voice call drafting/confirmation, currently Twilio-oriented. | Correct parent if multiple voice providers become children/providers. | Still declares `subaction`. `PLACE_CALL` remains separate; provider unification is incomplete. |
| `REMOTE_DESKTOP` | `start`, `status`, `end`, `list`, `revoke` | Remote session lifecycle. | Correct session parent, but user wanted `app-remote-desktop` with app interface. | Still under LifeOps, not clearly app-scoped. Name is okay; package boundary is questionable. |
| `LIFEOPS_THREAD_CONTROL` | operation array: `create`, `steer`, `stop`, `mark_waiting`, `mark_completed`, `merge`, `attach_source`, `schedule_followup` | Work-thread lifecycle control. | Conceptually parent is work threads, not LifeOps. | Rename to `WORK_THREAD` or `THREAD_CONTROL`. The operation array is powerful but less planner-friendly than a normal `action` discriminator. |
| `TASKS` in LifeOps | `list`, `get`, `create`, `update`, `snooze`, `skip`, `complete`, `acknowledge`, `dismiss`, `cancel`, `reopen`, `history` | Direct CRUD/state control over the one `ScheduledTask` primitive. | Architecturally correct per AGENTS.md: reminders, check-ins, follow-ups, watchers, recaps, approvals, and outputs all share `ScheduledTask`. | Name collides with orchestrator `TASKS`. Prefer `SCHEDULED_TASKS` or `OWNER_TASKS`; keep `ScheduledTask` as implementation contract. |

### Runtime, Admin, Secrets, And Settings

| Parent | Children | What It Does | Why This Parent And Name | Defects / Opportunities |
|---|---|---|---|---|
| `SETTINGS` | `update_ai_provider`, `toggle_capability`, `toggle_training`, `set_owner_name`, `set` | Owner-only settings mutations. | Correct parent for runtime/world settings. Name is clear. | Uses canonical `action`. Good. Add `list` and `read` if users need discovery; current set is write-heavy. |
| `TRIGGER` | `create`, `update`, `delete`, `run`, `toggle` | Scheduled/trigger task lifecycle in the agent app. | Correct parent for trigger records. | Still declares `subaction`. Boundary with `WORKFLOW` and LifeOps `ScheduledTask` needs explicit docs. |
| `WORKFLOW` | `create`, `modify`, `activate`, `deactivate`, `toggle_active`, `delete`, `executions` | Workflow definitions and executions. | Correct parent for durable workflow records. | Uses `op`, not `action`. Should be normalized. |
| `RUNTIME` | `status`, `self_status`, `describe_actions`, `reload_config`, `restart` | Runtime/process introspection and control. | Correct parent for runtime state. | Still declares `subaction`. Good action grouping. |
| `LOGS` | `search`, `delete`, `set_level` | Log search, deletion, and log-level mutation. | Correct parent for logs. | Still declares `subaction`; destructive `delete` should stay tightly gated. |
| `DATABASE` | `list_tables`, `get_table`, `query`, `search_vectors` | Database inspection/query. | Correct parent for DB state. | Still declares `subaction`. Make read-only/write policy explicit everywhere it is exposed. |
| `MEMORY` | `create`, `search`, `update`, `delete` | Agent memory CRUD. | Correct parent for memory store operations. | Still declares `subaction`/`op`. Needs confirmation or role-gate clarity for destructive ops. |
| `PLUGIN` | `install`, `uninstall`, `update`, `sync`, `eject`, `reinject`, `configure`, `read_config`, `toggle`, `list`, `disconnect` | Agent package/connector plugin management. | Correct parent for agent plugin lifecycle. | Still declares `subaction`. Overlaps core `MANAGE_PLUGINS`; decide which one is canonical. |
| `MANAGE_PLUGINS` | `install`, `eject`, `sync`, `reinject`, `list`, `list_ejected`, `search`, `details`, `status`, `enable`, `disable`, `core_status`, `create` | Core plugin manager operations. | Correct core-admin parent. Name is explicit. | Still declares `subaction`. Collision/overlap with `PLUGIN` should be resolved or documented. |
| `SET_SECRET` | none | Stores secrets/API keys. | Leaf because the side effect is singular and the payload contains the keys. | Good, but could be `CREDENTIALS action=set_secret` if unifying all credentials. |
| `MANAGE_SECRET` | `get`, `set`, `delete`, `list`, `check` | Secrets CRUD/check. | Correct parent for secret store operations. | Still declares `subaction`/`operation`; overlaps `SET_SECRET`. |
| `REQUEST_SECRET` | none | Requests a missing secret. | Leaf because request content carries target secret. | Good. |
| `SECRETS_UPDATE_SETTINGS` | none | Onboarding settings update. | Leaf onboarding action. | Similar to `SETTINGS action=set`; consider folding once onboarding flow is no longer special. |
| `TRUST_UPDATE_ROLE` | none | Trust/security role assignments. | Leaf because payload is role assignment array. | Boundary overlaps `ROLE`. Keep trust role model distinct from chat role model in docs. |
| `EVALUATE_TRUST` | none | Reads trust profile/score for entity. | Leaf read operation. | Good. |
| `REQUEST_ELEVATION` | none | Requests temporary permission elevation. | Leaf workflow. | Parameter named `action` means "action needing elevation", not subaction; avoid confusing migration tooling. |
| `RECORD_TRUST_INTERACTION` | none | Records trust evidence. | Leaf because evidence type/data carries operation. | Good. |

### Documents, Attachments, And Knowledge

| Parent | Children | What It Does | Why This Parent And Name | Defects / Opportunities |
|---|---|---|---|---|
| `DOCUMENT` | `list`, `search`, `read`, `write`, `edit`, `delete`, `import_file`, `import_url` | Stored document CRUD/import. | Correct parent because all children operate on the document store. | Still declares `subaction`. Good grouping. |
| `READ_ATTACHMENT` | none; desired `ATTACHMENT action=read|save_as_document` | Reads current/recent attachments and link previews. | Current leaf name is direct, but attachments are a domain, not just read. | Not registered in production action lists found, while providers still reference it. Add `ATTACHMENT` parent or register intentionally. |
| `GENERATE_MEDIA` | media type parameter | Generates image/video/audio media. | Parent is media generation, not specific file/document storage. | Good leaf/parameter shape. |
| `VISION` | `describe`, `capture`, `set_mode`, `name_entity`, `identify_person`, `track_entity` | Camera/screen scene analysis and entity tracking. | Correct parent for live visual perception. | Still declares `subaction`. User wanted posted images analyzed automatically; this action may still be useful for live camera/screen, but automatic attachment image analysis should not require planner action. |

### Developer Tools, Browser, Desktop, And MCP

| Parent | Children | What It Does | Why This Parent And Name | Defects / Opportunities |
|---|---|---|---|---|
| `FILE` | `read`, `write`, `edit`, `grep`, `glob`, `ls` | File-system coding operations. | Correct parent because all children share path policy, cwd handling, and file-state service. Name is simple and canonical. | Good consolidation. Old leaf files remain implementation-only. |
| `SHELL` | none | Runs shell commands. | Correct leaf because the command string is the operation. | Coding-tools is canonical, but agent still exposes `SHELL_COMMAND`. |
| `WORKTREE` | `enter`, `exit` | Git worktree/session cwd transitions. | Correct parent because enter/exit are a lifecycle pair over the same state. | Good consolidation. Old `ENTER_WORKTREE`/`EXIT_WORKTREE` files remain implementation-only. |
| `SHELL_COMMAND` | none | Runs a shell command through older agent terminal API. | Parent is functionally identical to `SHELL`; name is legacy and inconsistent. | Should be removed or renamed to `SHELL`. |
| `BROWSER` | `back`, `click`, `close`, `context`, `forward`, `get`, `get_context`, `hide`, `info`, `list_tabs`, `navigate`, `open`, `open_tab`, `press`, `reload`, `screenshot`, `show`, `snapshot`, `state`, `tab`, `type`, `wait`, `close_tab`, `switch_tab`, `realistic_click`, `realistic_fill`, `realistic_type`, `realistic_press`, `cursor_move`, `cursor_hide`, `autofill_login` | Browser tab/page/workspace control. | Correct parent: all children operate on a browser target. | Schema still exposes both `action` and `subaction` and explicitly says "prefer subaction"; update to canonical `action`. Very large set needs subgroup examples: navigation, DOM input, screenshots/state, tabs, cursor realism, autofill. |
| `MANAGE_BROWSER_BRIDGE` | `install`, `reveal_folder`, `open_manager`, `refresh` | Browser companion/extension setup. | Correctly separate from `BROWSER` because it manages infrastructure, not page content. | Still declares `subaction`; maybe `BROWSER_BRIDGE action=...` would be clearer. |
| `COMPUTER_USE` | screenshot/click/key/type/scroll/drag/detect/ocr-style GUI ops | Direct GUI control. | Correct parent for desktop interaction primitives. | Uses `action` already. Good. |
| `DESKTOP` | `file`, `window`, `terminal` plus reserved `screenshot`, `ocr`, `detect_elements` | Desktop operation grouping over computer-use file/window/terminal handlers. | Parent is too broad and overlaps `FILE`, `SHELL`, `COMPUTER_USE`. | Still declares `subaction` and nested `action`. Reassess exposure; maybe collapse into existing parents. |
| `MCP` | `call_tool`, `read_resource`, `search_actions`, `list_connections` | MCP server tool/resource routing. | Correct parent because all children share MCP server/connection registry. | Still declares `subaction`; normalize. |

### Agent Orchestration And Skills

| Parent | Children | What It Does | Why This Parent And Name | Defects / Opportunities |
|---|---|---|---|---|
| `TASKS` in agent-orchestrator | `create`, `spawn_agent`, `send`, `stop_agent`, `list_agents`, `cancel`, `history`, `control`, `share`, `provision_workspace`, `submit_workspace`, `manage_issues`, `archive`, `reopen` | Coding/sub-agent task lifecycle, ACP sessions, workspaces, issue management, and history. | Parent is orchestrator task state. Name is acceptable only if not shared with owner todo/reminder tasks. | Uses `subaction` and nested `action`; conflicts with LifeOps `TASKS`. Consider `AGENT_TASKS` or reserve `TASKS` here and rename LifeOps. |
| `SKILL` | `search`, `details`, `sync`, `toggle`, `install`, `uninstall` | Skill catalog and install-state management. | Correct parent for skill registry state. | Still declares `subaction`. Good separation from `USE_SKILL`. |
| `USE_SKILL` | mode parameter: `guidance`, `script`, `auto` | Invokes an installed/enabled skill. | Correct separate leaf because using a skill is not catalog management. | Good. |

### External Work Providers

| Parent | Children | What It Does | Why This Parent And Name | Defects / Opportunities |
|---|---|---|---|---|
| `GITHUB` | PR ops `list`, `review`; issue ops `create`, `assign`, `close`, `reopen`, `comment`, `label`; notification triage | GitHub pull request, issue, and notification work. | Correct parent because one provider/account/service owns all GitHub work. | Good consolidation. Legacy `GITHUB_PR_OP`, `GITHUB_ISSUE_OP`, `GITHUB_NOTIFICATION_TRIAGE` remain implementation-only. |
| `LINEAR` | `create_issue`, `get_issue`, `update_issue`, `delete_issue`, `create_comment`, `update_comment`, `delete_comment`, `list_comments`, `get_activity`, `clear_activity`, `search_issues` | Linear issues, comments, activity, and search. | Correct parent for one provider/account boundary. | Uses canonical `action`. Legacy `LINEAR_ISSUE`, `LINEAR_COMMENT`, `LINEAR_WORKFLOW` remain implementation-only and okay if not registered. |
| `SHOPIFY` | `search`, `products`, `inventory`, `orders`, `customers` | Shopify store search and management reads/writes. | Correct provider parent. Name is clear. | Still declares `subaction`. Children are nouns rather than verbs; acceptable if second-stage parameters are clear. |
| `CALENDLY` | `book`, `cancel` | Calendly booking handoff and cancellation. | Provider-specific parent; name is accurate but not canonical in the desired calendar architecture. | Fold under `CALENDAR` provider registration or mark as provider-only page action. |
| `DISCORD_SETUP_CREDENTIALS` | none | Discord credential pairing/setup. | Leaf name describes implementation, not canonical capability. | Fold into `CONNECTOR`/`CREDENTIALS`. |
| `NOSTR_PUBLISH_PROFILE` | none | Publish Nostr profile metadata. | Provider-specific identity mutation. | Fold into connector/identity provider capability. |

### Finance, Wallet, Payments, And Markets

| Parent | Children | What It Does | Why This Parent And Name | Defects / Opportunities |
|---|---|---|---|---|
| `WALLET` | `transfer`, `swap`, `bridge`, `gov`; nested governance `op=propose|vote|queue|execute` | Token transfers, swaps, bridging, and governance across chain handlers. | Correct parent because wallet risk, chain routing, and signing policy are shared. | Still declares `subaction` and nested `op`. High-risk side effects need prepare/execute clarity. |
| `TOKEN_INFO` | `search`, `token`, `trending`, `new-pairs`, `chain-pairs`, `boosted`, `profiles`, `wallet` | Read-only crypto token/market/wallet analytics. | Correct separate parent because it is read-only analytics, not wallet mutation. | Still declares `subaction`; kebab-case children should be normalized or aliased to snake_case. |
| `LIQUIDITY` | `onboard`, `list_pools`, `open`, `close`, `reposition`, `list_positions`, `get_position`, `set_preferences` | LP/liquidity position management. | Correct parent because LP positions are not simple token transfers. | Still declares `subaction`. Only exposed if LP manager plugin is loaded separately. |
| `PREDICTION_MARKET` | `read`, `place-order` | Polymarket/public prediction market reads and readiness for order placement. | Correct parent because provider target can vary; current target is Polymarket. | Still declares `subaction`; `place-order` should be `place_order`. Signed placement is disabled, so name should not overpromise. |
| `PAYMENT` in mysticism | `check`, `request` | Payment status/request for an active reading session. | Plugin-local parent, but globally generic name. | Rename or move under a global `PAYMENT` contract. |
| `OWNER_FINANCES` | listed above | Owner spending/subscriptions. | Owner finance parent. | Do not use `PAYMENT` here unless the action actually moves/charges money. |

### Music, Media, And Streaming

| Parent | Children | What It Does | Why This Parent And Name | Defects / Opportunities |
|---|---|---|---|---|
| `MUSIC` | `playlist`, `play_query`, `search_youtube`, `download`, `pause`, `resume`, `skip`, `stop`, `queue`, `play_audio`, `routing`, `zones` | Music library, discovery, playback, queue, routing, and zones. | Correct user-facing parent. Name is clear. | Good consolidation. Internally broad; subgroup docs should separate library/search, playback, queue, routing, zones. |
| `MUSIC_GENERATION` | `generate`, `custom`, `extend` | Suno music generation. | Separate from `MUSIC` playback/library because it creates new audio. | Still declares `subaction`. Could be `MUSIC action=generate` if a single music taxonomy is desired. |
| `STREAM` in streaming plugin | `start`, `stop`, `status` with platform | RTMP streaming lifecycle across platforms. | Correct parent for live streaming provider lifecycle. | Still declares `subaction`. There is also an agent `STREAM` action with `go_live`/`go_offline`; ensure they are not both exposed in the same runtime. |
| `PLAY_EMOTE` | none | Plays a companion avatar emote. | Leaf because one app-scoped side effect. | It is gated by app-companion session, which satisfies the "only when companions are running" direction. Could be renamed under `COMPANION action=play_emote` if more companion actions appear. |

### Network, Browser Infrastructure, And Tunnels

| Parent | Children | What It Does | Why This Parent And Name | Defects / Opportunities |
|---|---|---|---|---|
| `TUNNEL` | `start`, `stop`, `status` | Generic tunnel lifecycle. | Correct parent because ngrok, Tailscale, and Eliza Cloud/headscale should be providers. | Uses canonical `action`. Good. |
| `TAILSCALE` | `start`, `stop` | Tailscale-specific tunnel control. | Provider-specific implementation. | No longer registered by `plugin-tailscale`; keep implementation-only or remove. |
| `START_TUNNEL` / `STOP_TUNNEL` / `GET_TUNNEL_STATUS` | none | Ngrok-style legacy leaves. | Provider-specific implementation leaves. | No longer registered by `plugin-ngrok`; keep internal only or remove. |

### Apps And Games

| Parent | Children | What It Does | Why This Parent And Name | Defects / Opportunities |
|---|---|---|---|---|
| `ROBLOX` | `message`, `execute`, `get_player` | Roblox bridge messaging/execution/player lookup. | Correct provider/app parent. Name is now clean. | Uses canonical `action`. Good. |
| `SCAPE` | `walk_to`, `attack`, `chat_public`, `eat`, `drop`, `set_goal`, `complete_goal`, `remember` | Scape game/autonomy actions. | Correct app/game parent. | Still declares `subaction`; app-specific and okay. |
| `RS_2004` | `walk_to`, `chop`, `mine`, `fish`, `burn`, `cook`, `fletch`, `craft`, `smith`, `drop`, `pickup`, `equip`, `unequip`, `use`, `use_on_item`, `use_on_object`, `open`, `close`, `deposit`, `withdraw`, `buy`, `sell`, `attack`, `cast_spell`, `set_style`, `eat`, `talk`, `navigate_dialog`, `interact_object`, `open_door`, `pickpocket` | 2004Scape SDK/game operations. | Correct app/game parent. | Still declares `subaction`; large but natural for game commands. |
| `MC` | `connect`, `disconnect`, `goto`, `stop`, `look`, `control`, `waypoint_goto`, `dig`, `place`, `chat`, `attack`, `waypoint_set`, `waypoint_delete` | Minecraft bot control. | Correct app/game parent. | Still declares `subaction`. Consider `MINECRAFT` over `MC` for audit readability. |
| `PLACE_CALL` | none | Android/app-phone outbound call placement. | Current app-phone leaf; name is clear but not canonical. | Must merge with `VOICE_CALL` provider model. |

## Implementation-Only Leftovers

These are present in source but are not registered by the current owning plugin
registration found in this pass. They are less urgent unless prompt text,
repair code, exports, or external consumers still route to them.

| Area | Implementation-only names | Current canonical exposure | Notes |
|---|---|---|---|
| Coding tools | `READ`, `WRITE`, `EDIT`, `GREP`, `GLOB`, `LS`, `WEB_FETCH`, `ASK_USER_QUESTION`, `ENTER_WORKTREE`, `EXIT_WORKTREE` | `FILE`, `SHELL`, `WORKTREE` | Good consolidation. Remove stale docs if any still advertise leaves. |
| GitHub | `GITHUB_PR_OP`, `GITHUB_ISSUE_OP`, `GITHUB_NOTIFICATION_TRIAGE` | `GITHUB` | Good consolidation. |
| Linear | `LINEAR_ISSUE`, `LINEAR_COMMENT`, `LINEAR_WORKFLOW`, plus leaf helpers | `LINEAR` | Good consolidation. |
| Tunnel providers | `TAILSCALE`, `START_TUNNEL`, `STOP_TUNNEL`, `GET_TUNNEL_STATUS` | `TUNNEL` | Good consolidation; provider plugins now register no actions. |
| Music | `MUSIC_LIBRARY`, `PLAY_AUDIO`, `MANAGE_ROUTING`, `MANAGE_ZONES`, playback/library leaves | `MUSIC` | Good consolidation. |
| Form | `FORM_RESTORE` | none | Removed from plugin action list; evaluator/service remains. |
| LifeOps old public actions | `LIFE`, `PROFILE`, `RELATIONSHIP`, `MONEY`, `PAYMENTS`, `SUBSCRIPTIONS`, `HEALTH`, `SCREEN_TIME`, `SCHEDULE`, `BOOK_TRAVEL`, `SCHEDULING_NEGOTIATION`, `FIRST_RUN`, `TOGGLE_FEATURE`, `DEVICE_INTENT`, `MESSAGE_HANDOFF`, `APP_BLOCK`, `WEBSITE_BLOCK`, `AUTOFILL`, `PASSWORD_MANAGER` | `OWNER_*`, `BLOCK`, `CREDENTIALS`, `CALENDAR`, `PERSONAL_ASSISTANT`, `TASKS`, `CONNECTOR`, etc. | The problem is not the files; the problem is stale provider text and core repair aliases still naming several of these. |
| Core/agent removed leaves | `EXTRACT_PAGE`, `QUERY_TRAJECTORIES`, `SKILL_COMMAND`, `ANALYZE_IMAGE` | Browser/document/vision/skill surfaces | Removed from default agent registration. Verify no provider text still routes to them. |

## Discriminator Normalization Status

`packages/core/src/actions/subaction-dispatch.ts` now defines `action` as the
canonical discriminator and accepts `subaction`, `op`, `operation`, `verb`,
`subAction`, and `__subaction` as aliases. That helper change is correct, but
schema normalization is incomplete.

Already aligned or mostly aligned:

- `FILE`
- `WORKTREE`
- `SETTINGS`
- `LINEAR`
- `GITHUB`
- `TUNNEL`
- `MUSIC`
- `ROBLOX`
- `OWNER_REMINDERS`
- `OWNER_ALARMS`
- `OWNER_GOALS`
- `OWNER_TODOS`
- `OWNER_ROUTINES`
- `PERSONAL_ASSISTANT`
- LifeOps `TASKS`

Still teaching old discriminators in public schemas:

- Core: `MESSAGE`, `POST`, `ROOM`, `ROLE`, `CHARACTER`, `DOCUMENT`,
  `MANAGE_PLUGINS`, `MANAGE_SECRET`.
- Agent: `CONTACT`, `TRIGGER`, `LOGS`, `RUNTIME`, `DATABASE`, `MEMORY`,
  `PLUGIN`.
- Browser/desktop: `BROWSER`, `MANAGE_BROWSER_BRIDGE`, `DESKTOP`, `MCP`,
  `WORKFLOW`.
- LifeOps: `BLOCK`, `CREDENTIALS`, `CALENDAR`, `CONNECTOR`, `ENTITY`,
  `RESOLVE_REQUEST`, `VOICE_CALL`, `REMOTE_DESKTOP`, `OWNER_HEALTH`,
  `OWNER_SCREENTIME`, `OWNER_FINANCES`.
- Providers/plugins: `SKILL`, `TASKS` orchestrator, `TODO`, `CALENDLY`,
  `SHOPIFY`, `WALLET`, `TOKEN_INFO`, `LIQUIDITY`, `PREDICTION_MARKET`,
  `PAYMENT`, `READING`, `VISION`, `MUSIC_GENERATION`, `SCAPE`, `RS_2004`,
  `MC`, `STREAM`.

## Recommended Fix Sequence

1. Fix stale routing metadata first: `packages/core/src/services/message.ts`,
   `plugins/app-lifeops/src/providers/lifeops.ts`, and page action group names.
2. Resolve hard collisions: `TASKS` vs `TASKS`, `SHELL_COMMAND` vs `SHELL`,
   `PLACE_CALL` vs `VOICE_CALL`, `PAYMENT` generic naming.
3. Implement the missing profile/relationship evaluator replacement before
   deleting remaining `PROFILE` assumptions.
4. Normalize schemas to `action` in high-traffic parents: `MESSAGE`, `BROWSER`,
   `CONTACT`, `CALENDAR`, `BLOCK`, `CREDENTIALS`, `CONNECTOR`, `TASKS`
   orchestrator, `WORKFLOW`, `MCP`.
5. Fold provider-specific setup actions into provider registries:
   Discord/Nostr/Calendly/phone call providers.
6. Add a static audit test that fails when registered action names include
   known retired names or when a schema exposes `subaction`, `op`, `operation`,
   or `verb` without an `action` parameter.
