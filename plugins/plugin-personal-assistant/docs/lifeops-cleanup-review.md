# LifeOps (plugin-personal-assistant) cleanup & decomposition review

> Date: 2026-06-18. Read-only architecture review of `@elizaos/plugin-personal-assistant`
> (PA, "LifeOps", ~137k LOC) answering: what "relationships and core stuff" should move
> into the runtime (`@elizaos/core` / `@elizaos/agent`) / `@elizaos/shared` / `app-core`,
> what views/domains should move to focused plugins, and what is the legitimate hub.
> Companion to `lifeops-decomposition-plan.md` (the living plan). Evidence-backed; verifies
> the *current* source rather than trusting prior round-notes.

## A. Executive summary — the honest current state

The decomposition's **dependency direction is clean**: no focused domain plugin
(`plugin-calendar/inbox/goals/todos/health/finances/blocker/documents/relationships/remote-desktop`)
actually `import`s PA. Every `@elizaos/plugin-personal-assistant` string in those plugins is a
boundary-doc comment ("this plugin MUST NOT import from PA"), and no focused plugin lists PA in
`package.json` dependencies. The **entity/relationship knowledge graph is already a runtime
primitive** — `EntityStore`/`RelationshipStore` live in `@elizaos/agent`
(`packages/agent/src/services/knowledge-graph/`), surfaced by `KnowledgeGraphService`
(serviceType `eliza_knowledge_graph`, `resolveKnowledgeGraphService`); canonical types + merge
engine are in `@elizaos/shared/knowledge-graph`; PA's `lifeops/entities/store.ts` +
`lifeops/relationships/store.ts` are 12–13-line re-export shims. So "relationships → runtime" is
**done at the storage layer**.

**But two real problems remain**, matching the user's instinct:

1. **Dead / unwired "graph & identity" code was still trapped in PA** (now removed — see §C):
   `context-graph.ts` (1937 LOC) and `identity-observations.ts` + its `observer.ts` (1641 LOC)
   were parallel, speculative graph/identity-resolution subsystems with **zero runtime
   consumers**. ~3.6k LOC of slop. Deleted in this pass.

2. **The data layer never actually moved for most domains.** This is the real story, and it
   contradicts the optimistic "code-complete" round-notes. The carve-out is *dependency-clean*
   but *data-layer-incomplete*: only `plugin-finances` performed a real namespace migration
   (`app_lifeops` → `app_finances`, the `to_regclass`/`INSERT…SELECT` non-destructive template).
   Everything else is in a weaker state:
   - **Schema squatting** — `plugin-calendar` declares `pgSchema("app_lifeops")` and writes PA's
     tables directly (no carve-out).
   - **Cross-schema reads** — `plugin-goals` declares `app_goals` but its repository still reads
     `app_lifeops.life_goal_*` (logic moved, tables didn't).
   - **Vestigial schema** — `plugin-goals` (`reminders/routines/alarms/checkins` tables) and
     `plugin-relationships` (`app_relationships`) declare tables that are **never queried**.
   - **Registration shell** — `plugin-inbox` actions return `not_implemented`; the live triage
     engine is still PA's `service-mixin-inbox.ts` (~920 LOC) reading `app_lifeops.life_inbox_*`.

The single biggest blocker is `lifeops/repository.ts` (8386 LOC) — one `LifeOpsRepository` class
issuing raw SQL against **~48 distinct `app_lifeops` tables** (259 qualified refs), with the
scheduling spine + reminders engine fused to it.

## B. Target architecture — subsystem → home

| Subsystem (PA path) | LOC | Correct home | Why |
|---|---|---|---|
| `lifeops/context-graph.ts` | 1937 | **delete** ✅ done | Parallel speculative graph, zero consumers. |
| `lifeops/identity-observations.ts` + `/observer.ts` | 1641 | **delete** ✅ done | Unwired identity-resolution; live path uses runtime KG directly. |
| `lifeops/entities/store.ts`, `relationships/store.ts` | 25 | **stay-PA** (shims) | Already re-export `@elizaos/agent` KG; correct. |
| `lifeops/entities/voice-observer.ts` + `voice-attribution.ts` + `voice-observer-bridge.ts` | ~510 | **stay-PA** | Owner-specific voice→graph orchestration *over* the runtime KG. Exemplary seam (event-based, no plugin↔plugin import). |
| `actions/entity.ts` (legacy `ENTITY`/Rolodex) | 1007 | **merge → plugin-relationships** (needs design) | Redundant with plugin-relationships' `KNOWLEDGE_GRAPH` action; suffers a V1/V2 split-brain (CRUD still on deprecated `life_relationships`, while `set_*`/`merge` use the runtime KG). |
| `lifeops/graph-migration/migration.ts` | 408 | **stay-PA** (delete post-prod-migration) | One-shot V1→KG migrator over PA's own legacy table; no live caller. |
| `lifeops/approval-queue.ts` | 724 | **@elizaos/agent or app-core** (candidate) | Generic owner-approval gating; its `approval_requests` table is in **plugin-sql** (not `app_lifeops`) → low coupling, movable. |
| `lifeops/pending-prompts`, `handoff`, `global-pause` | ~630 | **@elizaos/agent runtime service** (candidate) | Cache-backed, zero infra coupling. Generic "agent needs owner input / is paused / handed off" — any plugin would want these. |
| `lifeops/work-threads` | 856 | **stay-PA** (or runtime, needs design) | ~453 LOC of methods buried in `repository.ts` on `app_lifeops` tables; coupling = the schema monolith. Core chief-of-staff coordination. |
| `lifeops/first-run` | 1470 | **stay-PA** (assess vs app-core onboarding) | Determine PA-onboarding vs app-level onboarding. |
| `lifeops/scheduled-task/*` (spine) | 6892 | **stay-PA hub** (harden injection seam) | The generic state machine is real, but `runtime-wiring.ts` hardwires every default to a PA impl + `LifeOpsRepository`. Extracting now moves the fusion, doesn't remove it. |
| `lifeops/service-mixin-reminders.ts` | 5468 | **stay-PA hub** (split into files) | Delivery/escalation engine that runs in lockstep with the spine (shares `life_task_definitions/occurrences`, channels, circadian gates, the same tick). |
| `lifeops/registries`, `channels`, `connectors`, `send-policy` | ~5k | **stay-PA** (registries) / connector clients → their plugins | PA CLAUDE.md contract: PA keeps owner-policy registries; connector clients (discord/google/x) belong in their plugins. `service-mixin-discord.ts` (1.8k) is a candidate to move to plugin-discord. |
| `components/LifeOpsPageView.tsx` (stub view) | 149 | **replace with real brief hub OR delete registration** | Static mockup; contradicts CLAUDE.md "No views". See §D. |
| Health/circadian/telemetry tables | — | **plugin-health (needs design)** | Conceptually plugin-health, but feed the spine's circadian gates — needs a cross-plugin circadian-read contract first. |
| KG tables (`life_entities`, `life_relationships_v2`, …) | — | **already @elizaos/agent** | Runtime-owned; PA must not re-register. No action. |

## C. "Relationships & core → runtime/app-core" (the user's explicit ask)

**Relationships is already in the runtime** (KG stores/types/merge). The remaining graph/identity
code in PA was **dead, not movable** — so the right action was deletion, not migration:

- ✅ **Deleted `context-graph.ts` (1937 LOC)** — a parallel evidence/provenance/permission-scoped
  in-memory graph, zero consumers (only a barrel re-export).
- ✅ **Deleted `identity-observations.ts` + `observer.ts` (1641 LOC)** — unwired identity
  normalization/merge; the live voice path already uses the runtime `EntityStore.observeIdentity`.
- **Needs design — merge the legacy `ENTITY` action into plugin-relationships' `KNOWLEDGE_GRAPH`**
  and retire its deprecated `life_relationships` V1 CRUD.

**Generic agent-ops primitives that genuinely belong in runtime/app-core** (the "core stuff"):
- `approval-queue` (724 LOC) — owner-approval gating; table already in plugin-sql, so movable to a
  runtime `ApprovalService` (`@elizaos/agent`) or app-core so any plugin can request owner sign-off.
- `pending-prompts` + `handoff` + `global-pause` (~630 LOC) — cache-backed, zero coupling; natural
  `@elizaos/agent` runtime services ("agent is waiting on the owner / paused / handed off").

These are the highest-value "core → runtime" moves; all are dependency-direction-safe (they don't
import focused plugins). They are P1 (needs a small interface design + a runtime service shell),
not P0, because moving them changes registration + a string serviceType.

## D. Views & domain surfaces → focused plugins

- **The LifeOps stub view** (`plugin.ts:753-795` registers `LifeOpsPageView` ×3 GUI/XR/TUI) is a
  **static mockup** that contradicts the CLAUDE.md "No views" contract. Verified breakage if the
  registration is removed: **nothing structural breaks** — the `lifeops` tab is a *builtin* nav
  tab (`navigation/index.ts`), and `App.tsx:826` already falls back to `<ViewUnavailableFallback/>`
  when `bootConfig.lifeOpsPageView` is undefined. `view-action-affinity.ts:167`
  (`lifeops → PERSONAL_ASSISTANT`) is keyed on the builtin tab id and survives.
  **Recommendation:** replace the mockup with a real chief-of-staff **brief hub** that fetches the
  already-existing `/api/lifeops/overview` (+ `BRIEF`/`PRIORITIZE`/`getOverview` actions + `lifeops`
  provider) — pending approvals, prioritized day, schedule conflicts. If a real hub is out of scope
  now, delete the 3 `views[]` entries + the stub component and fix the CLAUDE.md contradiction. The
  mockup should not ship either way — it lies about product state.
- **Domain backends still in PA** that belong in their focused plugins once their tables move:
  inbox engine (`service-mixin-inbox.ts` + `service-mixin-gmail.ts`) → plugin-inbox; calendar
  reads → plugin-calendar; goals tables → plugin-goals (logic already delegated).
- **No new plugin recommended yet.** `plugin-scheduling` / `plugin-reminders` are **premature** —
  the spine + reminders are the legitimate hub and are fused to `life_task_definitions`. Harden the
  injection seam first (§G item 5).

## E. The `app_lifeops` schema / `repository.ts` monolith

57 tables in `pgSchema("app_lifeops")`. Grouping + carve-out status:

- **Scheduling spine (PA hub, can't move):** `life_scheduled_tasks`, `life_scheduled_task_log`,
  `life_task_definitions`, `life_task_occurrences`. Reminders/alarms/routines/todos all write
  `life_task_definitions` (`defaultKind: "definition"`).
- **Reminders delivery (PA, fused to spine):** `life_reminder_plans`, `life_reminder_attempts`,
  `life_escalation_states`.
- **Calendar (schema-squat → carve to `app_calendar`):** `life_calendar_events`,
  `life_calendar_sync_states`.
- **Inbox/email (shell; engine still PA):** `life_inbox_messages` (32 refs — most-referenced),
  `life_gmail_*`, `life_inbox_triage_*`, `life_email_unsubscribes`.
- **Goals (cross-schema read → move to `app_goals`):** `life_goal_definitions`, `life_goal_links`.
- **Relationships/contacts (PA-owned; distinct from runtime KG):** `life_relationships`,
  `life_relationship_interactions`, `life_follow_ups`.
- **Health/circadian/telemetry/screen-time/schedule-inference (PA; feed spine):** the `life_health_*`,
  `life_sleep_episodes`, `life_circadian_states`, `life_telemetry_*`, `life_activity_*`,
  `life_screen_time_*`, `life_schedule_*` groups — multi-domain, can't move cleanly.
- **Owner/channels/connectors/approvals (PA hub):** `life_connector_grants`, `life_account_privacy`,
  `life_channel_policies`, `life_audit_events`, `life_intents`, `life_checkin_reports`,
  `lifeops_features`.
- **Blocker (own `app_blocker`, NOT migrated):** `life_block_rules`, `life_website_access_grants`.
- **Workflows / work-threads / X-read (PA hub):** `life_workflow_*`, `life_work_thread*`, `life_x_*`.
- **KG (already runtime-owned):** `life_entities`/`life_relationships_v2`/… — no action.

**Safe carve-out strategy** = the proven finances template (`plugin-finances/src/services/migration.ts`):
focused plugin declares its own `pgSchema`, a non-destructive `MigrationService`
(`to_regclass` guard + target-empty check + `INSERT…SELECT` + never-drop-source), raw SQL repointed
via a `SOURCE_SCHEMA`/`TARGET_SCHEMA` const, plugin loaded so its schema is created. The cross-cutting
prerequisite is splitting the 8386-LOC `repository.ts` into per-domain files (a no-data-move
stepping stone that makes each domain's DB surface extractable).

## F. The legitimate chief-of-staff HUB (what STAYS in PA)

Per the README contract, PA's end-state is a thin chief-of-staff hub. What legitimately stays:
the **scheduling spine** + **reminders delivery** (the cross-domain operating loop), **cross-domain
aggregation** (`life.ts`/`brief`/`prioritize`/`getOverview` — it aggregates the spine + reminders +
calendar + activity, all PA-resident), the **owner-policy registries** (channels/connectors/
send-policy/owner facts), **work-thread coordination**, **first-run/global-pause/handoff** (unless
promoted to runtime), and the **voice→graph orchestration** over the runtime KG. Do NOT over-extract
these into a `plugin-scheduling` — that inverts the architecture.

## G. Prioritized sequence

**P0 — safe-now (no data migration; pure code/contract cleanup):**
1. ✅ Delete `context-graph.ts` (1937 LOC dead). *(done — commit `075033192c`)*
2. ✅ Delete `identity-observations.ts` + `observer.ts` (1641 LOC dead). *(done — commit `ef76ee081f`)*
3. **Resolve the stub view** — replace `LifeOpsPageView` with a real `/api/lifeops/overview`-fed
   brief hub, OR delete the 3 `views[]` registrations + stub + fix the CLAUDE.md "No views"
   contradiction. Zero data risk (App.tsx already has the fallback branch).
4. **Remove vestigial dead schema** — `plugin-goals`' `reminders/routines/alarms/checkins` tables
   (never queried). Verify they're absent from any committed drizzle snapshot first.
5. **Make the scheduled-task `ScheduledTaskStore` + dispatcher injectable** — the view-interface
   seam already exists in `runtime-wiring.ts`; this is the prerequisite for any future spine work,
   no behavior change.

**P1 — medium (interface design; runtime service shells):**
6. **Promote generic agent-ops to runtime/app-core** — `approval-queue` → runtime `ApprovalService`;
   `pending-prompts`/`handoff`/`global-pause` → runtime services. Define minimal interfaces; move
   the string serviceTypes with them.
7. **Split `repository.ts` (8386) + `service-mixin-reminders.ts` (5468) into per-domain files** —
   readability + extraction-enabling, no table moves.
8. **Carve goals tables** (`life_goal_*` → `app_goals`, finances template) — cleanest data move
   (logic already delegated via `GoalsService`).
9. **Carve calendar** (`app_calendar` + MigrationService; repoint `CalendarRepository` + PA's
   `service-mixin-calendar`).
10. **Carve blocker** (`life_block_rules` → `app_blocker`; plugin already has the table).
11. **Merge the legacy `ENTITY` action → plugin-relationships `KNOWLEDGE_GRAPH`**, retire the V1
    `life_relationships` CRUD.

**P2 — needs design / can't move cleanly:**
12. **Inbox** — biggest blast radius (`life_inbox_messages` = 32 refs); migrate engine + tables
    together. plugin-inbox is a shell today.
13. **Health/circadian/telemetry** — design a cross-plugin circadian-state read contract before
    moving (the spine consumes `life_circadian_states`).
14. **`service-mixin-discord.ts` → plugin-discord** (connector-client migration).
15. **Spine/reminders extraction** — only after the injection seam (item 5) is hardened; likely stays
    the hub.

Each migration uses the proven gates: no PA import in the focused plugin
(`rg "@elizaos/plugin-personal-assistant" plugins/<p>/src` finds only comments), per-domain typecheck,
the non-destructive migration test, and the `decomposition-integration.test.ts` invariant (no dropped
owner action, no service-type collision, no view shadow, every `VIEW_ACTION_MAP` name registered).
