# Action and Subaction Structure Audit - 2026-05-10

Scope: production action surfaces under `packages/core/src`, `packages/agent/src`,
and `plugins/`, excluding benchmark fixtures, examples-only datasets, templates,
`dist`, `node_modules`, and `packages/app`.

This is now a post-consolidation report. The original high-priority defects in
this audit have been fixed or converted to compatibility-only aliases. The
planner-facing rule is:

- The canonical child discriminator is `action`.
- Legacy aliases (`subaction`, `op`, `operation`, `verb`, `subAction`,
  `__subaction`) may remain accepted by handlers, but any generated or public
  schema that exposes one of them must also expose `action`.
- Retired parent actions must not appear in generated canonical action docs.
- Implementation-only compatibility files may remain if they are not registered
  and are not advertised to the planner.

## Completed Targets

| Target | Current Status | Guard |
|---|---|---|
| Destroy public `LIFEOPS`/`LIFE` namespace | Planner-facing surfaces are `OWNER_*`, `PERSONAL_ASSISTANT`, `BLOCK`, `CREDENTIALS`, `CALENDAR`, `ENTITY`, `SCHEDULED_TASKS`, `WORK_THREAD`, and `CONNECTOR`. | `plugins/app-lifeops/test/action-structure-audit.test.ts` |
| Break up LifeOps into owner surfaces | `OWNER_REMINDERS`, `OWNER_ALARMS`, `OWNER_GOALS`, `OWNER_TODOS`, `OWNER_HEALTH`, `OWNER_SCREENTIME`, `OWNER_ROUTINES`, and `OWNER_FINANCES` are registered and promoted. | LifeOps action-gating integration test |
| Keep one task primitive | LifeOps task lifecycle remains `ScheduledTask`; the public parent is `SCHEDULED_TASKS`. No new task store was added. | Scheduled task action tests |
| Rename colliding `TASKS` | LifeOps `TASKS` became `SCHEDULED_TASKS`; orchestrator `TASKS` is no longer collided by LifeOps. | Subaction-promotion test |
| Merge app/website blocking | `BLOCK action=block|unblock|status|request_permission|release|list_active` with `target=app|website`. `APP_BLOCK` and `WEBSITE_BLOCK` are similes only. | LifeOps action-gating integration test |
| Replace `MONEY`/`PAYMENTS`/`SUBSCRIPTIONS` | `OWNER_FINANCES` owns finance, recurring charge, and subscription audit/cancel/status flows. | LifeOps action-gating integration test |
| Separate global payments from plugin payments | Mysticism payment action is `MYSTICISM_PAYMENT`; generic `PAYMENT` is not advertised. | Generated-doc retired-name guard |
| Normalize calendar parent | LifeOps exposes `CALENDAR`; `GOOGLE_CALENDAR` and Calendly-specific planner actions are retired from generated docs. | Generated-doc retired-name guard |
| Merge call placement | Public calling parent is `VOICE_CALL action=dial`; `PLACE_CALL` is not advertised. | LifeOps action-gating integration test |
| Move profile into evaluator | Profile extraction is handled by the LifeOps response-handler evaluator, not a `PROFILE` action. | LifeOps plugin registration guard |
| Remove check-in as action | `CHECKIN` is not generated or registered; check-ins are default/task workflow material. | Generated-doc retired-name guard |
| Normalize attachment reads | `ATTACHMENT action=read|save_as_document` replaces `READ_ATTACHMENT`. | Generated-doc retired-name guard |
| Merge file leaves | `FILE action=read|write|edit|grep|glob|ls`; old `READ`, `WRITE`, `EDIT`, `GREP`, `GLOB`, and `LS` names are not advertised. | Generated-doc retired-name guard |
| Normalize shell | `SHELL` is canonical; `SHELL_COMMAND` is retired from generated docs. | Generated-doc retired-name guard |
| Merge GitHub/Linear leaves | `GITHUB` and `LINEAR` own their provider subactions. | Generated-doc retired-name guard |
| Generic tunnel parent | `TUNNEL action=start|stop|status`; ngrok/Tailscale leaf actions are retired from generated docs. | Generated-doc retired-name guard |
| Music consolidation | `MUSIC` owns playback/library/routing/zones; `MUSIC_GENERATION` remains separate because it creates new audio. | Generated-doc discriminator guard |
| Canonical discriminator | Every generated schema with a legacy discriminator now also exposes `action`. | `packages/core/src/__tests__/action-structure-audit.test.ts` |

## Current Ordering

The taxonomy is ordered by ownership of state and side effects:

1. Conversation turn control: `REPLY`, `IGNORE`, `NONE`, `CHOOSE_OPTION`.
2. Channel communication: `MESSAGE`, `POST`, room-follow leaves, `CONTACT`
   where available, and LifeOps `ENTITY`.
3. Owner operations: `OWNER_*`, `CALENDAR`, `BLOCK`, `CREDENTIALS`,
   `PERSONAL_ASSISTANT`, `RESOLVE_REQUEST`, `VOICE_CALL`, `CONNECTOR`,
   `SCHEDULED_TASKS`, `WORK_THREAD`, `REMOTE_DESKTOP`.
4. Runtime/admin: settings, roles, secrets, plugin management, runtime/log/db
   surfaces.
5. Developer tools: `FILE`, `SHELL`, `WORKTREE`, `BROWSER`, `COMPUTER_USE`,
   `DESKTOP`, `MCP`.
6. Provider integrations: `GITHUB`, `LINEAR`, `SHOPIFY`, `TUNNEL`, `MUSIC`,
   `LIQUIDITY`, `MYSTICISM_PAYMENT`, etc.
7. App/game-specific actions: `SCAPE`, `RS_2004`, `PLAY_EMOTE`, etc.

This ordering prevents vague owner-state actions from competing with provider
actions, low-level automation, and game/app command surfaces.

## Detailed Canonical Catalog

### Conversation And Messaging

| Parent | Child Actions | What It Does | Why This Parent / Grouping |
|---|---|---|---|
| `REPLY` | none | Responds in the current chat. | Leaf turn-control action; no external side effect beyond the current response. |
| `IGNORE` | none | Intentionally emits no response. | Leaf no-op for direct conversational control. |
| `NONE` | none | Marks that no tool/action work is needed. | Default no-op action for planner clarity. |
| `CHOOSE_OPTION` | selected option payload | Selects an option for a pending choice flow. | Choice state belongs to the current conversation, not a provider. |
| `MESSAGE` | `send`, `read_channel`, `read_with_contact`, `search`, `list_channels`, `list_servers`, `join`, `leave`, `react`, `edit`, `delete`, `pin`, `get_user`, `triage`, `list_inbox`, `search_inbox`, `draft_reply`, `draft_followup`, `respond`, `send_draft`, `schedule_draft_send`, `manage` | Addressed messaging across DMs, rooms, channels, inboxes, drafts, and message management. | Parent is correct because all children share connector accounts, room/thread/message addressing, and addressed-message semantics. Public feed publishing is excluded and belongs to `POST`. |
| `POST` | `send`, `read`, `search` | Public feed and timeline operations. | Separate from `MESSAGE` because public posts are not addressed conversations. |
| `FOLLOW_ROOM`, `UNFOLLOW_ROOM`, `MUTE_ROOM`, `UNMUTE_ROOM` | none | Room participation and notification posture. | Leaves remain because each mutates one clear room-state flag. |
| `SCHEDULE_FOLLOW_UP` | payload-driven | Schedules a follow-up reminder for a contact. | Kept as a focused compatibility leaf in core; owner/LifeOps follow-up cadence is otherwise represented through `SCHEDULED_TASKS` and owner surfaces. |
| `ENTITY` | `add`, `list`, `log_interaction`, `set_identity`, `set_relationship`, `merge` | LifeOps entity and relationship graph operations. | Parent is graph-level identity state, separate from message delivery and separate from the `CONTACT` UX surface. |

### Owner Operations

| Parent | Child Actions | What It Does | Why This Parent / Grouping |
|---|---|---|---|
| `OWNER_REMINDERS` | `create`, `update`, `delete`, `complete`, `skip`, `snooze`, `review` | Owner reminders backed by the LifeOps task architecture. | Named by owner scope and reminder intent. Children are lifecycle operations over the same reminder abstraction. |
| `OWNER_ALARMS` | `create`, `update`, `delete`, `complete`, `skip`, `snooze`, `review` | Alarm-like owner reminders. | Alarms have distinct user intent but share the same lifecycle verbs as reminders. |
| `OWNER_GOALS` | `create`, `update`, `delete`, `complete`, `skip`, `snooze`, `review` | Durable owner goals and reviews. | Goal state is owner-owned and durable, so it should not live under generic `LIFE`. |
| `OWNER_TODOS` | `create`, `update`, `delete`, `complete`, `skip`, `snooze`, `review` | Personal owner todos. | Separates personal task management from orchestrator/coding `TASKS` and the generic `TODO` plugin. |
| `OWNER_ROUTINES` | `create`, `update`, `delete`, `complete`, `skip`, `snooze`, `review`, `schedule_summary`, `schedule_inspect` | Daily habits/routines and schedule-aware routine inspection. | Routines are owner-owned recurring behavior; schedule inspection is grouped here because it supports routine planning. |
| `OWNER_HEALTH` | `today`, `trend`, `by_metric`, `status` | Owner health telemetry reads. | Health is owner telemetry and remains separate from LifeOps internals and plugin-health implementation details. |
| `OWNER_SCREENTIME` | `summary`, `today`, `weekly`, `weekly_average_by_app`, `by_app`, `by_website`, `activity_report`, `time_on_app`, `time_on_site`, `browser_activity` | Owner screen, app, website, and browser activity analytics. | Telemetry is owner-scoped and read-oriented, not generic device control. |
| `OWNER_FINANCES` | `dashboard`, `list_sources`, `add_source`, `remove_source`, `import_csv`, `list_transactions`, `spending_summary`, `recurring_charges`, `subscription_audit`, `subscription_cancel`, `subscription_status` | Owner finance sources, transactions, recurring charges, and financial subscriptions. | Replaces vague `MONEY` and avoids taking over global payment semantics. Email subscriptions remain messaging/email work. |
| `BLOCK` | `block`, `unblock`, `status`, `request_permission`, `release`, `list_active`; `target=app|website` | App and website blocking lifecycle. | One parent because both targets share rule lifecycle, permissioning, release, and active-state inspection. |
| `CREDENTIALS` | `fill`, `whitelist_add`, `whitelist_list`, `search`, `list`, `inject_username`, `inject_password` | Credential lookup, autofill, whitelisting, and injection. | One credential parent removes specialized `AUTOFILL`, `PASSWORD_MANAGER`, and provider setup ambiguity. |
| `CALENDAR` | `feed`, `next_event`, `search_events`, `create_event`, `update_event`, `delete_event`, `trip_window`, `bulk_reschedule`, `check_availability`, `propose_times`, `update_preferences` | Calendar reads/writes, availability, and scheduling preferences. | Calendar providers should register behind this parent; provider-only capabilities must not create generic planner parents. |
| `PERSONAL_ASSISTANT` | `book_travel`, `scheduling` | Travel booking and scheduling assistant workflows. | Broad assistant workflows are not CRUD over one store, so they live here rather than under `LIFE` or provider names. |
| `RESOLVE_REQUEST` | `approve`, `reject` | Owner approval queue decisions. | Approval decisions are one lifecycle pair over pending requests. |
| `VOICE_CALL` | `dial` | Places a phone call through the registered call provider path. | One call parent allows Android, iOS, AOSP, Twilio, or future providers without exposing `PLACE_CALL`. |
| `CONNECTOR` | `connect`, `disconnect`, `verify`, `status`, `list` | External account and connector lifecycle. | Provider setup belongs here instead of provider-specific credential actions. |
| `SCHEDULED_TASKS` | `list`, `get`, `create`, `update`, `snooze`, `skip`, `complete`, `acknowledge`, `dismiss`, `cancel`, `reopen`, `history` | Direct control of LifeOps `ScheduledTask` records. | This is the one task primitive required by `AGENTS.md`; the public name avoids `TASKS` collision. |
| `WORK_THREAD` | work-thread lifecycle payload | Work-thread create/steer/stop/wait/complete/merge/source/follow-up control. | Renamed from `LIFEOPS_THREAD_CONTROL` because the parent is work-thread state, not a LifeOps brand namespace. |
| `REMOTE_DESKTOP` | `start`, `status`, `end`, `list`, `revoke` | Remote desktop session lifecycle. | The parent owns a session lifecycle. It remains app/service oriented and should be app-gated where appropriate. |

### Runtime, Admin, Documents, And Developer Tools

| Parent | Child Actions | What It Does | Why This Parent / Grouping |
|---|---|---|---|
| `UPDATE_SETTINGS` / `SETTINGS` | setting update payloads | Mutates agent or owner-visible settings. | Settings are runtime state, not LifeOps state. Existing compatibility leaves remain where core expects them. |
| `UPDATE_ROLE` | role assignment payload | Assigns conversation/user roles. | Role assignment is a focused security/admin mutation. |
| `ATTACHMENT` | `read`, `save_as_document` | Reads recent/current attachments or saves readable attachment content into documents. | Attachments are a domain surface; read and save are sibling operations over the same incoming artifacts. |
| `GENERATE_MEDIA` | media type payload | Generates image, video, or audio from a prompt. | Media generation creates new artifacts and is not attachment reading. |
| `FILE` | `read`, `write`, `edit`, `grep`, `glob`, `ls` | Filesystem read/write/search/list operations. | One file parent shares path policy, cwd resolution, and filesystem risk boundaries. |
| `SHELL` | command payload | Runs a shell command. | The command string is the operation, so a leaf parent is sufficient. |
| `WORKTREE` | `enter`, `exit` | Enters or exits a coding worktree. | Worktree state has a two-step lifecycle and belongs together. |
| `BROWSER` | navigation, tab, DOM input, screenshot/state, realistic cursor, and autofill-login actions | Controls browser tabs and pages. | One browser parent shares target tab/session state and browser safety checks. |
| `COMPUTER_USE` | screenshot, click, type, key, scroll, drag, detect, OCR actions | Desktop GUI control primitives. | Direct GUI operations share the same desktop-control capability boundary. |
| `DESKTOP` | file/window/terminal dispatch payload | Higher-level desktop dispatch. | Kept separate from `COMPUTER_USE` because it routes to desktop concepts rather than raw pointer/keyboard primitives. |
| `MCP` | `call_tool`, `read_resource`, `search_actions`, `list_connections` | MCP tool/resource routing. | All children share MCP connection and server targeting. |

### Providers, Media, Finance, Skills, And Apps

| Parent | Child Actions | What It Does | Why This Parent / Grouping |
|---|---|---|---|
| `GITHUB` | PR, issue, and notification triage actions | GitHub provider work. | One provider/account boundary; old PR/issue/notification leaf actions are retired from planner docs. |
| `LINEAR` | issue, comment, activity, and search actions | Linear provider work. | One provider/account boundary. |
| `SHOPIFY` | `search`, `products`, `inventory`, `orders`, `customers` | Shopify store browsing and management. | Store-domain parent with noun children because each child has its own second-stage store operations. |
| `TUNNEL` | `start`, `stop`, `status` | Tunnel lifecycle across providers. | Ngrok, Tailscale, and cloud/headscale implementations belong behind one tunnel parent. |
| `MUSIC` | `playlist`, `play_query`, `search_youtube`, `download`, `pause`, `resume`, `skip`, `stop`, `queue`, `play_audio`, `routing`, `zones` | Music search, playback, queue, routing, and zone control. | One music parent because these operations share playback/library state. |
| `MUSIC_GENERATION` | `generate`, `custom`, `extend` | Suno music generation. | Kept separate from playback because it creates new audio artifacts. |
| `MYSTICISM_PAYMENT` | `check`, `request` | Payment status/request within mysticism flows. | Renamed so the plugin does not squat on global `PAYMENT`. |
| `READING` | `start`, `followup`, `deepen` with `type=tarot|astrology|iching` | Mysticism reading sessions. | The parent is the reading session; type and action define the modality and lifecycle step. |
| `LIQUIDITY` | `onboard`, `list_pools`, `open`, `close`, `reposition`, `list_positions`, `get_position`, `set_preferences` | LP position management. | Liquidity positions are distinct from wallet transfer/swap actions and share LP risk controls. |
| `SKILL` | `search`, `details`, `sync`, `toggle`, `install`, `uninstall` | Skill catalog and install-state management. | Catalog management is separate from invoking a skill. |
| `USE_SKILL` | mode payload | Invokes an enabled skill. | Invocation is a different side effect from catalog management. |
| `TODO` | `write`, `create`, `update`, `complete`, `cancel`, `delete`, `list`, `clear` | Generic persistent todo list. | Plugin-specific todo store remains separate from owner LifeOps `OWNER_TODOS`. |
| `PLAY_EMOTE` | emote payload | Plays a companion avatar emote. | App-companion visual side effect; only useful when companion UI is active. |
| `SCAPE` | `walk_to`, `attack`, `chat_public`, `eat`, `drop`, `set_goal`, `complete_goal`, `remember` | Scape game agent control. | Game command parent because all children target the same game service/session. |
| `RS_2004` | walk, skill, inventory, bank, shop, combat, and interaction actions | 2004Scape game agent control. | Large game command parent is appropriate because commands share one game SDK/service. |

## Guardrails Added

- `packages/core/src/__tests__/action-structure-audit.test.ts`
  checks that retired action names do not enter generated canonical docs and
  that any schema exposing legacy discriminator aliases also exposes `action`.
- `plugins/app-lifeops/test/action-structure-audit.test.ts`
  checks LifeOps registration for retired names, required canonical parents,
  and owner-operation `action` discriminators.
- Existing LifeOps promotion/gating/scheduled-task tests were updated to the
  canonical names and role-gate model.

## Retired Names Guarded

The generated-doc guard rejects these public parent names:

`ASK_USER_QUESTION`, `CHECKIN`, `DISCORD_SETUP_CREDENTIALS`, `ENTER_WORKTREE`,
`EXIT_WORKTREE`, `FIRST_RUN`, `FORM_RESTORE`, `LIFE`, `PROFILE`,
`RELATIONSHIP`, `MONEY`, `PAYMENTS`, `SUBSCRIPTIONS`, `SCHEDULE`,
`BOOK_TRAVEL`, `SCHEDULING_NEGOTIATION`, `DEVICE_INTENT`, `MESSAGE_HANDOFF`,
`APP_BLOCK`, `WEBSITE_BLOCK`, `AUTOFILL`, `PASSWORD_MANAGER`,
`GOOGLE_CALENDAR`, `NOSTR_PUBLISH_PROFILE`, `PAYMENT`, `PLACE_CALL`,
`READ_ATTACHMENT`, `SHELL_COMMAND`, `START_TUNNEL`, `STOP_TUNNEL`,
`GET_TUNNEL_STATUS`, `TAILSCALE`, `READ`, `WRITE`, `EDIT`, `GREP`, `GLOB`,
`LS`, and `WEB_FETCH`.

## Residual Opportunities

These are not unfinished consolidation targets, but they remain worth tracking:

- Some handlers still accept and internally mirror `subaction`/`op` for
  backward compatibility. This is intentional while old callers migrate.
- Some source comments and similes mention retired names as compatibility
  evidence. They should not be treated as planner-visible actions.
- `DESKTOP` overlaps conceptually with `FILE`, `SHELL`, and `COMPUTER_USE`;
  keep it only if the higher-level desktop routing remains useful.
- `TODO` and `OWNER_TODOS` are both valid but different stores. Routing docs
  should continue to prefer `OWNER_TODOS` when the owner is talking to the
  LifeOps-capable agent.
- `MUSIC_GENERATION` could eventually fold into `MUSIC action=generate`, but
  keeping generation separate is defensible because it creates new media rather
  than controlling playback.
