# Action and Subaction Structure Audit — 2026-05-11

Scope: production action surfaces under `packages/core/src`, `packages/agent/src`,
and `plugins/`. Excludes `packages/benchmarks/`, `packages/examples/`,
`plugin-action-bench`, `*.test.ts`, `*.spec.ts`, `__tests__/`, generated specs,
`dist/`, and `node_modules/`.

This is a follow-up to the 2026-05-10 post-consolidation audit. The earlier
pass eliminated the worst structural defects (LIFE/LIFEOPS umbrella, READ/
WRITE/EDIT leaf sprawl, provider-named tunnel/calendar/discord leaks, etc.)
and added retired-name guards in the generated docs. That work is real and
verified. **This audit re-examines the surface with the consolidation in
place and finds a different shape of remaining work: residual atomic-leaf
fragmentation inside core, name-collision and dead-file debris in plugin
trees, and a handful of new misshapes introduced by the consolidation
itself.**

---

## Headline numbers

- **170** files in production code export an `Action` (`Action` type or
  `satisfies Action`).
- **138** distinct `name:` strings appear across those files.
- About **100** of those names are actually registered into a `Plugin.actions`
  array; the rest are internal handlers dispatched by an umbrella or are
  truly dead.
- **Retired-name guard**: 38 names are blocked from reappearing in generated
  canonical docs.
- **New regressions / misshapes discovered**: 11 (catalogued below).
- **Persisting fragmentation**: 4 large clusters (secrets, todos, trust,
  agent-page-groups) still expose ≥3 atomic leaves that should be one
  umbrella.
- **Dead code on disk**: ~14 `.ts` files under `plugins/app-lifeops/src/
  actions/` carry retired `name:` strings and are not registered anywhere.

---

## Layered structure (current, verified)

The taxonomy still follows the layering from 2026-05-10:

1. Conversation turn control: `REPLY`, `IGNORE`, `NONE`, `CHOOSE_OPTION`.
2. Channel communication: `MESSAGE`, `POST`, `FOLLOW_ROOM`/`UNFOLLOW_ROOM`/
   `MUTE_ROOM`/`UNMUTE_ROOM`, `CONTACT`, `ENTITY`.
3. Owner operations: `OWNER_*`, `CALENDAR`, `BLOCK`, `CREDENTIALS`,
   `PERSONAL_ASSISTANT`, `RESOLVE_REQUEST`, `VOICE_CALL`, `CONNECTOR`,
   `SCHEDULED_TASKS`, `WORK_THREAD`, `REMOTE_DESKTOP`.
4. Runtime/admin: `SETTINGS`, `UPDATE_ROLE`, secrets surfaces, `PLUGIN`,
   `RUNTIME`, `MEMORY`, `LOGS`, `DATABASE`, `TRIGGER`.
5. Developer tools: `FILE`, `SHELL`, `WORKTREE`, `BROWSER`, `COMPUTER_USE`,
   `DESKTOP`, `MCP`, `APP`.
6. Provider integrations: `GITHUB`, `LINEAR`, `SHOPIFY`, `TUNNEL`, `MUSIC`,
   `MUSIC_GENERATION`, `WALLET`, `LIQUIDITY`, `TOKEN_INFO`, `VISION`,
   `READING`, `MYSTICISM_PAYMENT`.
7. App/game-specific actions: `SCAPE`, `RS_2004`, `MC`, `ROBLOX`,
   `PLAY_EMOTE`, `PREDICTION_MARKET`.
8. Skills: `SKILL`, `USE_SKILL`.
9. Page-action groups: `BROWSER_ACTIONS`, `WALLET_ACTIONS`,
   `CHARACTER_ACTIONS`, `SETTINGS_ACTIONS`, `CONNECTOR_ACTIONS`,
   `AUTOMATION_ACTIONS`, `PHONE_ACTIONS`, `OWNER_ACTIONS`.

The page-action-group layer (item 9) is a new top-level pattern that did
not exist in the original audit. See §3 for why it is structurally
problematic.

---

## 1. Detailed Canonical Catalog (current state)

This is the planner-visible registered surface today, organized by parent.
Every entry was verified against the actual plugin registration file (`index.ts`,
`plugin.ts`, or `eliza-plugin.ts`), not against documentation.

### 1.1 Conversation and messaging

| Parent | Plugin | Children / Discriminator | Notes |
|---|---|---|---|
| `REPLY` | `packages/core` basic-capabilities | none | Leaf. |
| `IGNORE` | `packages/core` basic-capabilities | none | Leaf. |
| `NONE` | `packages/core` basic-capabilities | none | Leaf. |
| `CHOOSE_OPTION` | `packages/core` basic-capabilities | `taskId`, `selectedOption` | Leaf with options payload. |
| `MESSAGE` | `packages/core` advanced-capabilities | `op` enum of 22 values (send, read_channel, read_with_contact, search, list_channels, list_servers, join, leave, react, edit, delete, pin, get_user, triage, list_inbox, search_inbox, draft_reply, draft_followup, respond, send_draft, schedule_draft_send, manage) | Promoted. Internal handlers live under `messaging/triage/actions/*` and are not separately registered. |
| `POST` | `packages/core` advanced-capabilities | connector-specific (send, react, ...) | Promoted. Dynamic per active connector. |
| `FOLLOW_ROOM` / `UNFOLLOW_ROOM` / `MUTE_ROOM` / `UNMUTE_ROOM` | `packages/core` (via `roomOpAction`) | one parent (`ROOM_OP`) with `op` enum, promoted into the four flat leaves | The four leaf names are the planner-visible ones; the parent is internal. |
| `UPDATE_ROLE` | `packages/core` advanced-capabilities | role assignment payload | Leaf. |
| `SEARCH_EXPERIENCES` | `packages/core` advanced-capabilities/experience | none | Leaf. Standalone. |
| `CHARACTER` | `packages/core` advanced-capabilities/personality | `action` enum (view, update, reset, ...) | Promoted. |
| `CONTACT` | `packages/agent` | `op` enum (create, read, search, update, delete, link, merge, activity, followup) | Promoted. |
| `ENTITY` | `app-lifeops` | `subaction` enum (add, list, log_interaction, set_identity, set_relationship, merge) | Discriminator is `subaction`, not `action`. Mismatch with `CONTACT`. |
| `SCHEDULE_FOLLOW_UP` | (legacy; now lives as `followup` op on `CONTACT`) | n/a | Compatibility-only; not registered as its own parent. |

### 1.2 Owner operations (`app-lifeops`)

All entries below are registered via
`promoteSubactionsToActions(...)` in `plugins/app-lifeops/src/plugin.ts:591`.

| Parent | Children (discriminator: `action`/`subaction`, both mirrored) |
|---|---|
| `BLOCK` | block, unblock, status, request_permission, release, list_active; `target=app|website` |
| `OWNER_FINANCES` | dashboard, list_sources, add_source, remove_source, import_csv, list_transactions, spending_summary, recurring_charges, subscription_audit, subscription_cancel, subscription_status |
| `CREDENTIALS` | fill, whitelist_add, whitelist_list, search, list, inject_username, inject_password |
| `CALENDAR` | feed, next_event, search_events, create_event, update_event, delete_event, trip_window, bulk_reschedule, check_availability, propose_times, update_preferences |
| `RESOLVE_REQUEST` | approve, reject |
| `OWNER_REMINDERS` | create, update, delete, complete, skip, snooze, review |
| `OWNER_ALARMS` | create, update, delete, complete, skip, snooze, review |
| `OWNER_GOALS` | create, update, delete, complete, skip, snooze, review |
| `OWNER_TODOS` | create, update, delete, complete, skip, snooze, review |
| `OWNER_ROUTINES` | create, update, delete, complete, skip, snooze, review, schedule_summary, schedule_inspect |
| `OWNER_HEALTH` | today, trend, by_metric, status |
| `OWNER_SCREENTIME` | summary, today, weekly, weekly_average_by_app, by_app, by_website, activity_report, time_on_app, time_on_site, browser_activity |
| `PERSONAL_ASSISTANT` | book_travel, scheduling, sign_document |
| `VOICE_CALL` | dial; `recipientKind=owner|external|e164` |
| `REMOTE_DESKTOP` | standalone — no discriminator |
| `WORK_THREAD` | operations object: create, steer, stop, mark_waiting, mark_completed, merge, attach_source, schedule_followup |
| `SCHEDULED_TASKS` | list, get, create, update, snooze, skip, complete, acknowledge, dismiss, cancel, reopen, history |
| `CONNECTOR` | connect, disconnect, verify, status, list |

### 1.3 Runtime, admin, documents, secrets

| Parent | Plugin | Children / Discriminator | Notes |
|---|---|---|---|
| `RUNTIME` | `packages/agent` | `op` enum (status, self_status, describe_actions, reload_config, restart) | Promoted. |
| `PLUGIN` | `packages/agent` | `op` enum (install, uninstall, update, sync, eject, reinject, configure, read_config, toggle, list, disconnect); `type=plugin|connector` | Promoted. |
| `SETTINGS` | `packages/agent` `settings-actions.ts` | `op` enum (update_ai_provider, toggle_capability, toggle_training, set_owner_name, set) | Direct, owner-gated. **Name conflict** with the page-action-group `SETTINGS_ACTIONS` (see §3). |
| `TRIGGER` | `packages/agent` | `op` enum (create, update, delete, run, toggle) | Promoted. |
| `DATABASE` | `packages/agent` | `op` enum (list_tables, get_table, query, search_vectors) | Promoted. |
| `MEMORY` | `packages/agent` | `op` enum | Promoted. |
| `LOGS` | `packages/agent` | `op` enum | Promoted. |
| `MANAGE_SECRET` | `packages/core` secrets | `operation=get|set|delete|list|check` (discriminator is named `operation`, not `action`) | Promoted. **Fragmentation**: also see §2.1 — five additional atomic leaf actions are registered alongside it. |
| `SET_SECRET` | `packages/core` secrets | `name`/`value` payload; can act on multiple secrets | Promoted (children: enable, disable). Has its own subaction surface. |
| `GET_SECRET` | `packages/core` secrets | leaf | **Atomic leaf, redundant with `MANAGE_SECRET operation=get`.** |
| `LIST_SECRETS` | `packages/core` secrets | leaf | **Atomic leaf, redundant with `MANAGE_SECRET operation=list`.** |
| `CHECK_SECRET` | `packages/core` secrets | leaf | **Atomic leaf, redundant.** |
| `DELETE_SECRET` | `packages/core` secrets | leaf | **Atomic leaf, redundant.** |
| `MIRROR_SECRET_TO_VAULT` | `packages/core` secrets | leaf | Atomic leaf; not in `MANAGE_SECRET` enum. |
| `REQUEST_SECRET` | `packages/core` secrets | leaf | Atomic leaf; semantically distinct (asks user to supply). |
| `SECRETS_UPDATE_SETTINGS` | `packages/core` secrets/onboarding | onboarding settings mutation | Standalone. |
| `EVALUATE_TRUST` | `packages/core` trust | leaf | Atomic leaf. **No `TRUST` umbrella.** |
| `RECORD_TRUST_INTERACTION` | `packages/core` trust | leaf | Atomic leaf. |
| `REQUEST_ELEVATION` | `packages/core` trust | leaf | Atomic leaf. |
| `TRUST_UPDATE_ROLE` | `packages/core` trust | leaf | Atomic leaf. File exists but is not in the trust feature's `actions:` array — **dead, unlike its siblings**. |
| `CREATE_PLAN` | `packages/core` advanced-planning | leaf | Registered. Could be `PLAN action=create` if there are more plan ops. |
| `SEND_TO_ADMIN` | `packages/core` autonomy | leaf | Registered. |
| `ATTACHMENT` | `packages/core` basic-capabilities | `action=read|save_as_document` | Replaces retired `READ_ATTACHMENT`. |
| `GENERATE_MEDIA` | `packages/core` advanced-capabilities | media type payload | Standalone. |
| `ANALYZE_IMAGE` | `packages/agent` `media.ts` | leaf | File present, **but not in `eliza-plugin.ts` actions array** — so this is dead/disconnected today. The 2026-05-10 audit said it should be automatic; the file remains. |
| `EXTRACT_PAGE` | `packages/agent` `extract-page.ts` | leaf | File present, **not in `eliza-plugin.ts` actions array** — dead. Earlier audit said this should be automatic; the file remains. |
| `QUERY_TRAJECTORIES` | `packages/agent` `trajectories.ts` | leaf | File present, **not in actions array** — dead. The earlier audit explicitly said "remove `QUERY_TRAJECTORIES`, no trajectory actions exist." Still on disk. |
| `SKILL_COMMAND` | `packages/agent` `skill-command.ts` | leaf | File present, **not in actions array** — dead. Earlier audit said remove. |

### 1.4 Developer tools

| Parent | Plugin | Children / Discriminator | Notes |
|---|---|---|---|
| `FILE` | `plugin-coding-tools` | `action=read|write|edit|grep|glob|ls` | Umbrella. Internal handlers `read.ts`, `write.ts`, etc. exist as helpers, not registered. |
| `SHELL` | `plugin-coding-tools` | command payload | Leaf. Aliased as `bashAction` internally. |
| `WORKTREE` | `plugin-coding-tools` | `action=enter|exit` | Umbrella. |
| `BROWSER` | `plugin-browser` | `action` enum of 24 values (back, click, close, forward, get, hide, navigate, open, press, reload, screenshot, show, snapshot, state, tab, type, wait, realistic-click, realistic-fill, realistic-type, realistic-press, cursor-move, cursor-hide, autofill-login) plus tab and target overrides | Direct registration, not promoted. |
| `MANAGE_BROWSER_BRIDGE` | `plugin-browser` | `action=provision|connect|check|list|disconnect` | Separate umbrella for bridge lifecycle. |
| `COMPUTER_USE` | `plugin-computeruse` | `action` enum of 13 values (screenshot, click, click_with_modifiers, double_click, right_click, mouse_move, type, key, key_combo, scroll, drag, detect_elements, ocr) | Promoted. |
| `DESKTOP` | `plugin-computeruse` | `op=file|window|terminal`; each has its own nested verbs | Promoted. **Conceptually overlaps `FILE`, `SHELL`, and window-management** — see §3.2. |
| `MCP` | `plugin-mcp` | `op=call_tool|read_resource|search_actions|list_connections` | Promoted. |
| `APP` | `plugin-app-control` | `mode=launch|relaunch|load_from_directory|list|create` | Direct. |
| `FORM_RESTORE` | `plugin-form` | leaf | Direct. **Inconsistent naming** — every other parent uses `XXX action=verb`; this stays as a verb-named leaf because there's only one operation today. Same shape applies to several core leaves. |
| `CLEAR_HISTORY` | `plugin-shell` | leaf | Plugin-shell is approval/history infrastructure, not a shell command executor. The name is ambiguous because it competes with the much larger `SHELL` action in `plugin-coding-tools`. |

### 1.5 Provider integrations

| Parent | Plugin | Children / Discriminator | Notes |
|---|---|---|---|
| `GITHUB` | `plugin-github` | `action=pr_list|pr_review|issue_create|issue_assign|issue_close|issue_reopen|issue_comment|issue_label|notification_triage` | Promoted. Canonical. |
| `LINEAR` | `plugin-linear` | `op=create_issue|get_issue|update_issue|delete_issue|create_comment|update_comment|delete_comment|list_comments|get_activity|clear_activity|search_issues` | Promoted. Canonical. **Uses `op` instead of `action`** — discriminator name is inconsistent across providers. |
| `SHOPIFY` | `plugin-shopify` | `action|op|entity|subaction=search|products|inventory|orders|customers` | Promoted. Accepts four different discriminator names (sloppy). |
| `TUNNEL` | `plugin-tunnel` | `action=start|stop|status` | Promoted. Generic across providers. |
| `MUSIC` | `plugin-music` | `op=playback ops, library ops, routing, zones, play_audio` — mixed shape (verb / noun / phrase) | Promoted. **Subaction naming is inconsistent**: pause/resume/skip are verbs; queue is a noun; play_query and manage_routing are phrases. |
| `MUSIC_GENERATION` | `plugin-suno` | leaf, single action with similes (CustomGenerateMusic, ExtendAudio) | Standalone. Separate parent because it produces new audio. |
| `WALLET` | `plugin-wallet` `chains/wallet-action.ts` | `subaction=transfer|swap|bridge|gov` | Promoted (via the EVM sub-plugin). Discriminator is `subaction`. The parent name is finally `WALLET` (was `walletRouterAction`). |
| `LIQUIDITY` | `plugin-wallet` `lp/actions/liquidity.ts` | `action=onboard|list_pools|open|close|reposition|list_positions|get_position|set_preferences` | Direct. Separate from `WALLET` because LP is a different risk surface. |
| `TOKEN_INFO` | `plugin-wallet` `analytics/token-info` | `subaction` enum | Direct. Separate from `WALLET`. |
| `VISION` | `plugin-vision` | `op=describe|capture|set_mode|name_entity|identify_person|track_entity` plus keyword inference | Promoted. |
| `READING` | `plugin-mysticism` | `action=start|followup|deepen`; `type=tarot|astrology|iching` | Promoted. |
| `MYSTICISM_PAYMENT` | `plugin-mysticism` | `action=check|request` | Promoted. Plugin-prefixed name avoids global `PAYMENT` squat. |
| `TODO` | `plugin-todos` | `op=write|create|update|complete|cancel|delete|list|clear` | Direct. |

### 1.6 Coding/agent orchestration

| Parent | Plugin | Children / Discriminator |
|---|---|---|
| `TASKS` | `plugin-agent-orchestrator` | 14 ops: create, spawn_agent, send, stop_agent, list_agents, cancel, history, control (pause/resume/stop/continue/archive/reopen), share, provision_workspace, submit_workspace, manage_issues (create/list/get/update/comment/close/reopen/add_labels), archive, reopen |
| `SKILL` | `plugin-agent-skills` | `action=search|details|sync|toggle|install|uninstall` |
| `USE_SKILL` | `plugin-agent-skills` | leaf, takes a skill slug |
| `WORKFLOW` | `plugin-workflow` | `action=create|modify|activate|deactivate|toggle_active|delete|executions` |

### 1.7 App-specific actions

| Parent | Plugin | Children / Discriminator |
|---|---|---|
| `SCAPE` | `app-scape` | 8 ops: walk_to, attack, chat_public, eat, drop, set_goal, complete_goal, remember |
| `RS_2004` | `app-2004scape` | 30 ops covering movement, skills, inventory, bank, shop, combat, NPC, world |
| `MC` | `plugin-minecraft` | 11 ops (Minecraft) |
| `ROBLOX` | `plugin-roblox` | `action=message|execute|get_player` |
| `PLAY_EMOTE` | `app-companion` | emote name |
| `PREDICTION_MARKET` | `app-polymarket` | `subaction=read|place-order`; `kind=status|markets|market|orderbook|positions` |

### 1.8 Page-action-group actions (new pattern)

These are the *meta-parent* actions used in main chat to delegate to
page-scoped child actions. They live in `packages/agent/src/actions/
page-action-groups.ts:189-521` and are registered via
`pageActionGroupActions` in `eliza-plugin.ts:209`.

| Name | Contexts it delegates into |
|---|---|
| `BROWSER_ACTIONS` | `browser` page context |
| `WALLET_ACTIONS` | `wallet`, `finance` |
| `CHARACTER_ACTIONS` | `personality` |
| `SETTINGS_ACTIONS` | `settings`, `admin`, `agent_internal` |
| `CONNECTOR_ACTIONS` | `connectors` |
| `AUTOMATION_ACTIONS` | `automation`, `scheduling` |
| `PHONE_ACTIONS` | `phone` |
| `OWNER_ACTIONS` | `lifeops`, `owner` |

These are owner-only main-chat parents that route to existing leaf actions
(BROWSER, CHECK_BALANCE, MODIFY_CHARACTER, etc.) when the planner happens
to be running outside a page-scoped context. They take `{action, parameters}`.
This is a real and legitimate concept, but the **naming is structurally
problematic**. See §3.

---

## 2. Critical Findings — Persisting Fragmentation

These are clusters where multiple atomic leaves are registered alongside (or
instead of) the umbrella that should own them.

### 2.1 Secrets — 7 atomic leaves alongside `MANAGE_SECRET`

**File:** `packages/core/src/features/secrets/plugin.ts:102-112`

The plugin currently registers:

```
...promoteSubactionsToActions(setSecretAction),     // SET_SECRET umbrella with subactions
...promoteSubactionsToActions(manageSecretAction),  // MANAGE_SECRET umbrella (operation=get|set|delete|list|check)
getSecretAction,
listSecretsAction,
checkSecretAction,
deleteSecretAction,
mirrorSecretToVaultAction,
updateSettingsAction,
requestSecretAction,
```

The comment in the source says: "The atomic GET/LIST/CHECK/DELETE/MIRROR
actions are also registered directly so structured callers can invoke them
without LLM extraction." This is the *exact* defensive duplication pattern
the audit rules reject (commandment #8 — DTO fields required by default; no
parallel paths for "convenience"). It produces six planner-visible names for
one operation:

- `GET_SECRET`
- `MANAGE_SECRET` (promoted leaf: `MANAGE_SECRET_GET`)
- `MANAGE_SECRET` (umbrella, `operation=get`)
- + the same shape for set, list, check, delete

**Additional defects:**

- `MANAGE_SECRET`'s discriminator is named `operation`, not `action`. Every
  other umbrella in the codebase that was canonicalized uses `action`. This
  is a new inconsistency to fix.
- `manage-secret.ts:56-59` declares similes "GET_SECRET", "DELETE_SECRET",
  "LIST_SECRETS", "CHECK_SECRET" — exactly the names that are *also*
  registered as separate top-level actions. Either the umbrella owns these
  names or the leaves do, never both.
- `SET_SECRET` is its own promoted umbrella with subactions independent of
  `MANAGE_SECRET`. The two umbrellas overlap.

### 2.2 Trust — 4 atomic leaves, no umbrella

**Files:** `packages/core/src/features/trust/index.ts:141-143`,
`packages/core/src/features/index.ts:47-49`.

Registered as flat leaves:
- `EVALUATE_TRUST`
- `RECORD_TRUST_INTERACTION`
- `REQUEST_ELEVATION`

The fourth file, `trust/actions/roles.ts`, declares `TRUST_UPDATE_ROLE` but
is not registered anywhere (file is dead). The trust evaluator
(`trust/evaluators/securityEvaluator.ts`, registered as `SECURITY_EVALUATOR`)
is registered but is an evaluator, not an action.

These four files want to be one `TRUST` umbrella with `action=evaluate|
record|request_elevation|update_role`. Today they fight each other for the
trust namespace.

### 2.3 Todos — 5 atomic leaves alongside `TODO` umbrella

**File:** `packages/core/src/features/advanced-capabilities/index.ts:94-110`

```
// Todo leaf actions — the TODO umbrella is provided by @elizaos/plugin-todos;
// these leaves stay here for advanced-capabilities consumers that want
// direct-dispatch actions without depending on the plugin.
createTodoAction,
completeTodoAction,
listTodosAction,
editTodoAction,
deleteTodoAction,
```

The TODO umbrella lives in `plugins/plugin-todos/src/actions/todo.ts:450`
with `op=write|create|update|complete|cancel|delete|list|clear`. The comment
admits the duplication is for "consumers that want direct-dispatch without
depending on the plugin" — but in practice every Eliza distribution loads
both core and plugin-todos. There is no consumer that loads core without
the TODO umbrella. The five leaves are noise.

Additionally these leaves all use `id` as a hand-rolled parameter, while the
umbrella's discriminator is `op`/`action`/`subaction`. Two parameter shapes
for the same operation.

Also the dedicated owner-todo store on `app-lifeops` exposes `OWNER_TODOS`
(`action=create|update|delete|complete|skip|snooze|review`). So there are
**three distinct todo surfaces today**: `TODO` (plugin-todos), the five
atomic leaves in core, and `OWNER_TODOS` (lifeops). Two are different
stores, one (the leaves) is duplicate of TODO.

### 2.4 Page-action-group `_ACTIONS` parents — name collision and naming smell

`packages/agent/src/actions/page-action-groups.ts` defines 8 parent
actions whose names end in `_ACTIONS`:

`BROWSER_ACTIONS`, `WALLET_ACTIONS`, `CHARACTER_ACTIONS`,
`SETTINGS_ACTIONS`, `CONNECTOR_ACTIONS`, `AUTOMATION_ACTIONS`,
`PHONE_ACTIONS`, `OWNER_ACTIONS`.

Three structural issues:

1. **Direct name collision with the singular form**. `SETTINGS_ACTIONS`
   collides conceptually with `SETTINGS` (the real owner-gated settings
   action). `BROWSER_ACTIONS` collides with `BROWSER`. `OWNER_ACTIONS` is
   parent-to nine `OWNER_*` umbrellas (REMINDERS, ALARMS, GOALS, TODOS, …).
   The pluralization is the only thing keeping them apart.

2. **The `XXX_ACTIONS` suffix is a code-smell name**. The action name should
   describe what it does (e.g., `DELEGATE_PAGE_ACTION`, `PAGE_ROUTE`,
   `RUN_CHILD_ACTION`), not be its own meta-namespace. Today the planner
   sees `BROWSER_ACTIONS` and could be confused about whether it is the
   real browser action or its meta-parent.

3. **Per-page-context proliferation**. There are now 8 of these; if the
   pattern continues, every new page context adds another `_ACTIONS`
   parent. A single `PAGE_DELEGATE` action with a `page=browser|wallet|…`
   discriminator would express the same routing with one name.

### 2.5 Agent-package files registered nowhere

**File:** `packages/agent/src/runtime/eliza-plugin.ts:205-220`

Registered:
```
terminalAction,                                  // SHELL
...promoteSubactionsToActions(triggerAction),    // TRIGGER
...pageActionGroupActions,                       // the 8 _ACTIONS parents
...promoteSubactionsToActions(contactAction),    // CONTACT
settingsAction,                                  // SETTINGS
...promoteSubactionsToActions(pluginAction),     // PLUGIN
...promoteSubactionsToActions(logsAction),       // LOGS
...promoteSubactionsToActions(runtimeAction),    // RUNTIME
...promoteSubactionsToActions(databaseAction),   // DATABASE
...promoteSubactionsToActions(memoryAction),     // MEMORY
```

**Not registered, but on disk and exported from each file:**

- `analyzeImageAction` (ANALYZE_IMAGE) — `packages/agent/src/actions/media.ts`
- `extractPageAction` (EXTRACT_PAGE) — `packages/agent/src/actions/extract-page.ts`
- `skillCommandAction` (SKILL_COMMAND) — `packages/agent/src/actions/skill-command.ts`
- `queryTrajectoriesAction` (QUERY_TRAJECTORIES) — `packages/agent/src/actions/trajectories.ts`
- `streamAction` — `packages/agent/src/actions/stream-control.ts`

The 2026-05-10 audit explicitly said `ANALYZE_IMAGE`, `EXTRACT_PAGE`,
`QUERY_TRAJECTORIES`, and `SKILL_COMMAND` should be removed (replaced by
automatic extractors / image analysis, deleted, or merged into `SKILL`).
The files survived the audit. They are now planner-invisible dead code with
the original names still pointing at them. Either:

- delete the files entirely, or
- if the behavior is wanted, route it (e.g., move attachment-image analysis
  into the basic attachment provider / message handler).

### 2.6 LifeOps directory has 14 dead source files

Out of 33 `.ts` files under `plugins/app-lifeops/src/actions/`, only 19
are registered (verified against `plugin.ts:591-617`). The remaining 14
expose a `name:` string but no umbrella refers to them and the planner
never sees them:

| File | `name:` field | Registered? | Notes |
|---|---|---|---|
| `app-block.ts` | none in `name:` | no | Folded into `BLOCK`. Helper-only impl. |
| `autofill.ts` | none | no | Folded into `CREDENTIALS`. Helper-only impl. |
| `book-travel.ts` | `BOOK_TRAVEL` | no | Subsumed by `PERSONAL_ASSISTANT action=book_travel`. Old `name:` is stale. |
| `checkin.ts` | `CHECKIN` | no | Earlier audit retired the name; the file persists with the retired name still on it. |
| `device-intent.ts` | none in `name:` | no | Earlier audit retired. File persists. |
| `health.ts` | `HEALTH` | no | Wrapped by `OWNER_HEALTH`. Old `name:` "HEALTH" remains. |
| `life.ts` | `LIFE` | no | Wrapped by all `OWNER_*` reminders/todos/goals actions. Old `name:` "LIFE" remains — exactly the name the retired-name guard is meant to block. |
| `money.ts` | none in `name:` (uses dynamic name resolver) | no | Wrapped by `OWNER_FINANCES`. |
| `password-manager.ts` | `PASSWORD_MANAGER` | no | Wrapped by `CREDENTIALS`. Old name remains. |
| `payments.ts` | none | no | Folded into `OWNER_FINANCES`. Helper. |
| `profile.ts` | `PROFILE` | no | Retired action; lives only because `ownerProfileExtractionEvaluator` references its file. Old name remains. |
| `relationship.ts` | `RELATIONSHIP` | no | Retired; folded into `ENTITY` similes. Old name remains. |
| `schedule.ts` | `SCHEDULE` | no | Retired; folded into `OWNER_ROUTINES`. Old name remains. |
| `screen-time.ts` | none in `name:` | no | Wrapped by `OWNER_SCREENTIME`. |
| `scheduling-negotiation.ts` | `SCHEDULING_NEGOTIATION` | no | Subsumed by `PERSONAL_ASSISTANT action=scheduling`. Old name remains. |
| `subscriptions.ts` | none | no | Folded into `OWNER_FINANCES`. |
| `website-block.ts` | none | no | Folded into `BLOCK`. |
| `first-run.ts` | `FIRST_RUN` | no (exported but not in `actions:`) | The earlier audit said this should never be available as an action. The file persists; the export at `plugin.ts:893` is dangling. |
| `lifeops-pause.ts` | `LIFEOPS` | no (exported only) | Old `LIFEOPS` retired name still sits here. |
| `message-handoff.ts` | `MESSAGE_HANDOFF` | no (exported only) | Retired name. |
| `toggle-feature.ts` | none in `name:` | no | Earlier audit said remove. File persists. |

The retired-name guard prevents these from re-entering generated specs,
but the files themselves are landmines. Each one was edited by the prior
audit pass (delegation handlers, simile updates) and now they look "live"
on file-system inspection while being unreachable. They should be deleted
or re-pointed.

### 2.7 Plugin-tunnel: provider-specific subaction files still present

**Files:** `plugins/plugin-tunnel/src/actions/start-tunnel.ts`,
`stop-tunnel.ts`, `get-tunnel-status.ts`.

The `TUNNEL` umbrella's `action=start|stop|status` is canonical. These
three subaction files are imported into `tunnel.ts` as internal dispatch
targets, like `read.ts`/`write.ts` are for `FILE`. That is fine in
principle, except their internal `name:` fields are `'START_TUNNEL'`,
`'STOP_TUNNEL'`, `'GET_TUNNEL_STATUS'` — three of the names the retired-
name guard exists to keep out of generated docs. The internal dispatch
should refer to handlers, not Action objects with retired names.

### 2.8 Music plugin — inconsistent subaction shape

`MUSIC`'s subaction enum mixes:

- verbs: `pause`, `resume`, `skip`, `stop`
- noun: `queue` (intended as "view/manage queue")
- phrases: `play_query`, `search_youtube`, `manage_routing`, `manage_zones`,
  `play_audio`, `playlist`

This is the only umbrella in the codebase where one parent mixes all three
shapes. It is also the only one accepting four discriminator field names:
`op`, `action`, `music_op`, `command`.

The cleanest fix is to pick a verb form everywhere: `play`, `pause`,
`resume`, `skip`, `stop`, `queue_view`, `queue_add`, `queue_clear`,
`search`, `play_audio`, `set_routing`, `set_zone`, `playlist_play`,
`playlist_save`, etc. And canonicalize the discriminator to `action`.

### 2.9 Wallet plugin — atomic analytics leaves alongside `WALLET`

**File:** `plugins/plugin-wallet/src/plugin.ts`:

```
actions: concatPlugins(coreWalletPlugin.actions, evmPlugin.actions, [
  tokenInfoAction,         // TOKEN_INFO
  walletSearchAddressAction, // BIRDEYE_SEARCH (?)
]),
```

`WALLET` (subaction transfer/swap/bridge/gov) is the canonical action.
`LIQUIDITY` is a separate parent with its own risk gates. But `TOKEN_INFO`
and `walletSearchAddressAction` are atomic leaves that belong as
`WALLET action=token_info` and `WALLET action=search_address` — they are
read-only wallet/token analytics; nothing about them justifies a separate
parent.

(There is also `MUSIC_GENERATION` registered as a separate parent from
`MUSIC` for a similar reason — generation creates new audio rather than
controlling playback. The argument is at least defensible there. Wallet
analytics has no such carve-out.)

### 2.10 Shopify discriminator sprawl

`SHOPIFY` accepts `action`, `op`, `entity`, and `subaction` — four names
for the same field. None of the other modern provider parents (`GITHUB`,
`TUNNEL`, `LINEAR`, `MUSIC`) accept more than three. Pick one canonical
(`action`) and accept exactly two legacy aliases.

### 2.11 `ENTITY` vs. `CONTACT` discriminator inconsistency

`packages/agent` `CONTACT` uses `op=create|read|search|update|delete|link|
merge|activity|followup`. `app-lifeops` `ENTITY` uses `subaction=add|list|
log_interaction|set_identity|set_relationship|merge`.

Two parents with overlapping semantics, two different discriminator names,
two different verb sets. This is genuine overlap (the user asked to remove
`RELATIONSHIP`; `ENTITY` and `CONTACT` survived because they are different
data models — `CONTACT` is the rolodex, `ENTITY` is the entity-graph). But
the verbs and discriminator should align:

| Concept | CONTACT (agent) | ENTITY (lifeops) | Suggested merge |
|---|---|---|---|
| Create / add | `op=create` | `subaction=add` | `action=create` everywhere |
| Read / list | `op=read|search` | `subaction=list` | `action=list` / `action=get` |
| Interaction | `op=activity` | `subaction=log_interaction` | `action=log_interaction` |
| Merge | `op=merge` | `subaction=merge` | `action=merge` (already aligned) |
| Identity | n/a | `subaction=set_identity` | `action=set_identity` |
| Relationship | `op=link` | `subaction=set_relationship` | `action=link` / `action=set_relationship` (pick one) |

---

## 3. Critical Findings — Naming, Hierarchy, and Discriminator

### 3.1 Discriminator name is still not uniform

Today the canonical name was declared to be `action`, but the actual surface
exposes (verified across actions used by the planner):

| Discriminator | Examples |
|---|---|
| `action` | most modern umbrellas (FILE, WORKTREE, GITHUB, BLOCK, OWNER_*, BROWSER, COMPUTER_USE, MUSIC_GENERATION, LIQUIDITY, READING) |
| `op` | LINEAR, CONTACT, RUNTIME, PLUGIN, DATABASE, MEMORY, LOGS, TRIGGER, MCP, TODO, SETTINGS, MUSIC, WORKFLOW, MC, RESTART, page-action-group meta-parent |
| `subaction` | ENTITY, RESOLVE_REQUEST, CALENDAR, CONNECTOR, CREDENTIALS, BLOCK (legacy alias), WALLET (canonical), TOKEN_INFO, MC similes |
| `operation` | MANAGE_SECRET |
| `mode` | APP |
| `kind` | LIFE (legacy), POLYMARKET kinds |
| `verb` / `command` / `music_op` | MUSIC (legacy aliases) |

Some of these are intentional (the `mode` in `APP` reads more naturally
than `action`), but at least four are accidental drift. Recommend:

- **Promote `action` to *the* canonical discriminator name across the entire
  registered surface**, including `MANAGE_SECRET`, all `op`-named ones, and
  every plugin-shopify-style "accept four names" surface.
- Keep `subaction`/`op`/`operation`/`verb` as accepted backward-compat aliases
  in the dispatcher, never in the generated schema.
- Generated docs must show only `action`; tests must enforce this.

### 3.2 `DESKTOP` overlaps `FILE`, `SHELL`, and window-management

`DESKTOP op=file|window|terminal` was kept as separate from `COMPUTER_USE`
because COMPUTER_USE is raw pointer/keyboard primitives and DESKTOP is
"higher level". But:

- `DESKTOP op=file` overlaps `FILE` (read/write/edit/delete/exists/list).
- `DESKTOP op=terminal` overlaps `SHELL`.
- Only `DESKTOP op=window` (window list/focus/move/minimize) is uniquely
  desktop.

Recommendation: rename to `WINDOW` (just window management), move
file/terminal to their canonical parents, and let `COMPUTER_USE` keep raw
pointer/keyboard primitives.

### 3.3 `CONNECTOR` vs. `PLUGIN type=connector`

`packages/agent` `PLUGIN op=… type=plugin|connector` covers connector
install/uninstall/configure. `app-lifeops` `CONNECTOR action=connect|
disconnect|verify|status|list` covers connector account lifecycle.

These do *not* fully overlap (one is plugin-lifecycle, one is account-
lifecycle), but the name collision is real:

- "Disconnect connector X" is ambiguous between "uninstall the plugin" and
  "log out of the account".

Recommendation: rename the agent one to `PLUGIN type=connector op=install`,
keep the lifeops one as `CONNECTOR`, and add description text on each
clarifying which it owns.

### 3.4 `MUSIC_GENERATION` vs. `MUSIC` boundary

Both surfaces operate on audio; the argument for separating is that
generation creates new audio while playback controls existing audio. That
argument is real but weak now that Suno-style generation is mainstream;
treating "generate" as a `MUSIC` subaction is the simpler shape and matches
what users say ("play me some music", "make me a track" — both are MUSIC
requests).

Recommendation: fold `MUSIC_GENERATION` into `MUSIC action=generate|extend|
custom_generate` and retire the separate parent.

### 3.5 `READING` is plugin-mysticism-only

`READING action=start|followup|deepen type=tarot|astrology|iching` is a
plugin-specific surface. The parent name `READING` is short and easy to
confuse with reading attachments, reading a file, reading messages. Other
plugin-prefixed names use a clear plugin-prefix (`MYSTICISM_PAYMENT`).

Recommendation: rename `READING` → `MYSTICISM_READING` for consistency
with `MYSTICISM_PAYMENT`.

### 3.6 `TASKS` is plugin-agent-orchestrator-only but unmistakable

`TASKS` (14 subactions) is coding-agent orchestration. Previously this
clashed with the lifeops `TASKS` parent. That was fixed: lifeops became
`SCHEDULED_TASKS`. `TASKS` now unambiguously means "spawn / control
coding-agent tasks". The name still feels too generic — *any* todo list
is "tasks" — but the documentation, contexts, and gating now make this
clear enough.

Recommendation: rename to `CODING_TASKS` (or keep as-is if the
contextual gating works in practice). Lower priority than the rest.

### 3.7 `FORM_RESTORE` is the only verb-shaped leaf left

The plugin-form action is `FORM_RESTORE` (a verb baked into the action
name). Every other modern parent is `NOUN action=verb`. If form ever
grows a second op (save_session, list_sessions, abandon), this becomes a
problem. Recommendation: rename to `FORM action=restore` now, even if there
is only one op.

### 3.8 `CLEAR_HISTORY` (plugin-shell) is name-ambiguous

The plugin-shell action `CLEAR_HISTORY` does not name what it clears. In
practice it clears shell command history specifically. Rename to
`SHELL action=clear_history` or `SHELL_HISTORY action=clear|view|disable`
to attach it to the canonical SHELL parent.

### 3.9 The `_ACTIONS`-suffixed parents

See §2.4. Naming smell + collision risk. Recommend one canonical
`PAGE_DELEGATE` action with `page=browser|wallet|character|settings|
connectors|automation|phone|owner`.

### 3.10 Truly singletons that should pick parents

These leaves have no umbrella but plausibly should:

- `CREATE_PLAN` (planning) → `PLAN action=create|update|finalize|review`.
- `SEND_TO_ADMIN` (autonomy escalation) → `ESCALATE action=admin|owner|
  third_party`; alternatively merge into `MESSAGE_HANDOFF`.
- `SEARCH_EXPERIENCES` → either fold into `MEMORY` (`MEMORY action=
  search_experiences`) or keep but rename for parallelism (`EXPERIENCE
  action=search`).
- `GENERATE_MEDIA` → `MEDIA action=generate|describe|extract` (and absorb
  the now-dead `ANALYZE_IMAGE` if any usage path survives).

### 3.11 Mysticism `READING` and `MYSTICISM_PAYMENT` should share a parent

Two top-level actions in one plugin. They could be one:
`MYSTICISM action=reading_start|reading_followup|reading_deepen|
payment_check|payment_request`, with `type` shared. That or accept the
shape as-is (two contexts, two parents) and just normalize the names.

---

## 4. Critical Findings — Dead Code on Disk

The retired-name guard ensures retired names never reach the planner.
But the files implementing those retired names still exist:

| Cluster | Dead files | Action |
|---|---|---|
| lifeops retired actions (§2.6) | 14 files | Delete or convert to clearly-named helpers (no `name:` field). Re-point delegating umbrellas at internal handler functions, not `Action` objects with retired `name:` fields. |
| agent retired actions (§2.5) | 5 files (ANALYZE_IMAGE, EXTRACT_PAGE, QUERY_TRAJECTORIES, SKILL_COMMAND, stream-control) | Delete the files. Re-home any genuinely useful behavior. |
| tunnel retired actions (§2.7) | 3 files (start-tunnel, stop-tunnel, get-tunnel-status) | Convert to handler functions or namespaced types, drop `Action` typing on them. |
| coding-tools retired leaves | 7 files (read, write, edit, grep, glob, ls, bash) | These are *intentionally* retained as helpers. They should drop the `Action` shape and become regular handler functions; right now they masquerade as actions even though they are not registered. |
| trust `roles.ts` | 1 file (TRUST_UPDATE_ROLE) | Either register it as part of TRUST umbrella or delete. |
| empty plugins | `plugin-music-library`, `plugin-music-player` | Delete the directories (dist-only, no src). |
| empty plugin | `plugin-executecode` | Verify and delete if empty. |
| app-phone | `place-call.ts` (exports `placeCallAction`, not registered) | Either register gated to phone session or delete export. |

---

## 5. Critical Findings — Gaps and Improvements

### 5.1 Attachments and documents

`ATTACHMENT action=read|save_as_document` exists. The 2026-05-10 audit
also said "we should always extract links automatically" and "we should
always analyze posted images automatically" — replacing `EXTRACT_PAGE`
and `ANALYZE_IMAGE`. Today neither attachment-image analysis nor link
extraction has a registered automatic path. The two retired action files
remain on disk. There is no link-extraction or image-analysis evaluator
registered.

Recommendation: add (a) an attachment-image analysis evaluator that fires
on every message containing an image attachment; (b) a link-extraction
evaluator on every message containing http(s) URLs. Both write to memory
without consuming a planner step. Then delete the two retired action files.

### 5.2 Owner notes/files

The owner surface covers reminders, alarms, goals, todos, routines, health,
screentime, finances. It does not cover **notes** or **owner-specific
files/documents**. If notes are a genuine owner-managed surface (Apple
Notes, Obsidian, etc.), `OWNER_NOTES` with `action=create|search|update|
delete|list` would be consistent with the existing OWNER_* shape. (The
canonical-action audit explicitly listed `OWNER_NOTES` as missing.) If
notes always live in connector providers (Notion, Obsidian), document the
non-existence as a deliberate choice.

### 5.3 Email surface

Email is currently routed via `MESSAGE` and connector-specific providers.
There is no email-specific action. The user's earlier audit comment said
"email unsubscribe can also just be its own thing" and "subscriptions
should be considered". Today, owner-finances handles paid subscriptions
(`subscription_audit|cancel|status`). Email subscriptions / list-unsubscribe
have no canonical handler — neither an evaluator (auto-handle list-
unsubscribe headers) nor an action.

Recommendation: add an `EMAIL_SUBSCRIPTION action=unsubscribe|audit|
allow|deny` action *or* a `MESSAGE op=email_unsubscribe` subaction (it's
genuinely a message operation).

### 5.4 Plugin-todos vs. core todo leaves vs. lifeops OWNER_TODOS

Three parallel todo surfaces (§2.3). One should be canonical for "anything
the user calls a todo". Recommend: `OWNER_TODOS` is the owner-facing
surface, `TODO` is the connector-todo store, the five atomic core leaves
go away. If `TODO` and `OWNER_TODOS` operate on different stores, both
parents stay but their relationship needs documentation in the routing
provider.

### 5.5 Pagination control across high-count umbrellas

`RS_2004` (30 ops), `MESSAGE` (22 ops), `COMPUTER_USE` (13 ops), `TASKS` (14
ops) are all umbrellas with many promoted virtual leaves. When promoted,
each generates that many planner-visible names. This was deliberate, but
it creates noise. Worth tracking whether the planner's prompt budget can
absorb 80+ promoted virtual leaves from just three plugins.

This is a performance/UX concern, not a correctness one. Worth measuring
post-consolidation.

### 5.6 `PROFILE` retirement left a behavioral hole

The 2026-05-10 audit retired `PROFILE` and pointed at the response-handler
evaluator `ownerProfileExtractionEvaluator` as the replacement. That
evaluator is registered (`plugins/app-lifeops/src/plugin.ts:641`). But it
lives under `lifeops/profile/response-handler-evaluator.ts` — physically
next to the dead `profile.ts` action, which makes it look like the
evaluator is part of the dead action's plumbing. Recommendation: move the
evaluator into `lifeops/owner/profile-extraction-evaluator.ts` and delete
`profile.ts`.

### 5.7 `app-hyperliquid` has no actions, but should

`app-polymarket` exposes `PREDICTION_MARKET action=read|place-order`.
`app-hyperliquid` exposes no actions at all. Both apps are read-only-today,
trading-later. Either:
- mirror the pattern: add `PERPETUAL_MARKET action=read|place-order`
  (disabled) so the planner has a clean affordance to invoke, *or*
- explicitly document that the user must use the UI; planner has no
  surface.

### 5.8 `app-phone` `placeCallAction` is unreachable

The Android Capacitor `placeCallAction` is exported from app-phone but
not registered (the plugin's `actions: []` is empty). Meanwhile, the
canonical `VOICE_CALL action=dial` is in `app-lifeops` and is Twilio-based.
There is no path from the planner through app-phone today.

Recommendation: register Android dialing as a `VOICE_CALL` *provider*
(adapter) under app-lifeops, so the canonical action selects Android or
Twilio at runtime. Delete the dead app-phone export.

### 5.9 `WALLET_ACTIONS` page-group routes to `walletRouterAction`'s name "WALLET"

The page-action-group `WALLET_ACTIONS` is a meta-parent that delegates to
the underlying `WALLET` action (and to `LIQUIDITY`, `TOKEN_INFO`). Two
plus suffix-related names for "do wallet stuff" plus `WALLET_ACTIONS`,
`WALLET` (singular), and `WALLET_ACTIONS` (plural) are easy to confuse.

See §2.4 — the cleanest fix is to drop the `_ACTIONS` parents.

### 5.10 Skills-as-actions vs. plugins-as-actions

`USE_SKILL` is the planner's invocation surface for any registered skill;
`SKILL` is the catalog management umbrella. Skills can also (in theory)
register their own `SkillActionDefinition[]` inline — this is unused in
the current codebase. Either remove the inline skill-action capability
or document why it exists.

---

## 6. Implementation Plan — Parallel Sub-Agent Tasks

The work below should be done by independent sub-agents in parallel.
Each task is sized to be self-contained (~1 commit per task) with explicit
verification.

> **Hard rules:**
> 1. Canonical discriminator name is `action`. Accept legacy aliases in the
>    dispatcher; never expose them in generated schemas or descriptions.
> 2. No action file may declare a `name:` value that is in the retired-
>    names guard. If you need the file as a helper, drop the `Action`
>    typing and expose a handler function instead.
> 3. Every change must update or extend `packages/core/src/__tests__/
>    action-structure-audit.test.ts` and the lifeops equivalent so the
>    guard knows about the new shape.
> 4. Run `bun run --filter @elizaos/core test`, the lifeops focused tests,
>    and `node packages/prompts/scripts/generate-plugin-action-spec.js`
>    before finishing.

### Task A — Secrets consolidation (priority: critical)

**Goal:** One `SECRETS` umbrella with `action=get|set|delete|list|check|
mirror|request`, all subactions promoted, no atomic leaves.

**Files:**
- `packages/core/src/features/secrets/plugin.ts` (registration; lines 102-112)
- `packages/core/src/features/secrets/actions/manage-secret.ts` (rename to `SECRETS`; canonicalize discriminator to `action`; absorb mirror, request)
- `packages/core/src/features/secrets/actions/set-secret.ts` (fold into SECRETS; the multi-secret semantics become `SECRETS action=set` with an array `secrets`)
- `packages/core/src/features/secrets/actions/get-secret.ts`, `list-secrets.ts`, `check-secret.ts`, `delete-secret.ts`, `mirror-secret-to-vault.ts`, `request-secret.ts` — convert to internal handlers
- `packages/core/src/features/secrets/onboarding/action.ts` — keep `SECRETS_UPDATE_SETTINGS` (it is a settings mutation, not a secret op)
- Update `packages/core/src/__tests__/action-structure-audit.test.ts` and `packages/prompts/specs/actions/core.json`.

**Acceptance:**
- Planner-facing surface = `SECRETS` (promoted) + `SECRETS_UPDATE_SETTINGS`.
- All seven legacy names (`GET_SECRET`, `LIST_SECRETS`, `CHECK_SECRET`,
  `DELETE_SECRET`, `MIRROR_SECRET_TO_VAULT`, `REQUEST_SECRET`, `MANAGE_SECRET`)
  go into the retired-name guard.
- Discriminator everywhere is `action`. `operation` accepted as dispatcher
  alias only.
- Tests pass.

### Task B — Trust umbrella (priority: critical)

**Goal:** One `TRUST` umbrella with `action=evaluate|record_interaction|
request_elevation|update_role`.

**Files:**
- New: `packages/core/src/features/trust/actions/trust.ts` (umbrella).
- `packages/core/src/features/trust/index.ts` (register umbrella, drop
  individual leaves).
- `packages/core/src/features/index.ts` (drop trust leaves from feature
  collector).
- Update audit test and generated docs.

**Acceptance:**
- Planner-facing surface = `TRUST` (promoted) + `SECURITY_EVALUATOR` (still
  an evaluator, not an action).
- `EVALUATE_TRUST`, `RECORD_TRUST_INTERACTION`, `REQUEST_ELEVATION`, and
  `TRUST_UPDATE_ROLE` retired-name-guarded.
- `roles.ts` becomes the `update_role` handler.

### Task C — Todo consolidation (priority: high)

**Goal:** Remove the five core atomic todo leaves; `TODO` (plugin-todos)
remains; document the relationship to `OWNER_TODOS`.

**Files:**
- `packages/core/src/features/advanced-capabilities/index.ts` (drop the
  five `*TodoAction` references).
- `packages/core/src/features/advanced-capabilities/todos/` (delete the
  five action files; keep the service/types/index re-exports of the
  plugin if any code still imports them).
- Add a routing comment in `app-lifeops` and `plugin-todos` describing
  when to use `OWNER_TODOS` vs `TODO`.
- Update audit test and generated docs.

**Acceptance:**
- Planner-facing todo surface = `TODO` (plugin-todos) + `OWNER_TODOS`
  (lifeops).
- The five names (`CREATE_TODO`, `COMPLETE_TODO`, `LIST_TODOS`, `EDIT_TODO`,
  `DELETE_TODO`) retired-name-guarded.

### Task D — Replace `_ACTIONS` page-group parents with `PAGE_DELEGATE` (priority: high)

**Goal:** Collapse the eight `_ACTIONS`-suffixed parents into one
`PAGE_DELEGATE action page parameters` action.

**Files:**
- `packages/agent/src/actions/page-action-groups.ts` (rewrite as a single
  factory that emits one `PAGE_DELEGATE` action whose `page` parameter
  selects the allowed context set).
- `packages/agent/src/runtime/eliza-plugin.ts` (register the single action
  instead of the eight).
- Update audit test (add the eight retired names to the guard).

**Acceptance:**
- Planner-facing surface = `PAGE_DELEGATE` only.
- All eight `*_ACTIONS` names retired-name-guarded.
- Owner role gating preserved.

### Task E — Discriminator canonicalization sweep (priority: high)

**Goal:** Every registered action's primary discriminator parameter is
named `action`. Legacy aliases live in the dispatcher, not in the schema.

**Files affected (verified registered surfaces using non-`action` today):**
- `LINEAR` (`op`)
- `CONTACT` (`op`)
- `RUNTIME` (`op`)
- `PLUGIN` (`op`)
- `DATABASE` (`op`)
- `MEMORY` (`op`)
- `LOGS` (`op`)
- `TRIGGER` (`op`)
- `MCP` (`op`)
- `TODO` (`op`)
- `SETTINGS` (`op`)
- `MUSIC` (`op|action|music_op|command`)
- `WORKFLOW` (`action`, already)
- `SHOPIFY` (`action|op|entity|subaction`)
- `WALLET` (`subaction`)
- `LIQUIDITY` (`action`, already)
- `TOKEN_INFO` (`subaction`)
- `ENTITY` (`subaction`)
- `RESOLVE_REQUEST` (`subaction`)
- `CALENDAR` (`subaction`)
- `CONNECTOR` (`subaction`)
- `CREDENTIALS` (`subaction`)
- `MANAGE_SECRET` (`operation`) — covered by Task A
- `APP` (`mode`) — keep `mode` (intentional readability)

**Acceptance:**
- Every generated spec (JSON in `packages/prompts/specs/`) has primary
  discriminator named `action`. The dispatcher's legacy alias coverage is
  unchanged.
- Audit test: extend the existing "any schema exposing legacy aliases also
  exposes `action`" check to require `action` as the *canonical* (first)
  parameter and `op/subaction/operation` only as optional aliases.

### Task F — LifeOps dead-file cleanup (priority: high)

**Goal:** Delete the 14 unreachable lifeops action files OR convert them
into handlers without `Action` typing or `name:` field.

**Files (see §2.6 for the list):**
- `app-block.ts`, `autofill.ts`, `book-travel.ts`, `checkin.ts`,
  `device-intent.ts`, `health.ts`, `life.ts`, `money.ts`,
  `password-manager.ts`, `payments.ts`, `profile.ts`, `relationship.ts`,
  `schedule.ts`, `screen-time.ts`, `scheduling-negotiation.ts`,
  `subscriptions.ts`, `website-block.ts`, `first-run.ts`,
  `lifeops-pause.ts`, `message-handoff.ts`, `toggle-feature.ts`.

**Procedure (per file):**
1. If the umbrella delegates to it (via `lifeAction`, `healthAction`,
   `moneyAction`, etc.), convert the export from an `Action` to a plain
   handler function. Drop `name:`, `similes:`, `examples:`. Keep the
   `handler` and rename the export (e.g. `lifeOpsHealthHandler`).
2. If nothing imports it, delete the file.
3. Move `ownerProfileExtractionEvaluator` out of the `lifeops/profile/`
   subdirectory into `lifeops/owner/` and delete `profile.ts`.

**Acceptance:**
- 0 files under `plugins/app-lifeops/src/actions/` declare a `name:` field
  matching a retired-name guard entry.
- The lifeops audit test passes.
- Lifeops integration tests pass (the gating test checks owner-routing
  behavior; this must still work).

### Task G — Agent dead-action cleanup (priority: medium)

**Goal:** Remove the five unreachable `packages/agent/src/actions/` files.

**Files:**
- `media.ts` (ANALYZE_IMAGE) — replace with an attachment-image-analysis
  evaluator under `packages/core/src/features/basic-capabilities/
  evaluators/` (fires per inbound image attachment, writes to memory).
- `extract-page.ts` (EXTRACT_PAGE) — replace with a link-extraction
  evaluator on inbound messages.
- `trajectories.ts` (QUERY_TRAJECTORIES) — delete; trajectory-fetch
  belongs in dev tooling, not planner.
- `skill-command.ts` (SKILL_COMMAND) — delete (USE_SKILL covers it).
- `stream-control.ts` — verify usage; either register or delete.

**Acceptance:**
- The five names retired-name-guarded.
- Two new evaluators registered.
- `bun run --filter @elizaos/agent test` passes.

### Task H — Tunnel and coding-tools helper de-Action-ification (priority: medium)

**Goal:** Internal handler files for already-consolidated umbrellas stop
masquerading as `Action` objects.

**Files:**
- `plugins/plugin-tunnel/src/actions/start-tunnel.ts`, `stop-tunnel.ts`,
  `get-tunnel-status.ts` — drop the `Action` shape, expose a handler
  function (`startTunnelHandler`, etc.).
- `plugins/plugin-coding-tools/src/actions/read.ts`, `write.ts`,
  `edit.ts`, `grep.ts`, `glob.ts`, `ls.ts`, `bash.ts`, `web-fetch.ts`,
  `ask-user-question.ts`, `enter-worktree.ts`, `exit-worktree.ts` —
  drop the `Action` shape, expose handler functions.
- `plugins/plugin-app-control/src/actions/app-launch.ts`,
  `app-relaunch.ts`, `app-list.ts`, `app-load-from-directory.ts`,
  `app-create.ts` — drop the `Action` shape.

**Acceptance:**
- These files do not export an `Action`.
- Their parent umbrella still dispatches to them correctly.
- Tests for coding-tools, tunnel, and app-control pass.

### Task I — Music subaction renaming (priority: medium)

**Goal:** All `MUSIC` subactions are verb-shaped, discriminator is
`action`, single canonical name.

**Verbs (proposal):**
- Playback: `play`, `pause`, `resume`, `skip`, `stop`
- Queue: `queue_view`, `queue_add`, `queue_clear`
- Library: `playlist_play`, `playlist_save`, `search`, `play_query`,
  `play_audio`, `download`
- Routing: `set_routing`, `set_zone`
- Generation (if §3.4 absorbed): `generate`, `extend`, `custom_generate`

**Files:**
- `plugins/plugin-music/src/actions/music.ts` (rewrite subactions and
  discriminator).
- `plugins/plugin-suno/src/actions/musicGeneration.ts` (delete after
  folding into MUSIC if §3.4 chosen).
- Update audit test if `MUSIC_GENERATION` retired.

### Task J — Shopify, Tunnel, Linear, Contact discriminator cleanup (priority: medium)

**Goal:** Each provider umbrella exposes a single discriminator name
in its parameter schema (`action`) and accepts at most two legacy
aliases internally.

**Files:**
- `plugins/plugin-shopify/src/actions/shopify.ts`
- `plugins/plugin-linear/src/actions/linear.ts`
- `plugins/plugin-github/src/actions/github.ts`
- `plugins/plugin-tunnel/src/actions/tunnel.ts`
- `packages/agent/src/actions/contact.ts`

**Acceptance:**
- Each schema has exactly one primary discriminator named `action`.
- Internal handler keeps reading `op`/`subaction`/`operation` from
  parameters for back-compat.
- Generated specs reflect this.

### Task K — Entity / Contact alignment (priority: medium)

**Goal:** Either merge `CONTACT` and `ENTITY`, or align their verbs and
discriminator name without merging. Choose by writing the merge plan and
running it past the maintainer.

**If merging:** keep `CONTACT` as the planner name (rolodex is the
primary user concept), absorb the entity-graph operations as subactions:
`action=create|read|search|update|delete|link|merge|activity|followup|
log_interaction|set_identity|set_relationship`. Retire `ENTITY`.

**If not merging:** rename `ENTITY` discriminator to `action`, rename
`ENTITY action=add` to `action=create`, and align verbs row-by-row per
§2.11.

**Acceptance:** Two non-overlapping verb sets. Discriminator is `action`
in both.

### Task L — Singleton parents (priority: medium)

**Goal:** Promote singleton actions to NOUN-shaped parents where multiple
ops plausibly exist.

**Files:**
- `packages/core/src/features/advanced-planning/actions/create-plan.ts` →
  `PLAN action=create` umbrella.
- `packages/core/src/features/autonomy/action.ts` → either merge into
  `MESSAGE_HANDOFF` (if it survives) or rename `SEND_TO_ADMIN` to
  `ESCALATE action=admin|owner|third_party`.
- `plugins/plugin-form/src/actions/restore.ts` → `FORM action=restore`.
- `plugins/plugin-shell/actions/clearHistory.ts` → `SHELL_HISTORY
  action=clear|view` (or absorb into SHELL).
- `plugins/plugin-mysticism/src/actions/reading-op.ts` → rename
  `READING` → `MYSTICISM_READING` for consistency.

### Task M — Attachments and links auto-evaluation (priority: medium)

**Goal:** Replace the retired `ANALYZE_IMAGE` and `EXTRACT_PAGE` with
automatic evaluators.

**New files:**
- `packages/core/src/features/basic-capabilities/evaluators/attachment-image-analysis.ts`
- `packages/core/src/features/basic-capabilities/evaluators/link-extraction.ts`

Both fire on incoming messages and write findings to memory. They are
not planner actions. They run before `ATTACHMENT` so the planner sees
the analyzed result already.

**Acceptance:**
- `ANALYZE_IMAGE` and `EXTRACT_PAGE` retired-name-guarded.
- Two new evaluators registered in `basic-capabilities/index.ts`.
- Test that an image attachment produces an analysis memory record.

### Task N — Wallet analytics fold-in (priority: medium)

**Goal:** `TOKEN_INFO` and `walletSearchAddressAction` become
`WALLET action=token_info|search_address`.

**Files:**
- `plugins/plugin-wallet/src/chains/wallet-action.ts` (add subactions).
- `plugins/plugin-wallet/src/analytics/token-info/action.ts` (drop
  Action shape, expose handler).
- `plugins/plugin-wallet/src/analytics/birdeye/actions/wallet-search-
  address.ts` (drop Action shape).
- `plugins/plugin-wallet/src/plugin.ts` (drop both from `actions:`).

**Acceptance:**
- `TOKEN_INFO` and `BIRDEYE_SEARCH` (or whatever its current name)
  retired.
- `WALLET action=token_info` and `WALLET action=search_address` are
  promoted virtuals visible to planner.

### Task O — Empty plugin and dead-export cleanup (priority: low)

**Goal:** Remove plugin directories and exports that contribute nothing.

**Files / dirs:**
- `plugins/plugin-music-library/` (dist-only, no src) — delete.
- `plugins/plugin-music-player/` (dist-only, no src) — delete.
- `plugins/plugin-executecode/` (verify, then delete if empty).
- `plugins/app-phone/src/actions/place-call.ts` — remove the dead
  export.

**Acceptance:**
- No empty plugin directories under `plugins/`.
- The Android dialer either becomes a `VOICE_CALL` provider (preferred)
  or is documented as not connected.

### Task P — Connector vs. plugin-type naming (priority: low)

**Goal:** Make it clear that lifeops `CONNECTOR` is account-lifecycle
and agent `PLUGIN type=connector` is install/uninstall-lifecycle.

**Files:**
- `packages/agent/src/actions/plugin.ts` — sharpen the description to
  describe install/uninstall/configure; mention that account-level
  connect/disconnect is `CONNECTOR`.
- `plugins/app-lifeops/src/actions/connector.ts` — sharpen the
  description; mention that plugin install lives in `PLUGIN`.
- Both descriptions reference each other so the planner picks correctly.

**Acceptance:**
- No code change required; description and tests only.

### Task Q — `DESKTOP` shrink to `WINDOW` (priority: low)

**Goal:** `DESKTOP op=file|window|terminal` → `WINDOW action=list|focus|
move|minimize|maximize|restore|close`. File and terminal subactions move
into `FILE` and `SHELL`.

**Files:**
- `plugins/plugin-computeruse/src/actions/desktop.ts` (rewrite as
  `windowAction` with only window verbs).
- `plugins/plugin-computeruse/src/actions/desktop-handlers.ts` (drop
  file/terminal dispatch; keep window).
- `plugins/plugin-computeruse/src/index.ts` (register `windowAction`).

**Acceptance:**
- `DESKTOP` retired-name-guarded.
- `WINDOW` promoted, with the seven window verbs.
- `FILE` and `SHELL` cover the migrated ops (verify no regression).

### Task R — Hyperliquid + page-delegate gap (priority: low)

**Goal:** Document or implement the trading action surface for
`app-hyperliquid` parallel to `app-polymarket`'s `PREDICTION_MARKET`.

**Files:**
- `plugins/app-hyperliquid/src/actions/perpetual-market.ts` (new) or
  documentation in app README declaring no planner surface.

---

## 7. Verification protocol

Each task above must end with:

1. `bun run --filter <package> test` for the touched package and any
   package importing the touched module.
2. `node packages/prompts/scripts/generate-plugin-action-spec.js && node packages/prompts/scripts/generate-action-docs.js`
3. `bun run --filter @elizaos/core test packages/core/src/__tests__/action-structure-audit.test.ts plugins/app-lifeops/test/action-structure-audit.test.ts`
4. Confirm the retired-name guard contains every retired name introduced
   by the task.
5. Confirm no schema in `packages/prompts/specs/` exposes a legacy
   discriminator without also exposing `action`.

## 8. Out of scope for this audit

- **Action role gating** beyond what the consolidation requires. The
  existing `ACTION_ROLE_POLICY` (`packages/core`) and lifeops gating are
  separately maintained; this audit assumes they continue to function.
- **Action validators (`validate:`)** — those are runtime checks, not
  surface shape; they live with the handlers.
- **Routes** (`packages/core/src/features/.../routes`) are not actions
  even when they look adjacent.
- **Skills' inline action definitions** — out of scope unless they
  become a registered runtime path (currently they are not).
- **Page-action-group description tuning** — sub-tuning the description
  of one parent is style, not structure.

## 9. Summary

Compared to the 2026-05-10 state, the action surface is mostly correct.
The deepest remaining defect is **persisting atomic-leaf fragmentation
inside `packages/core`** — secrets (7 leaves), todos (5 leaves), and trust
(4 leaves) all expose the same shape the consolidation rules prohibit.
After those three umbrellas are built, the second-largest issue is the
`_ACTIONS`-suffixed page-group parents in `packages/agent`. The third is
**dead source files** carrying retired `name:` fields that the guard now
blocks from generated docs but that still mislead anyone reading the
source. Beyond those, the rest is naming polish: discriminator
canonicalization, music verb shape, wallet analytics fold-in, and the
small singletons (CLEAR_HISTORY, FORM_RESTORE, READING).

Tasks A–E are the critical blockers; F–H are necessary cleanup; I–O are
polish; P–R are nice-to-have. Tasks A, B, C, D, E, F, G, H can run in
parallel because they touch disjoint files and tests. Tasks I–O can run
once A–E land. Tasks P, Q, R are independent and can run anytime.
