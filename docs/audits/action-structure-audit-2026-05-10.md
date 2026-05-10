# Action and Subaction Structure Audit - 2026-05-10

Scope: production source action surfaces under `packages/core/src`,
`packages/agent/src`, and `plugins/`, excluding `node_modules`, `dist`,
generated specs, tests, `packages/examples`, `cloud/examples`, benchmark
harnesses, and benchmark datasets.

This audit is structural. It answers:

- What each action family does.
- Which subactions are grouped below it.
- Why that parent is the logical parent and why the name mostly fits.
- Which grouping, naming, or ordering defects should be fixed.

Implementation note: after this audit was drafted, the canonical
discriminator was changed to `action` with legacy aliases still accepted, and
the highest-impact public surfaces were consolidated. The current target
taxonomy is now: `FILE`, `SHELL`, `WORKTREE`, `TASKS`, `OWNER_REMINDERS`,
`OWNER_ALARMS`, `OWNER_GOALS`, `OWNER_TODOS`, `OWNER_HEALTH`,
`OWNER_SCREENTIME`, `OWNER_ROUTINES`, `OWNER_FINANCES`, `PERSONAL_ASSISTANT`,
`GITHUB`, `LINEAR`, `TUNNEL`, `MUSIC`, and `ROBLOX`. Older names such as
`LIFE`, `SCHEDULED_TASK`, `MONEY`, `HEALTH`, `SCREEN_TIME`, `BASH`,
`READ`/`WRITE`/`EDIT`/`GREP`/`GLOB`/`LS`, `GITHUB_PR_OP`,
`GITHUB_ISSUE_OP`, `ROBLOX_ACTION`, `FORM_RESTORE`, `EXTRACT_PAGE`,
`ANALYZE_IMAGE`, `SKILL_COMMAND`, and `QUERY_TRAJECTORIES` should be treated
as legacy implementation/export names unless still explicitly registered by a
package outside the consolidation pass.

## Model Used By The Codebase

There are three action shapes in this repository:

1. Flat leaf actions: a single action with no subaction discriminator, for
   example `BASH`, `READ`, `BOOK_TRAVEL`, `PLACE_CALL`.
2. Umbrella actions: one registered parent with a discriminator parameter,
   usually `subaction`, and a switch/dispatcher in its handler. Examples:
   `LIFE`, `MESSAGE`, `BROWSER`, `LINEAR`, `SKILL`.
3. Promoted virtual actions: `promoteSubactionsToActions(parent)` creates
   virtual top-level action names like `LIFE_CREATE` or `MESSAGE_SEND`.
   These virtuals delegate to the parent handler and inject
   `subaction: <value>`.

The intended parent is therefore the semantic domain owner: `MESSAGE` owns
messaging verbs, `LIFE` owns personal task primitives, `CALENDAR` owns calendar
and availability work, and so on. A child belongs under that parent when it
shares the same data model, service boundary, authorization policy, account
policy, and result semantics.

## Parent Families

### Conversation And Messaging

| Parent | Subactions / Children | What It Does | Parent Rationale | Issues |
|---|---|---|---|---|
| `REPLY` | none | Replies in the current chat. | It is a leaf because it has no external side effect. Name is direct. | Good. |
| `IGNORE` | none | Intentionally emits no reply. | Leaf because it is turn-control, not a domain operation. | Good, but examples are English-only. |
| `NONE` | none | Responds without extra tool work. | Leaf for no-op conversational behavior. | Good. |
| `MESSAGE` | `send`, `read_channel`, `read_with_contact`, `search`, `list_channels`, `list_servers`, `join`, `leave`, `react`, `edit`, `delete`, `pin`, `get_user`, `triage`, `list_inbox`, `search_inbox`, `draft_reply`, `draft_followup`, `respond`, `send_draft`, `schedule_draft_send`, `manage` | Unified connector-backed messaging, inbox, draft, send, and moderation surface. | Correct parent: all children operate on messages, inboxes, drafts, channels, or message connectors. The name is broad but accurate. | Too many modes for one family; subactions mix connector primitives with executive-assistant inbox workflows. Needs more examples and stronger subgroup docs. |
| `POST` | `send`, `read`, `search` | Public/feed post operations. | Correctly separate from `MESSAGE`: posts are public/timeline content, not private/channel messages. | Good. Keep separate from `MESSAGE`. |
| `MESSAGE_HANDOFF` | `enter`, `resume`, `status` via `verb` | Stops/restarts agent participation in a room handoff. | Conceptually belongs near `MESSAGE`, but state is LifeOps room policy, not generic connector messaging. | Uses `verb`, not `subaction`. Earlier reports mention `MESSAGE.handoff`; current name is fixed to `MESSAGE_HANDOFF`. Consider folding into `MESSAGE` only if generic connectors need it. |
| `ROOM` | `follow`, `unfollow`, `mute`, `unmute` | Changes room participation/notification state. | Parent is room-level policy rather than message content. Name fits. | Not currently promoted in all paths; keep separate from `MESSAGE` because target is the room, not a message. |

### LifeOps

| Parent | Subactions / Children | What It Does | Parent Rationale | Issues |
|---|---|---|---|---|
| `LIFE` | `create`, `update`, `delete`, `complete`, `skip`, `snooze`, `review`, `policy_set_reminder`, `policy_configure_escalation` | Manages owner habits, routines, reminders, alarms, todos, and goals. | Correct parent for personal life primitives. Name is broad but matches product domain. | It is overloaded. `create` needs `kind`/`definitionKind` to disambiguate tasks vs goals vs habits. |
| `SCHEDULED_TASK` | `list`, `get`, `create`, `update`, `snooze`, `skip`, `complete`, `dismiss`, `cancel`, `reopen`, `history` | Direct CRUD/state control over the `ScheduledTask` spine. | Correct parent because AGENTS.md says all reminders, check-ins, follow-ups, watchers, approvals, outputs, and recaps route through `ScheduledTask`. | Good architecture. The user-facing difference between `LIFE` and `SCHEDULED_TASK` should be documented more sharply. |
| `LIFEOPS` | `pause`, `resume`, `wipe` via `verb` | Global pause/resume/wipe controls. | Parent is app-level control, not an individual task. Name fits. | Uses `verb` instead of canonical `subaction`. |
| `PROFILE` | `save`, `capture_phone` | Stores durable owner facts and phone info. | Correct parent for owner profile state. | Should not absorb goals/preferences that belong in `LIFE`; current descriptions call that out. |
| `ENTITY` | `add`, `list`, `log_interaction`, `set_identity`, `set_relationship`, `merge` | People/org/relationship graph operations. | Correct parent for identity and relationship records. | Overlaps legacy `RELATIONSHIP`; consolidate docs and examples around `ENTITY`. |
| `RELATIONSHIP` | `list_contacts`, `add_contact`, `log_interaction`, `add_follow_up`, `complete_follow_up`, `follow_up_list`, `days_since`, `list_overdue_followups`, `mark_followup_done`, `set_followup_threshold` | Legacy relationship/follow-up surface. | Historically parented relationship and cadence features. | Superseded conceptually by `ENTITY` plus `SCHEDULED_TASK`; keep only if needed for compatibility. |
| `BLOCK` | `block`, `unblock`, `status`, `request_permission`, `release`, `list_active` | Website/app blocking and managed block rules. | Correct consolidated parent: block lifecycle shares permissions, confirmation, and state. | Good consolidation. Legacy `APP_BLOCK` and `WEBSITE_BLOCK` still exist in source and can confuse audits. |
| `APP_BLOCK` | `block`, `unblock`, `status` | Native phone app blocking. | Valid domain slice, now logically child of `BLOCK`. | Treat as legacy/specialized implementation behind `BLOCK`. |
| `WEBSITE_BLOCK` | `block`, `unblock`, `status`, `request_permission`, `release`, `list_active` | Desktop website blocking. | Valid domain slice, now logically child of `BLOCK`. | Treat as legacy/specialized implementation behind `BLOCK`. |
| `MONEY` | `dashboard`, `list_sources`, `add_source`, `remove_source`, `import_csv`, `list_transactions`, `spending_summary`, `recurring_charges`, `subscription_audit`, `subscription_cancel`, `subscription_status` | Payments, transaction summaries, recurring charges, and subscriptions. | Correct parent because spending and subscriptions share financial source data. | Subscriptions are a distinct workflow; grouping is acceptable but descriptions must make cancellation side effects obvious. |
| `PAYMENTS` | `dashboard`, `list_sources`, `add_source`, `remove_source`, `import_csv`, `list_transactions`, `spending_summary`, `recurring_charges` | Payment-source and transaction analytics. | Logically child of `MONEY`. | Legacy/specialized surface. |
| `SUBSCRIPTIONS` | `audit`, `cancel`, `status` | Subscription audit and cancellation. | Logically child of `MONEY` because cancellation depends on recurring-charge evidence. | Cancellation is risky; preserve confirmation and browser-handoff gates. |
| `CREDENTIALS` | `fill`, `whitelist_add`, `whitelist_list`, `search`, `list`, `inject_username`, `inject_password` | Password-manager lookup, autofill whitelist, and clipboard-only injection. | Correct parent for all credential handling. | Good consolidation, but the child set mixes browser autofill and password search. Keep gating strict. |
| `AUTOFILL` | `fill`, `whitelist_add`, `whitelist_list` | Browser autofill allowlist flow. | Logically child of `CREDENTIALS`. | Legacy/specialized surface. |
| `PASSWORD_MANAGER` | `search`, `list`, `inject_username`, `inject_password` | Password-manager lookup and clipboard injection. | Logically child of `CREDENTIALS`. | Legacy/specialized surface. |
| `CALENDAR` | `feed`, `next_event`, `search_events`, `create_event`, `update_event`, `delete_event`, `trip_window`, `bulk_reschedule`, `check_availability`, `propose_times`, `update_preferences` | Calendar reads/writes, availability, travel windows, and meeting preferences. | Correct parent: all children use calendar state or scheduling preferences. | Large but coherent. `SCHEDULING_NEGOTIATION` stays separate because it is multi-turn workflow state. |
| `GOOGLE_CALENDAR` | `feed`, `next_event`, `search_events`, `create_event`, `update_event`, `delete_event`, `trip_window` | Google Calendar-specific implementation. | Logically child/backend of `CALENDAR`. | Avoid exposing both unless needed for compatibility. |
| `CALENDLY` | `list_event_types`, `availability`, `upcoming_events`, `single_use_link` | Calendly-specific reads/link creation. | It is a vendor child of scheduling, not generic calendar. | Could be under `CALENDAR` if all scheduling providers are unified later. |
| `SCHEDULING_NEGOTIATION` | `start`, `propose`, `respond`, `finalize`, `cancel`, `list_active`, `list_proposals` | Multi-turn scheduling proposals and negotiation state. | Correct separate parent: it owns workflow state, not simple calendar CRUD. | Good separation. |
| `SCHEDULE` | `summary`, `inspect` | Passive schedule inference from activity/screen-time/health. | Parent name is generic; child set is read-only inference. | Risk of confusion with calendar scheduling. Consider `SCHEDULE_INFERENCE`. |
| `CHECKIN` | none | Runs morning/night LifeOps check-ins. | Leaf because `kind` is not a structural subaction; it is a check-in type. | Fine. |
| `HEALTH` | `today`, `trend`, `by_metric`, `status` | Reads health/fitness telemetry. | Correct parent: all children are read-only health queries. | Good. |
| `SCREEN_TIME` | `summary`, `today`, `weekly`, `weekly_average_by_app`, `by_app`, `by_website`, `activity_report`, `time_on_app`, `time_on_site`, `browser_activity` | Reads device/app/site usage analytics. | Correct parent for screen/activity telemetry. | Broad but read-only and coherent. |
| `CONNECTOR` | `connect`, `disconnect`, `verify`, `status`, `list` | External service connector lifecycle. | Correct LifeOps connector parent. | Do not merge with `PLUGIN`; plugin lifecycle is runtime code, not user accounts. |
| `DEVICE_INTENT` | `broadcast` | Pushes one-shot intents to paired devices. | Leaf-ish parent for device fanout; only one subaction. | If only one child remains, consider flattening unless more device ops are planned. |
| `REMOTE_DESKTOP` | `start`, `status`, `end`, `list`, `revoke` | Remote desktop session lifecycle. | Correct parent: all children operate on sessions. | Uses direct subaction enum but is not promoted; decide if it should be. |
| `RESOLVE_REQUEST` | `approve`, `reject` | Resolves pending owner approval queue items. | Correct parent for approval decisions. | Good. |
| `VOICE_CALL` | `dial` | Drafts/confirms/escalates Twilio voice calls. | Parent has one child because future voice ops are plausible. | If no more child ops are expected, flatten to `VOICE_CALL` params. |
| `BOOK_TRAVEL` | none | Drafts/approves real travel booking. | Leaf because the workflow itself is one bounded capability. | Good. |
| `FIRST_RUN` | none | Runs defaults/customize/replay onboarding. | It uses mode-like inputs, but app lifecycle is narrow enough as a leaf. | Fine. |
| `TOGGLE_FEATURE` | enable/disable via parameters | Feature flag control. | Leaf because feature key carries the specific target. | Name is clear. |

### Agent Runtime And Memory

| Parent | Subactions / Children | What It Does | Parent Rationale | Issues |
|---|---|---|---|---|
| `CONTACT` | `create`, `read`, `search`, `update`, `delete`, `link`, `merge`, `activity`, `followup` | Rolodex/contact operations in the agent runtime. | Correct parent: shared contact graph and entity-resolution semantics. | Overlaps LifeOps `ENTITY`; clarify which package owns public contact UX. |
| `PLUGIN` | `install`, `uninstall`, `update`, `sync`, `eject`, `reinject`, `configure`, `read_config`, `toggle`, `list`, `disconnect` | Runtime plugin/connector management. | Correct parent for runtime/plugin lifecycle. | `disconnect` overlaps LifeOps `CONNECTOR.disconnect`; keep separate because service boundary differs. |
| `RUNTIME` | `status`, `self_status`, `describe_actions`, `reload_config`, `restart` | Runtime introspection and control. | Correct parent for process/runtime state. | Good. |
| `DATABASE` | `list_tables`, `get_table`, `query`, `search_vectors` | Read/query runtime database. | Correct parent for DB inspection. | Make write/default-read-only policy explicit wherever exposed. |
| `LOGS` | `search`, `delete`, `set_level` | Agent log search/deletion/log-level control. | Correct parent for logs. | Destructive `delete` should stay owner-gated. |
| `MEMORY` | `create`, `search`, `update`, `delete` | Agent memory CRUD. | Correct parent for memory store. | Good, but update/delete confirmation should remain prominent. |
| `TRIGGER` | `create`, `update`, `delete`, `run`, `toggle` | Trigger lifecycle for interval/once/cron events. | Correct parent for trigger records. | Uses canonical promotion now, but needs examples and similes. |
| `EXTRACT_PAGE` | output modes `html`, `links`, `markdown`, `screenshot` | Extracts page content through a host tool. | Leaf with mode parameter, not true subactions. | Good. |
| `SETTINGS` | settings mutation dispatch | Owner-only settings mutation. | Parent is broad runtime settings state. | Parser did not recover all subactions; needs clearer explicit schema. |
| `QUERY_TRAJECTORIES` | status/source filters | Reads trajectory records. | Leaf read action. | Good. |
| `SHELL_COMMAND` | none | Runs an explicit shell command through older agent surface. | Leaf because command is the operation. | Overlaps `BASH`; choose canonical public shell action. |
| `SKILL_COMMAND` | none | Dispatches slash skill commands. | Leaf command parser. | Separate from `SKILL` catalog and `USE_SKILL` invocation. |
| `ANALYZE_IMAGE` | none | Vision analysis of image attachment/input. | Leaf media analysis. | Appears exported but not always registered; confirm intended exposure. |
| `READ_ATTACHMENT` | none | Reads recent/current attachments and link previews. | Leaf context-read action. | Good. |

### Developer, Browser, And Automation Tools

| Parent | Subactions / Children | What It Does | Parent Rationale | Issues |
|---|---|---|---|---|
| `BROWSER` | `back`, `click`, `close`, `forward`, `get`, `hide`, `navigate`, `open`, `press`, `reload`, `screenshot`, `show`, `snapshot`, `state`, `tab`, `type`, `wait`, `realistic-click`, `realistic-fill`, `realistic-type`, `realistic-press`, `cursor-move`, `cursor-hide`, `autofill-login` | Browser tab/page control across workspace, bridge, and computeruse targets. | Correct parent: all children operate on a browser target. | Very large. It still has legacy `action` alias with extra values. Keep `subaction` canonical. |
| `MANAGE_BROWSER_BRIDGE` | `install`, `reveal_folder`, `open_manager`, `refresh` | Browser companion extension setup/status. | Correctly separate from `BROWSER`: it manages bridge infrastructure, not page content. | Good. |
| `COMPUTER_USE` | `screenshot`, `click`, `click_with_modifiers`, `double_click`, `right_click`, `mouse_move`, `type`, `key`, `key_combo`, `scroll`, `drag`, `detect_elements`, `ocr` | Cross-platform desktop/mouse/keyboard/screen control. | Correct parent: all children are direct GUI operations. | Uses `action`, not `subaction`; migrate schema aliasing carefully. |
| `DESKTOP` | `screenshot`, `ocr`, `detect_elements` plus file/window/terminal intent in description | Legacy/alternate desktop operation group. | Parent name is broad but child set is currently reserved/partial. | Confusing overlap with `COMPUTER_USE` and coding tools. Reassess exposure. |
| `BASH` | none | Runs shell command. | Leaf because command string is the operation. | Good. |
| `READ` | none | Reads file. | Leaf coding tool. | Good. |
| `WRITE` | none | Writes file. | Leaf coding tool. | Good. |
| `EDIT` | none | Exact string replacement in file. | Leaf coding tool. | Good. |
| `GREP` | output modes `content`, `files_with_matches`, `count` | Searches files with ripgrep. | Leaf with output mode, not domain subactions. | Good. |
| `GLOB` | none | Finds files by glob. | Leaf. | Good. |
| `LS` | none | Lists directory. | Leaf. | Good. |
| `WEB_FETCH` | none | Fetches HTTP(S) text. | Leaf. | Good. |
| `ASK_USER_QUESTION` | none | Broadcasts structured questions to UI. | Leaf because question array defines content. | Non-blocking semantics should be explicit in every planner surface. |
| `ENTER_WORKTREE` | none | Creates/switches git worktree. | Leaf. | Good. |
| `EXIT_WORKTREE` | none | Exits/removes worktree. | Leaf. | Good. |
| `MCP` | `call_tool`, `read_resource`, `search_actions`, `list_connections` | MCP tool/resource routing. | Correct parent: same MCP connection registry and result adapter. | Good. |
| `WORKFLOW` | `create`, `modify`, `activate`, `deactivate`, `toggle_active`, `delete`, `executions` via `op` | Workflow lifecycle. | Correct parent for workflow records. | Uses `op`; migrate toward `subaction` docs. |
| `TASKS` | `create`, `spawn_agent`, `send`, `stop_agent`, `list_agents`, `cancel`, `history`, `control`, `share`, `provision_workspace`, `submit_workspace`, `manage_issues`, `archive`, `reopen` | Agent-orchestrator task and subagent lifecycle. | Correct parent for orchestrator task state. | Large and high-risk; needs examples per workflow. |

### External Apps And SaaS

| Parent | Subactions / Children | What It Does | Parent Rationale | Issues |
|---|---|---|---|---|
| `LINEAR` | `create_issue`, `get_issue`, `update_issue`, `delete_issue`, `create_comment`, `update_comment`, `delete_comment`, `list_comments`, `get_activity`, `clear_activity`, `search_issues` | Linear issue/comment/activity operations. | Correct parent: all children share Linear account/service. | Helper actions also exist (`CREATE_LINEAR_ISSUE`, etc.). Keep helpers internal or expose them intentionally, not both ambiguously. |
| `LINEAR_ISSUE` | `create`, `get`, `update`, `delete` | Router slice for Linear issues. | Logical subgroup under `LINEAR`. | If exposed, duplicates `LINEAR` naming. |
| `LINEAR_COMMENT` | `create` | Router slice for Linear comments. | Logical subgroup under `LINEAR`. | One-child parent; probably internal. |
| `LINEAR_WORKFLOW` | `get_activity`, `clear_activity`, `search_issues` | Router slice for Linear activity/search. | Logical subgroup under `LINEAR`. | Internal/helper candidate. |
| `GitHubActions.GITHUB_PR_OP` | PR list/review actions | GitHub PR operations. | Correct parent for PR-specific GitHub work. | Name resolves from enum property and is awkward in audits; ensure runtime name is plain string. |
| `GitHubActions.GITHUB_ISSUE_OP` | issue create/assign/close/reopen/comment/label | GitHub issue operations. | Correct sibling to PR parent; issue lifecycle differs from PR review. | Same enum-name audit issue. |
| `GitHubActions.GITHUB_NOTIFICATION_TRIAGE` | notification triage | Reads/scorers GitHub notifications. | Leaf because it is a single read/triage workflow. | Good. |
| `SHOPIFY` | `search`, `products`, `inventory`, `orders`, `customers` | Shopify store operations. | Correct parent: same store/account boundary. | Values are domain nouns rather than verbs; acceptable, but subhandlers need clear second-stage operation names. |
| `DISCORD_SETUP_CREDENTIALS` | none | Configures Discord credentials. | Leaf setup action. | Good. |
| `NOSTR_PUBLISH_PROFILE` | none | Publishes Nostr kind-0 profile metadata. | Leaf. | Good. |
| `FORM_RESTORE` | none | Restores stashed form state. | Leaf. | Good. |

### Skills, Media, Music, Wallet, Games

| Parent | Subactions / Children | What It Does | Parent Rationale | Issues |
|---|---|---|---|---|
| `SKILL` | `search`, `details`, `sync`, `toggle`, `install`, `uninstall` | Skill catalog management. | Correct parent: all children manage the skill registry/install state. | Helper files also use `name: "SKILL"`. This pattern is valid but hard to audit. Needs more similes/examples. |
| `USE_SKILL` | mode `guidance`, `script`, `auto` | Invokes an enabled skill. | Correctly separate from `SKILL`: using a skill is not catalog management. | Keep separate. |
| `GENERATE_MEDIA` | media type image/video/audio | Generates media from prompt. | Leaf with media type parameter. | Source uses `spec.name`; ensure generated spec stays current. |
| `MUSIC` | `playlist`, `play_query`, `search_youtube`, `download`, `pause`, `resume`, `skip`, `stop`, `queue`, `play_audio`, `routing`, `zones` | Music playback, library, playlist, routing, and zones. | Parent is user-facing music intent. | Too broad: playback, library management, and routing are distinct service boundaries. If kept, add examples for each subgroup. |
| `MUSIC_LIBRARY` | `playlist`, `play_query`, `search_youtube`, `download` | Music library/search/download operations. | Logical child of `MUSIC`. | Helper-style action. Good boundary if exposed separately. |
| `PLAYBACK` | `pause`, `resume`, `skip`, `stop`, `queue` | Playback state operations. | Logical child of `MUSIC`. | Good subgroup. |
| `PLAY_AUDIO` | none | Plays a new song/query/URL. | Logical child of `MUSIC`, but leaf shape is fine. | Good. |
| `MANAGE_ROUTING` | `set_mode`, `start_route`, `stop_route`, `status` | Audio routing. | Logical child of `MUSIC`. | If exposed, name is clear. |
| `MANAGE_ZONES` | `create`, `delete`, `list`, `add`, `remove`, `show` | Audio zones. | Logical child of `MUSIC`. | Good. |
| `MUSIC_GENERATION` | `generate`, `custom`, `extend` | Suno music generation. | Separate parent because it creates audio, not playback/library state. | Good. |
| `WALLET` | `transfer`, `swap`, `bridge`, `gov` | Wallet token operations across chains. | Correct parent: shared wallet/router risk and chain registry. | High-risk side effects; keep dry-run/prepare confirmation clear. |
| `LIQUIDITY` | `onboard`, `list_pools`, `open`, `close`, `reposition`, `list_positions`, `get_position`, `set_preferences` | LP/liquidity position management. | Correct separate parent: LP positions are not simple token transfers. | Good. |
| `TOKEN_INFO` | `search`, `token`, `trending`, `new-pairs`, `chain-pairs`, `boosted`, `profiles`, `wallet` | Crypto token/market information. | Correct separate parent: read-only analytics, not wallet mutation. | Mixed kebab naming (`new-pairs`) differs from most snake_case subactions. |
| `PAYMENT` | `check`, `request` | Mysticism payment request/status. | Correct plugin-local parent. | Name is generic; okay only inside plugin context. |
| `READING` | `start`, `followup`, `deepen` | Mysticism readings. | Correct parent: all children are reading lifecycle operations. | Good. |
| `VISION` | `describe`, `capture`, `set_mode`, `name_entity`, `identify_person`, `track_entity` | Vision/camera/screen perception. | Correct parent: shared perception service and memory. | Good. |
| `TAILSCALE` | `start`, `stop` | Tailscale tunnel control. | Parent name is provider-specific. | Overlaps generic `TUNNEL`; prefer `TUNNEL` unless provider-specific control is required. |
| `TUNNEL` | `start`, `stop`, `status` via `op` | Generic tunnel operations. | Better parent than provider-specific names. | Uses `op`; migrate docs. |
| `START_TUNNEL`, `STOP_TUNNEL`, `GET_TUNNEL_STATUS` | none | Ngrok-specific tunnel leaves. | Provider-specific legacy/sibling leaves. | Keep only if ngrok direct actions are intentionally exposed. |
| `RS_2004` | `walk_to`, `chop`, `mine`, `fish`, `burn`, `cook`, `fletch`, `craft`, `smith`, `drop`, `pickup`, `equip`, `unequip`, `use`, `use_on_item`, `use_on_object`, `open`, `close`, `deposit`, `withdraw`, `buy`, `sell`, `attack`, `cast_spell`, `set_style`, `eat`, `talk`, `navigate_dialog`, `interact_object`, `open_door`, `pickpocket` | 2004Scape game actions. | Correct game-domain parent. | Large and app-specific; out of main assistant taxonomy but not benchmark/example code. |
| `SCAPE` | `walk_to`, `attack`, `chat_public`, `eat`, `drop`, `set_goal`, `complete_goal`, `remember` | Scape game/autonomy actions. | Correct game-domain parent. | App-specific. |
| `MC` | `connect`, `disconnect`, `goto`, `stop`, `look`, `control`, `waypoint_goto`, `dig`, `place`, `chat`, `attack`, `waypoint_set`, `waypoint_delete` | Minecraft bot control. | Correct game-domain parent. | App-specific. |
| `ROBLOX_ACTION` | `message`, `execute`, `get_player` | Roblox game bridge. | Correct game-domain parent. | Name has `_ACTION` suffix while most parents do not. |
| `PREDICTION_MARKET` | `read`, `place-order` | Polymarket read/order router. | Correct parent for market actions. | Hyphenated `place-order` differs from snake_case convention. |
| `PLACE_CALL` | none | Android phone call placement. | Leaf app-phone action. | Separate from LifeOps `VOICE_CALL`; decide which is canonical per platform. |
| `PLAY_EMOTE` | none | Avatar emote animation. | Leaf visual side action. | Good. |

## Defects And Improvement Opportunities

1. Canonical discriminator is still inconsistent. The code defines
   `CANONICAL_SUBACTION_KEY = "subaction"`, but current actions still expose
   `action` (`BROWSER`, `COMPUTER_USE`), `op` (`WORKFLOW`, `TUNNEL`), and
   `verb` (`LIFEOPS`, `MESSAGE_HANDOFF`). Keep aliases, but make new schemas
   document `subaction` first.

2. Some consolidated parents coexist with legacy/specialized actions in
   source: `BLOCK` vs `APP_BLOCK`/`WEBSITE_BLOCK`, `MONEY` vs
   `PAYMENTS`/`SUBSCRIPTIONS`, `CREDENTIALS` vs `AUTOFILL`/`PASSWORD_MANAGER`,
   `CALENDAR` vs `GOOGLE_CALENDAR`/`CALENDLY`, and `ENTITY` vs
   `RELATIONSHIP`. That may be acceptable for compatibility, but generated
   action docs and runtime exposure should make one canonical owner explicit.

3. Several parents are too broad for planner learning without examples:
   `MESSAGE`, `BROWSER`, `MUSIC`, `TASKS`, `SCHEDULED_TASK`, `CALENDAR`, and
   `COMPUTER_USE`. Add at least one example per major subgroup, not one
   example per every low-level child.

4. Duplicate/helper action names make source audits difficult. `MESSAGE`
   helper actions and `SKILL` helper actions reuse the parent name. Runtime
   dispatch can handle this, but static tooling should label them
   `parent=...` explicitly.

5. Naming style is mostly snake_case, but there are exceptions:
   `realistic-click`, `new-pairs`, `place-order`, and provider enum names
   like `GitHubActions.GITHUB_PR_OP` in static extraction. Prefer snake_case
   for new subaction values and reserve kebab-case as legacy aliases.

6. `SCHEDULE` is semantically "schedule inference", not calendar scheduling.
   Renaming to `SCHEDULE_INFERENCE` would reduce confusion with `CALENDAR`
   and `SCHEDULING_NEGOTIATION`.

7. `DESKTOP` overlaps `COMPUTER_USE` and coding tools. If `DESKTOP` is meant
   as a future file/window/terminal umbrella, give it real subactions. If not,
   route screenshots/OCR/elements through `COMPUTER_USE` only.

8. Tunnels have three surfaces: generic `TUNNEL`, provider-specific
   `TAILSCALE`, and ngrok leaves. Prefer generic `TUNNEL` for planner-facing
   routing and keep provider leaves internal or advanced.

9. High-risk financial and wallet actions (`WALLET`, `LIQUIDITY`,
   `PREDICTION_MARKET`, `MONEY.subscription_cancel`) should consistently
   expose prepare/dry-run/confirmed semantics in descriptions and examples.

10. Game/app-specific parents (`RS_2004`, `SCAPE`, `MC`, `ROBLOX_ACTION`) are
    structurally fine but should stay context-gated so they do not pollute
    normal assistant action retrieval.

## Recommended Logical Ordering

For planner surfaces, order parents from safest/commonest to riskiest:

1. Conversation control: `REPLY`, `IGNORE`, `NONE`.
2. Read-only context: `READ_ATTACHMENT`, `HEALTH`, `SCREEN_TIME`,
   `SCHEDULE`, `TOKEN_INFO`, `QUERY_TRAJECTORIES`.
3. Communication drafts and reads: `MESSAGE`, `POST`, `ROOM`.
4. Personal organization: `LIFE`, `SCHEDULED_TASK`, `CALENDAR`,
   `SCHEDULING_NEGOTIATION`, `PROFILE`, `ENTITY`.
5. Local/browser/computer operations: `BROWSER`, `COMPUTER_USE`, coding tools,
   `MCP`, `WORKFLOW`, `TASKS`.
6. Admin/runtime: `PLUGIN`, `CONNECTOR`, `RUNTIME`, `DATABASE`, `LOGS`,
   `MEMORY`, `TRIGGER`, `SETTINGS`, `SKILL`.
7. High-risk side effects: `CREDENTIALS`, `BLOCK`, `MONEY`, `VOICE_CALL`,
   `BOOK_TRAVEL`, `WALLET`, `LIQUIDITY`, `PREDICTION_MARKET`.
8. Context-gated app/game surfaces: `RS_2004`, `SCAPE`, `MC`, `ROBLOX_ACTION`,
   `PLAY_EMOTE`.

## Immediate Fix List

1. Document canonical parent ownership for each consolidated LifeOps family.
2. Finish discriminator cleanup: every umbrella should document `subaction`
   first, with `op`/`action`/`operation`/`verb` as aliases only where needed.
3. Add examples to `MESSAGE`, `SCHEDULED_TASK`, `MUSIC`, `TASKS`,
   `COMPUTER_USE`, and `BROWSER`.
4. Decide canonical tunnel surface: `TUNNEL` vs `TAILSCALE` vs ngrok leaves.
5. Decide canonical todo surface: core `TODO` leaves/umbrella vs
   `plugin-todos` `TODO`.
6. Rename or clarify `SCHEDULE`.
7. Keep legacy LifeOps leaf actions out of generated planner docs unless
   intentionally exposed.
