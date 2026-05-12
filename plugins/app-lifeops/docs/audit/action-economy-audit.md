# Action Economy Audit (Pass 2)

Date: 2026-05-09
Branch: `shaw/more-cache-toolcalling`

## Question

After Wave-1 / Wave-2 / Wave-3 cleanup (CHECKIN→pack, RELATIONSHIP→ENTITY,
SCHEDULING→SCHEDULING_NEGOTIATION, SCHEDULED_TASK umbrella, LIFE.policy.\*),
**should MORE actions fold into umbrellas?** The user wants a small,
well-structured planner surface (~15 umbrella actions). Today there are 26
LifeOps-owned registered actions plus the core `messagingTriageActions`
family. Are any of the remaining 26 scenario hacks, parameter-shape
collisions, or candidates for further consolidation?

## Method

For each action registered in `plugins/app-lifeops/src/plugin.ts`, asked:

1. Real verb the agent uses, or a scenario hack?
2. Are the subactions distinct verbs, or different parameter shapes of one
   verb?
3. Could this action fold into a sibling umbrella?
4. Could a simple verb expansion replace 3+ actions?

## Inventory + Disposition

| Action | Verbs / subactions | Disposition | Reason |
|---|---|---|---|
| `WEBSITE_BLOCK` | block, unblock, status, request_permission, release, list_active | **keep** | W2-F absorbed standalone `RELEASE_BLOCK` + `LIST_ACTIVE_BLOCKS`. Already done. |
| `APP_BLOCK` | block, unblock, status | **keep** (but candidate fold-into `BLOCK` umbrella with WEBSITE_BLOCK — see Defer #1) | Both surfaces have `block / unblock / status` aligned, but the runtime backends are completely different (Family Controls / Usage Access vs hosts file / SelfControl), and the W2-F surgery on WEBSITE_BLOCK is recent. Folding both is plausible mid-confidence work — not high-confidence. |
| `CALENDAR` | feed, next_event, search_events, create_event, update_event, delete_event, trip_window, bulk_reschedule, check_availability, propose_times, update_preferences | **keep** | W2-C just narrowed this from 24 → 11 verbs by extracting `calendly_*` and `negotiate_*`. Match plan; do not re-fold. |
| `CALENDLY` | list_event_types, availability, upcoming_events, single_use_link | **keep** | Extracted out of CALENDAR in W2-C. Calendly is a separate scheduling product with its own API. Per `HARDCODING_AUDIT.md` §6 #13 this is the correct decomposition. |
| `SCHEDULING_NEGOTIATION` | start, propose, respond, finalize, cancel, list_active, list_proposals | **keep** | Multi-turn stateful actor; lifecycle verbs on one entity. Per `HARDCODING_AUDIT.md` §7. |
| `RESOLVE_REQUEST` | approve, reject | **keep** | Genuine 2-verb compound. Per `HARDCODING_AUDIT.md` §7. |
| `DEVICE_INTENT` | broadcast | **shim-only** (1-verb action; keep but parameter is symbolic) | Single-verb action whose `subaction` parameter is dead weight (only ever `"broadcast"`). The handler does not branch on it. Could fold under a hypothetical cross-device messaging umbrella, but no sibling currently fits — it is cross-device pubsub via `intent-sync.js`, not MESSAGE (owner inbox / triage), not LIFEOPS (global pause). Keep as a focused single-verb action; the dead parameter is documented but left in place for planner-cache compatibility. |
| `FIRST_RUN` | (path: defaults / customize / replay) | **keep** | Frozen interface per `wave1-interfaces.md` §4.2. |
| `LIFE` | create, update, delete, complete, skip, snooze, review, policy_set_reminder, policy_configure_escalation | **keep** | W3-C drift D-3 added the policy_\* verbs. Match plan. |
| `LIFEOPS` | pause, resume, wipe | **keep** | W1-C grouping. Match plan. |
| `MESSAGE.handoff` | enter, resume, status | **keep** | W2-G dotted-namespace under MESSAGE. Per `GAP_ASSESSMENT.md` §3.14. |
| `BOOK_TRAVEL` | (compound: search → draft → approval → book → calendar sync) | **keep** compound | Per `HARDCODING_AUDIT.md` §7. Atomic transactional flow. |
| `PROFILE` | save, capture_phone, set_reminder_preference, configure_escalation | **keep** (with one-release similes) | W3-C drift D-3 already migrated the canonical homes (`LIFE.policy_*`) and PROFILE retains the old verbs as one-release planner-cache aliases. Slated for removal in the next wave. |
| `ENTITY` | add, list, log_interaction, set_identity, set_relationship, merge + 7 transitional follow-up similes | **keep** (with one-release similes) | W2-A canonical 6 verbs; W3-C drift D-2 transitional follow-up subactions collapse onto SCHEDULED_TASK. PR-3-coverage drift documented. |
| `SCREEN_TIME` | summary, today, weekly, weekly_average_by_app, by_app, by_website, activity_report, time_on_app, time_on_site, browser_activity | **keep** | Genuine read CQRS surface across irreducible per-window queries. The 10 verbs are different read shapes, not parameter variants. |
| `VOICE_CALL` | place, call_owner, call_external | **keep** (but mid-confidence candidate to collapse the three into `dial` with a `recipient` discriminator — see Defer #2) | The three verbs branch into substantially different handlers (recipient resolution, escalation policy acknowledgement, allow-list checks). Not pure parameter shapes. |
| `REMOTE_DESKTOP` | start, status, end, list, revoke | **keep** | Lifecycle verbs on a session entity. Match plan. |
| `SCHEDULE` | summary, inspect | **keep** (W3-C drift D-4: long-term should migrate to plugin-health) | Sleep / circadian read surface. The `CircadianInsightContract` seam is now in place; the action stays for now. |
| `SCHEDULED_TASK` | list, get, create, update, snooze, skip, complete, dismiss, cancel, reopen, history | **keep** | Wave-3 W3-C umbrella. Match plan. |
| `PASSWORD_MANAGER` | search, list, inject_username, inject_password | **keep** | Owner-only credential lookup against 1Password CLI. Cross-references AUTOFILL via `routingHint`. |
| `AUTOFILL` | fill, whitelist_add, whitelist_list | **keep** | Browser-extension form fill + per-domain allowlist. Different runtime surface from PASSWORD_MANAGER (form-fill via DOM bridge vs clipboard inject via 1Password CLI). |
| `HEALTH` | today, trend, by_metric, status | **keep** | Health metric reads via plugin-health bridge. Match plan. |
| `SUBSCRIPTIONS` | audit, cancel, status (canonical `subaction` + legacy `mode` alias) | **keep** | W3-C drift D-5. Match plan. |
| `PAYMENTS` | dashboard, list_sources, add_source, remove_source, import_csv, list_transactions, spending_summary, recurring_charges (canonical `subaction` + legacy `mode` alias) | **keep** | W3-C drift D-5. Match plan. |
| `CONNECTOR` | connect, disconnect, verify, status, list | **keep** | W2-B `ConnectorRegistry`-backed. Match plan. |
| `TOGGLE_FEATURE` | (no subaction; `featureKey` + `enabled`) | **keep** | Single-verb action over the feature-flag registry. |

## Folds Applied (this commit)

None.

The previous waves shipped every safe simplification. The remaining
candidates (Defer #1 and Defer #2 below) are mid-confidence consolidations
that would require deeper refactoring of large files (1733 + 932 lines
respectively) and break live planner contracts. Per the audit's
conservative-bias rule, neither lands in this pass.

## Defers (with reason)

### Defer #1 — APP_BLOCK + WEBSITE_BLOCK → BLOCK umbrella

The two share aligned verbs (`block`, `unblock`, `status`) and the
WEBSITE_BLOCK surface adds `release`, `list_active`, `request_permission`.
A `BLOCK.{target=app|website, verb=…}` umbrella would reduce the planner
surface by one action and improve symmetry.

Reason for deferral:
- Two large files (608 + 1125 = 1733 lines) with completely independent
  runtime backends (Family Controls / Usage Access on iOS+Android vs
  hosts-file editing / SelfControl on macOS). The merge would require
  refactoring both backends to share an umbrella dispatcher.
- W2-F just landed the `RELEASE_BLOCK` / `LIST_ACTIVE_BLOCKS` fold into
  WEBSITE_BLOCK. Re-touching that surface so soon risks regressing the
  recent migration.
- The integration test surface (`lifeops-action-gating`) currently treats
  `WEBSITE_BLOCK` and `APP_BLOCK` as independent; the merge would change
  the action enumeration and require updating the gating test.

Verdict: mid-confidence. Not a Pass-2 fix.

### Defer #2 — VOICE_CALL.{place|call_owner|call_external} → VOICE_CALL.dial

The three subactions are recipient categories more than verbs. A single
`dial` verb with a `recipient: owner | external | number` discriminator
would be more uniform.

Reason for deferral:
- The three handlers branch into substantially different code paths:
  `call_owner` has a "standing escalation policy acknowledgement" path,
  `call_external` resolves names via the relationships store, and `place`
  validates raw E.164 input. They are not pure parameter shapes — each
  carries domain-specific resolution + approval-queue semantics.
- The 932-line file's ActionExamples and similes have been tuned to the
  three-verb form. Collapsing would require a one-release simile period
  and a planner-prompt update.

Verdict: low-to-mid confidence. Possible follow-up work; not a Pass-2 fix.

### Defer #3 — DEVICE_INTENT.subaction parameter is dead weight

`DEVICE_INTENT` only supports `broadcast`. The handler never branches on
the subaction parameter. The parameter is registered for symmetry with
other umbrella actions and to absorb cached planner outputs that include
`"subaction": "broadcast"`.

Reason for deferral:
- Removing the parameter is a one-line change but flips the planner
  contract for any cached output keyed by parameter set.
- The parameter is harmless: handler accepts it, ignores it, returns
  `subaction: "broadcast"` in the result data.
- No safe one-release simile path for parameter removal since parameters
  are part of the action schema; a planner that emits the field today
  would be silently rejected if we removed it from the schema.

Verdict: low-confidence cleanup. Leave in place.

### Defer #4 — PAYMENTS + SUBSCRIPTIONS → MONEY umbrella

Both are financial domains. Folding to `MONEY.{...}` would consolidate
two actions into one with 11 subactions across very different concerns
(payment sources / transactions / spending vs subscription audit /
cancel).

Reason for deferral:
- The two contracts are independent: `LifeOpsPaymentSourceKind` /
  `LifeOpsSubscriptionExecutor` do not interact.
- The `SUBSCRIPTIONS` action has its own playbook executor (Plaid /
  user-browser / agent-browser / desktop-native) that has nothing to do
  with payment sources.
- Folding would force the planner to disambiguate within one umbrella
  what is currently disambiguated between two; the LLM benefit is
  marginal.

Verdict: low-confidence. Keep separate.

### Defer #5 — AUTOFILL + PASSWORD_MANAGER → CREDENTIALS umbrella

Both deal with credentials. AUTOFILL is browser-extension form fill,
PASSWORD_MANAGER is 1Password CLI clipboard inject.

Reason for deferral:
- Different runtime surfaces (extension DOM bridge vs OS-level CLI).
- PASSWORD_MANAGER's `routingHint` already documents the boundary:
  "credential search/list/copy/inject -> PASSWORD_MANAGER; AUTOFILL
  handles login/password/form fill on a site". The planner already
  routes correctly.
- The two actions share one concept (credentials) but no code paths.

Verdict: low-confidence. Keep separate.

### Defer #6 — REMOTE_DESKTOP / SCREEN_TIME / DEVICE_INTENT → DEVICE umbrella

All three "target a device" in some sense. Folding would create a
heterogeneous super-umbrella.

Reason for deferral:
- REMOTE_DESKTOP manages remote-control session lifecycle.
- SCREEN_TIME is a passive analytics read surface (10 read verbs).
- DEVICE_INTENT is cross-device notification pubsub.
- The three share zero code paths. Folding by name-similarity would be
  exactly the "centralize unlike concepts into giant shared utility
  files" anti-pattern called out in `AGENTS.md`.

Verdict: anti-pattern. Do not fold.

## Action Count

- Before this audit: 26 LifeOps-owned actions registered (plus the core
  `messagingTriageActions` family).
- After this audit: 26 LifeOps-owned actions registered (no folds
  applied).

The user's target of ~15 umbrella actions is not reachable today without
Defer #1 (APP_BLOCK + WEBSITE_BLOCK → BLOCK), Defer #4 (PAYMENTS +
SUBSCRIPTIONS → MONEY), and one more mid-confidence fold. None of those
are high-confidence enough for this pass; each warrants its own focused
commit with a planner-prompt rewrite + benchmark re-run.

## Verification

- `bun run lint` — clean.
- `bunx tsc --noEmit` — clean (run from plugin root).
- `bun --cwd plugins/app-lifeops test journey-domain-coverage` — 40/40 pass.
- `bun --cwd plugins/app-lifeops test lifeops-action-gating` — pass
  (action surface unchanged; assertions match).

## Follow-ups

- Defer #1 (BLOCK umbrella) lands in a focused commit alongside
  WEBSITE_BLOCK / APP_BLOCK file consolidation.
- Defer #2 (VOICE_CALL.dial) lands alongside a planner-prompt rewrite +
  benchmark re-run.
- Drift D-2 (ENTITY follow-up subactions) and D-3 (PROFILE policy
  similes) get their similes removed in the next release per
  `action-hierarchy-final-audit.md` §F.
