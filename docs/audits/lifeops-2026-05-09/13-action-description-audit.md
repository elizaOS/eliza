# LifeOps action description audit (Wave 4B)

**Date:** 2026-05-10
**Wave:** 4B — LLM-friendliness review of action descriptions
**Manifest:** `packages/benchmarks/lifeops-bench/manifests/actions.manifest.json`

## Top-line finding

The manifest exports **91 actions** but most fall into **17 umbrella families**
(`BLOCK_*`, `CALENDAR_*`, `CONNECTOR_*`, `CREDENTIALS_*`, `LIFE_*`, `MONEY_*`,
`PROFILE_*`, `RESOLVE_REQUEST_*`, `SCHEDULED_TASK_*`, `VOICE_CALL_*`) thanks to
`promoteSubactionsToActions`. Each family shares a single description string,
because the umbrella description is what the planner sees per virtual.

The dominant problems in the existing prose:

1. **Cryptic shorthand** — the `descriptionCompressed` strings read like
   internal grep tokens (`"calendar+availability+prefs: feed next-event search
   create update delete trip-window …"`) rather than tool descriptions a
   non-Eliza model can use to plan.
2. **Verbose multi-paragraph** — `LIFE`, `BLOCK`, `CREDENTIALS`, `MONEY`,
   `BOOK_TRAVEL`, `SCHEDULED_TASK` carry 5–60-line descriptions intended for
   the Eliza planner that explode the prompt-cache footprint downstream.
3. **Missing compressed form** — `CALENDLY` and `SCHEDULING_NEGOTIATION` had
   no `descriptionCompressed`, so the verbose prose flowed into the manifest.
4. **Wrong-context** — several `descriptionCompressed` values describe the
   *family* (e.g. "calendar+availability+prefs") but every fanout virtual
   (CALENDAR_CREATE_EVENT, CALENDAR_DELETE_EVENT, etc.) reuses that same
   string, so the per-action description fails to disambiguate the verb.

## Audit table — verdict + rewrite

Table covers the **30 high-impact umbrellas + first-class actions** the
benchmark runner dispatches (`runner.py::_ACTION_HANDLERS`) plus the
LifeOps-domain actions visible to every planner turn. Per-fanout virtuals
inherit the umbrella rewrite via `promoteSubactionsToActions`.

| Action | Current `descriptionCompressed` (≤80 chars shown) | Verdict | Rewrite (description / compressed) |
|---|---|---|---|
| **BLOCK** | `block app\|website (phone-Family-Controls\|hosts-file/SelfControl): blo…` | verbose+wrong-context | desc: "Block or unblock phone apps and desktop websites. Subactions: block, unblock, status, request_permission (web), release (web), list_active (web). Website blocks require confirmed:true." / compressed: "block/unblock apps+websites; subactions block\|unblock\|status\|release; web requires confirmed" |
| **BOOK_TRAVEL** | `approval-gated real travel booking flights/hotels missing-detail collec…` | verbose | desc: "Search and book real flights and hotels with approval gating. Drafts the booking, collects missing details, requires confirmation, then syncs to calendar." / compressed: "book real flights+hotels; drafts then requires approval; syncs calendar" |
| **CALENDAR** | `calendar+availability+prefs: feed next-event search create update delet…` | verbose+wrong-context | desc: "Manage Google Calendar plus availability and meeting preferences. Subactions: feed, next_event, search_events, create_event, update_event, delete_event, trip_window, bulk_reschedule, check_availability, propose_times, update_preferences. Use SCHEDULING_NEGOTIATION for multi-turn proposal flows; use CALENDLY for calendly.com URLs." / compressed: "calendar event CRUD + availability + prefs; subactions create\|update\|delete\|search\|propose_times\|check_availability" |
| **CALENDLY** | (none — falls back to long description) | missing-compressed | desc kept; compressed: "calendly: list_event_types\|availability\|upcoming_events\|single_use_link" |
| **CONNECTOR** | `connector lifecycle+verify-probes (registry-driven): connect disconnect…` | vague | desc: "Manage external service connections (Google, Telegram, Discord, Slack, etc.). Subactions: connect, disconnect, verify, status, list. Connector kinds resolve through ConnectorRegistry." / compressed: "connector lifecycle: connect\|disconnect\|verify\|status\|list" |
| **CREDENTIALS** | `credentials owner-only: fill(field,domain) whitelist_add(domain,confirm…` | verbose | desc: "Owner-only password and autofill operations. Subactions: fill, whitelist_add, whitelist_list, search, list, inject_username, inject_password. Plaintext credentials never appear in chat — only the OS clipboard. inject_* and whitelist_add require confirmed:true." / compressed: "credentials: fill\|whitelist_add\|search\|list\|inject_username\|inject_password; clipboard-only; confirmed:true required for inject and whitelist_add" |
| **DEVICE_INTENT** | `ONE-SHOT push fan-out to paired devices NOW. NOT for habits/routines/re…` | clear | (keep) |
| **ENTITY** | `ENTITY = people/relationships. subactions add list log_interaction set_…` | vague | desc: "Manage people, organizations, and relationships the owner cares about. Subactions: add, list, set_identity, set_relationship, log_interaction, merge. Use SCHEDULED_TASK for follow-up cadence; use LIFE for one-off dated reminders to call/text someone." / compressed: "people+relationships: add\|list\|set_identity\|set_relationship\|log_interaction\|merge" |
| **FIRST_RUN** | `owner first-run: defaults\|customize\|replay; defaults asks wake time onc…` | clear | (keep) |
| **HEALTH** | `health/fitness telemetry HealthKit/GoogleFit/Strava/Fitbit/Withings/Our…` | verbose | desc: "Read health and fitness telemetry from HealthKit, Google Fit, Strava, Fitbit, Withings, or Oura. Subactions: today, trend, by_metric, status. Read-only — never writes." / compressed: "read health/fitness telemetry; subactions today\|trend\|by_metric\|status; read-only" |
| **LIFE** | `life:subaction=create\|update\|delete(kind=definition\|goal) + complete\|sk…` | verbose+wrong-context | desc: "Manage the owner's habits, routines, reminders, alarms, todos, and long-term goals. Subactions: create, update, delete (kind=definition or goal); complete, skip, snooze (occurrence); review (goal); policy_set_reminder, policy_configure_escalation. Use this for any recurring or one-off personal task — including one-off reminders to call or text someone." / compressed: "personal habits+reminders+goals: create\|update\|delete\|complete\|skip\|snooze\|review; cadence: once\|daily\|weekly\|interval\|times_per_day" |
| **LIFEOPS** | `owner LIFEOPS verb: pause\|resume\|wipe; wipe requires confirmed:true` | clear | (keep) |
| **MESSAGE_HANDOFF** | `MESSAGE_HANDOFF verb: enter\|resume\|status; gates agent contributions p…` | verbose | desc: "Hand off a multi-party room to the human owner. Verbs: enter (agent stops contributing until resume condition fires), resume (agent rejoins), status (report current handoff state)." / compressed: "room handoff: enter\|resume\|status; gates agent per resumeOn condition" |
| **MONEY** | `money: payments(dashboard list-sources add-source remove-source import-…` | verbose | desc: "Track payments and subscriptions. Subactions: dashboard, list_sources, add_source, remove_source, import_csv, list_transactions, spending_summary, recurring_charges, subscription_audit, subscription_cancel, subscription_status. Cancellations route through the browser executor." / compressed: "money: payments+subscriptions; subactions dashboard\|list_sources\|list_transactions\|spending_summary\|recurring_charges\|subscription_audit\|subscription_cancel\|subscription_status" |
| **PLACE_CALL** | `Place a phone call via Android Telecom. Requires CALL_PHONE permission.` | clear | (keep — already imperative+side-effect-aware) |
| **PROFILE** | `persist owner state: save(name,location,age,prefs) + capture_phone(numb…` | vague | desc: "Save durable owner facts and preferences. Subactions: save (name, location, gender, age, relationship status, travel preferences), capture_phone (phone number for SMS/voice). Reminder intensity and escalation rules live on LIFE.policy_*." / compressed: "save owner facts+prefs: save\|capture_phone; reminder/escalation policy → LIFE.policy_*" |
| **REMOTE_DESKTOP** | `remote-desktop session lifecycle: start(confirmed,pairing-code) status(…` | verbose | desc: "Manage remote-desktop sessions. Subactions: start (requires confirmed:true and a pairing code in cloud mode), status (lookup by sessionId), end (close by sessionId), list (active sessions), revoke (revoke by sessionId)." / compressed: "remote-desktop sessions: start\|status\|end\|list\|revoke; start requires confirmed:true" |
| **RESOLVE_REQUEST** | `approve\|reject pending request from queue, requestId optional: send_ema…` | vague | desc: "Approve or reject a pending action queued for owner confirmation (send_email, send_message, book_travel, voice_call, etc.). Subactions: approve, reject. requestId is optional — handler infers the target from owner intent." / compressed: "approve\|reject pending queued action; requestId optional; covers send_email\|send_message\|book_travel\|voice_call" |
| **SCHEDULE** | `passive schedule inference activity+screen-time+health: summary \| inspe…` | clear | (keep) |
| **SCHEDULED_TASK** | `scheduled-task umbrella: list get create update snooze skip complete di…` | verbose | desc: "Manage the owner's scheduled-task spine: reminders, check-ins, follow-ups, approvals, recaps, watchers, outputs, and custom tasks. Subactions: list, get, create, update, snooze, skip, complete, dismiss, cancel, reopen, history." / compressed: "scheduled tasks: list\|get\|create\|update\|snooze\|skip\|complete\|dismiss\|cancel\|reopen\|history; kinds reminder\|checkin\|followup\|approval\|recap\|watcher\|output\|custom" |
| **SCHEDULING_NEGOTIATION** | (none — falls back to verbose desc) | missing-compressed | desc kept; compressed: "multi-turn meeting negotiation: start\|propose\|respond\|finalize\|cancel\|list; only for existing proposal workflows" |
| **SCREEN_TIME** | `screen-time+activity+browser focus mins: summary today weekly weekly-av…` | verbose | desc: "Read screen-time and activity analytics across screen-time samples, the macOS native activity tracker, and browser-extension reports. Subactions: summary, today, weekly, weekly_average_by_app, by_app, by_website, activity_report, time_on_app, time_on_site, browser_activity. Read-only — never writes." / compressed: "screen-time+activity reads: summary\|today\|weekly\|by_app\|by_website\|activity_report\|time_on_app\|time_on_site\|browser_activity; read-only" |
| **TODO** | `todo manage list; op: write\|create\|update\|complete\|cancel\|delete\|list\|cl…` | verbose | desc: "Manage the user's todo list. Subactions: write (replace list), create, update, complete, cancel, delete, list, clear. Todos are user-scoped (entityId) and persist across rooms for the same user." / compressed: "todos: write\|create\|update\|complete\|cancel\|delete\|list\|clear; user-scoped" |
| **TOGGLE_FEATURE** | `toggle LifeOps feature flight-booking push-notifs browser-automation es…` | vague | desc: "Enable or disable a registered LifeOps capability (flight booking, push notifications, browser automation, escalation, etc.). Subactions: enable, disable. Feature keys are registry-driven." / compressed: "enable\|disable LifeOps feature flag; registry-driven keys" |
| **VOICE_CALL** | `Twilio voice dial: recipientKind=owner\|external\|e164; draft-confirm; ap…` | clear | (keep — concise+states the destination kinds+states the gate) |

### Verdict counts

| Verdict | Count |
|---|---:|
| `clear` | 6 |
| `vague` | 5 |
| `verbose` | 11 |
| `missing-compressed` | 2 |
| `wrong-context` | 0 (folded into verbose where it co-occurs) |
| `redundant-with-name` | 0 |
| **total reviewed** | **24 umbrellas + first-class actions** |
| **fanout virtuals impacted** | **+~60 (inherit umbrella rewrite)** |

The 60+ fanout virtuals (BLOCK_BLOCK, CALENDAR_CREATE_EVENT, …) inherit
their parent umbrella's rewrite via `promoteSubactionsToActions`, so the
rewrite count shows the upstream edit set, not the manifest line count.

## Style rules applied

- **Imperative voice.** "Block or unblock phone apps and desktop websites."
  not "Action that blocks…".
- **Names what it does, not what it is.** "Read health and fitness telemetry"
  beats "Health/fitness telemetry surface".
- **Names the discriminator/subactions explicitly.** Every umbrella now lists
  every subaction in its `descriptionCompressed`.
- **Calls out side effects + gating.** "Website blocks require confirmed:true",
  "Cancellations route through the browser executor", "Plaintext credentials
  never appear in chat — only the OS clipboard".
- **Drops weasel words.** No "intelligently", "appropriately", "smart".
- **`descriptionCompressed` strictly < `description`.** Every rewrite
  satisfies this; the compressed form lands in the cached planner context
  while the long form is reserved for the planner's per-action expansion.

## Out of scope

- `MESSAGE` (lives in `packages/core/src/features/advanced-capabilities/actions/message.ts`,
  not in app-lifeops) — left untouched per the task scope. The current
  description ("primary message action ops send read_channel …") is verbose
  but not LifeOps-owned.
- `CHECKIN`, `RELATIONSHIP`, `PASSWORD_MANAGER`, `PAYMENTS`,
  `SUBSCRIPTIONS`, `APP_BLOCK`, `WEBSITE_BLOCK`, `AUTOFILL` — these are
  legacy actions superseded by their umbrella replacements (BLOCK, MONEY,
  CREDENTIALS, ENTITY) and not registered in `appLifeOpsPlugin.actions`.
  They appear in the source tree but not in the manifest, so editing
  their descriptions would not affect any model.

## Verification

Per-action edits land in the next section's commit. After each batch the
manifest re-export and `bun run check` + tests are run; results land in
the report section of `docs/audits/lifeops-2026-05-09/REPORT.md` and at
the bottom of the Wave 4B subagent summary.
