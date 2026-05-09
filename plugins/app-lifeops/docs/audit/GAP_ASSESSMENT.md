# LifeOps — Gap Assessment

**Companion document to:** `UX_JOURNEYS.md` (canonical journey reference) and `HARDCODING_AUDIT.md` (current-state finding inventory).

**Scope:** identify the general capabilities the agent must expose so that every journey in `UX_JOURNEYS.md` can be expressed as **capability + natural-language interaction** without the scenario sediment surfaced in `HARDCODING_AUDIT.md`.

**Date:** 2026-05-09.

**Status:** rewritten 2026-05-09 to integrate four design decisions: (1) `ScheduledTask` as the spine primitive, (2) atomic extraction of `plugin-health` from `app-lifeops`, (3) a first-run provider + action capability, and (4) a two-wave parallel-agent delivery model (the delivery model is documented in `IMPLEMENTATION_PLAN.md`).

---

## §1 Framing

### 1.1 The user's ask, restated

> "general systems which enable these things like 'gm' / 'gn' reminders, which enable all the stuff we want, but remove all that hardcode and forcing into the system and leaves that up to the user to just get from talking to the agent."

Translated into a design principle:

> **Every journey in `UX_JOURNEYS.md` must be reducible to (a) one spine primitive (`ScheduledTask`) plus a small set of supporting primitives the runtime exposes, and (b) data the user authored or accepted in chat — most often as entries in a default pack the user can edit. No journey should be implementable only because someone hardcoded its name, copy, schedule, or branch into TypeScript. First-party "default packs" are encouraged — they make the agent feel alive on day one — but they must register through the same contracts a user or third-party would use, and no part of the runtime may pattern-match a definition's title or scenario id.**

The user's worked example: a "gm" / "gn" / habit reminder is **just a `ScheduledTask`** the user can shape from chat. Brushing teeth, checking in, drafting an email at 4pm, asking the user "did you take the meds?" — all of these collapse into one primitive composed with the right configuration, plus optional follow-up tasks pipelined behind them.

### 1.2 Evaluation lens

Every gap below is graded against this principle. A capability either:

- **closes a gap**: today the journey is enabled by hardcoded sediment, and the spine + a default-pack entry would replace it (e.g. stretch-decider → a `ScheduledTask` whose `completionCheck` is registered as a gate).
- **already exists generically**: the contract supports the journey today (e.g. `LifeOpsCadence` covers basic gm/gn timing).
- **is irreducibly domain-shaped**: must remain an explicit compound (e.g. `BOOK_TRAVEL` cross-step transactionality; see §7 and `HARDCODING_AUDIT.md` §7).

### 1.3 What this document is not

- Not an implementation plan. See `IMPLEMENTATION_PLAN.md` for the two-wave parallel-agent execution.
- Not a list of specific PR diffs. Capability sketches are interface-level only.
- Not a re-litigation of journeys. `UX_JOURNEYS.md` is taken as the truth of what the product does.

---

## §2 The spine: `ScheduledTask`

### 2.1 One-liner

A **`ScheduledTask`** is the single composable primitive every time-bound, prompt-bound, or follow-up-bound LifeOps interaction reduces to. It is **not** a hardcoded action. It is a record consisting of (a) prompt instructions the agent reads at fire time, (b) trigger configuration (time anchor, event, or cron), (c) priority (low/medium/high), (d) optional pipeline references (next tasks to schedule on completion or failure), (e) tracking state for completion + follow-up (was it acknowledged? did the user act?), and (f) optional gate / completion-check / escalation configuration.

The user can author a `ScheduledTask` from chat ("ping me tomorrow at 9am to take meds"); the planner emits the typed shape; default packs ship a starter set so the agent is never empty.

### 2.2 Why this is the spine

`ScheduledTask` collapses or reshapes a number of capabilities that the prior version of this document treated as separate:

| Prior capability | Now expressed as |
|---|---|
| `RoutineTemplateRegistry` | A **default pack** — a TypeScript-registered set of pipelined `ScheduledTask` entries the agent can offer at first-run. The 8 entries from `seed-routines.ts` become 8 starter tasks (or short pipelines). |
| `ReminderGateRegistry` | The `completionCheck` / `shouldFire` field on `ScheduledTask` plus a small registry of named check kinds (e.g. `weekend_skip`, `late_evening_skip`, `quiet_hours`) that any task can reference by key. |
| `ReminderEscalationLadder` | The `escalation` field on `ScheduledTask` describing channel + delay + intensity steps; ladders compose by reference, so users can author "the urgent ladder" once and reuse. |
| `WorkflowRunner` extensions | The `pipeline` and `trigger` fields on `ScheduledTask`. Anchors (`wake.confirmed`) and events (`gmail.message.received`) are both representable as triggers without distinguishing "workflow" vs "scheduled task". |
| `OccurrenceStateMachine` | The verb surface (`snooze | skip | complete | dismiss | escalate | acknowledge`) operates on a `ScheduledTask` instance uniformly. Today's `LIFEOPS_OCCURRENCE_STATES` enum carries forward as the state set. |
| `TimeWindowRegistry` / `AnchorRegistry` | Inputs to a `ScheduledTask`'s trigger field — the registries remain (anchors and windows are real shared data), but their consumer is `ScheduledTask`, not separate workflow code. |
| `FollowupRegistry` | A follow-up **is** a `ScheduledTask` whose completion criterion is "did the user respond / act?" — a contributed `completionCheck` kind. The follow-up generator becomes a default-pack contributor that watches a subject (person, thread, document) and creates `ScheduledTask` entries when threshold is exceeded. |
| `OutboundDraftPipeline` | A draft-then-approve flow **is** a 3-task pipeline: draft `ScheduledTask` → approval `ScheduledTask` (whose completion is the user's approve verb) → send `ScheduledTask` (gated on the previous task's completion state). |

Capabilities that **do not** collapse into the spine remain in §3 below.

### 2.3 Interface sketch

```ts
ScheduledTask {
  taskId: string
  // What kind of task this is. Drives UI grouping, listing endpoints, and
  // (sparingly) defaults. The runner does NOT branch on kind — it's a label
  // for consumers, not a switch for the engine.
  kind: "reminder" | "checkin" | "followup" | "approval" | "recap" | "watcher" | "output" | "custom"

  // Plain prompt instructions — no hardcoded code paths. The agent reads
  // this at run time and renders against the runner's context.
  promptInstructions: string

  // What context the runner injects into the prompt (besides triggering event).
  // Per-event-kind context shapes are registered with EventKindRegistry.
  contextRequest?: {
    includeOwnerFacts?: ("preferredName" | "timezone" | "morningWindow" | "eveningWindow" | "locale")[]
    includeEntities?: { entityIds: string[]; fields?: ("preferredName" | "type" | "identities" | "state.lastInteractionPlatform")[] }
    includeRelationships?: { relationshipIds?: string[]; forEntityIds?: string[]; types?: string[] }
    includeRecentTaskStates?: { kind?: ScheduledTask["kind"]; lookbackHours?: number }
    includeEventPayload?: boolean   // for trigger.kind = "event"
  }

  // When to fire.
  trigger:
    | { kind: "once"; atIso: string }
    | { kind: "cron"; expression: string; tz: string }
    | { kind: "interval"; everyMinutes: number; from?: string; until?: string }
    | { kind: "relative_to_anchor"; anchorKey: string; offsetMinutes: number }
    | { kind: "during_window"; windowKey: string }
    | { kind: "event"; eventKind: string; filter?: EventFilter }   // per-kind via registry
    | { kind: "manual" }                                            // user-initiated only
    | { kind: "after_task"; taskId: string; outcome: TerminalState }

  priority: "low" | "medium" | "high"

  // Multiple gates compose with explicit semantics. shouldFire MUST be an array
  // (single-gate cases pass [{ kind, params }]). compose = "all" requires every
  // gate to ALLOW; "any" requires at least one ALLOW; "first_deny" stops at the
  // first DENY (default).
  shouldFire?: {
    compose?: "all" | "any" | "first_deny"
    gates: Array<{ kind: string; params?: GateParams }>
  }

  // GateDecision shape (return of every gate evaluator):
  //   { kind: "allow" }
  //   { kind: "deny", reason: string }
  //   { kind: "defer", until: { offsetMinutes: number } | { atIso: string }, reason: string }
  // Defer reschedules the same task; deny moves it to "skipped" with the reason logged.

  // Completion criterion — what counts as "done"? params are typed via the
  // CompletionCheckRegistry per kind.
  completionCheck?: {
    kind: string
    params?: CompletionCheckParams
    // followupAfterMinutes is mutually exclusive with pipeline.onSkip — see §8.10.
    // If both set, runner uses pipeline.onSkip and ignores followupAfterMinutes.
    followupAfterMinutes?: number
  }

  // Escalation ladder by reference or inline. Step.delayMinutes is measured
  // from the previous step's dispatch (or from fire time for step 0).
  // Snooze policy: snooze RESETS the ladder to step 0 at the new fire time
  // (§8.11 — pinned to remove the J16 ambiguity).
  escalation?: { ladderKey?: string; steps?: EscalationStep[] }

  // Where the task's output (if any) goes — recap to apple notes, draft into
  // gmail drafts, in-app card, etc. Without this, output destination is
  // ambiguous for recap/draft tasks (J7 finding).
  output?: {
    destination: "in_app_card" | "channel" | "apple_notes" | "gmail_draft" | "memory"
    target?: string                  // channel id, note id, etc.
    persistAs?: "task_metadata" | "external_only"
  }

  // Pipeline composition — fire these next when this task settles.
  pipeline?: {
    onComplete?: ScheduledTaskRef[]
    onSkip?: ScheduledTaskRef[]
    onFail?: ScheduledTaskRef[]
  }

  // Subject — the thing this task is about. Lets watchers and queries group
  // across tasks. Knowledge-graph subjects use kind = "entity" (a node — a
  // person, org, place, project) or kind = "relationship" (an edge — the
  // followup cadence between self and Pat). Non-graph subjects: thread,
  // document, calendar_event, self.
  subject?: {
    kind: "entity" | "relationship" | "thread" | "document" | "calendar_event" | "self"
    id: string
  }

  // Idempotency for retry-after-cancel and signal-twice scenarios.
  idempotencyKey?: string

  // Optional: pause this task until a globally-set pause window ends.
  // GlobalPauseStore (§3.16) sets the window; runner consults it pre-fire.
  respectsGlobalPause: boolean        // default true; emergency tasks set false

  // Tracking state managed by the runner.
  state: {
    status: TerminalState | "scheduled" | "fired" | "acknowledged"
    // Terminal-state taxonomy (pinned per game-through finding #4):
    //   completed = explicit user complete OR a registered completionCheck resolved.
    //   acknowledged = user saw it, no completion semantic — non-terminal; pipeline.onComplete does NOT fire.
    //   dismissed = user explicitly dismissed.
    //   skipped = a gate denied OR user said "skip this one".
    //   expired = no response, escalation ladder exhausted.
    //   failed = system error (connector outage, prompt render failure, etc.).
    firedAt?: string
    acknowledgedAt?: string
    completedAt?: string
    followupCount: number
    lastFollowupAt?: string
    pipelineParentId?: string         // for observability (§8.6)
    lastDecisionLog?: string          // last gate / dispatch / completion log line for the user-visible "why" surface
  }

  source: "default_pack" | "user_chat" | "first_run" | "plugin"
  createdBy: string
  ownerVisible: boolean
  metadata?: Record<string, unknown>
}

type TerminalState = "completed" | "skipped" | "expired" | "failed" | "dismissed"

ScheduledTaskRunner {
  schedule(task): ScheduledTask
  list(filter?): ScheduledTask[]
  apply(taskId, verb, payload?): ScheduledTask
  // verbs: snooze | skip | complete | dismiss | escalate | acknowledge | edit | reopen
  // edit = mutate non-state fields; reopen = move terminal task back to "scheduled" (e.g. late inbound).
  pipeline(taskId, outcome): ScheduledTask[]
}
```

**Schema-level decisions pinned from the game-through (J# = journey number):**
- **`shouldFire` is an array with composition mode** (J9). Single-gate stretch starter writes `{ compose: "first_deny", gates: [{ kind: "weekend_skip" }, { kind: "late_evening_skip" }, { kind: "stretch.walk_out_reset" }] }`.
- **Terminal-state taxonomy is pinned** (J4 / J5 / J16 / J17). `acknowledged` is explicitly non-terminal. `pipeline.onComplete` fires only on `completed`.
- **`output` is first-class** (J7). Without it, recap/draft tasks have nowhere documented to land their output.
- **`contextRequest` describes what the runner injects into the prompt** (J7 / J15). Replaces the implicit "the runner just knows" assumption.
- **`subject` makes entity/relationship/thread-scoped queries first-class** (J5 / J10 / J11) — queries become `list({ subject: { kind: "relationship", id: <self→pat-edge> } })` for follow-ups (the edge owns cadence) or `list({ subject: { kind: "entity", id: "pat-smith-1" } })` for "everything about Pat".
- **`idempotencyKey` collapses retry-after-cancel and double-signal cases** (J3 / J8).
- **`respectsGlobalPause` lets vacation mode pause everything except emergencies** (new §3.16).
- **`reopen` verb closes the gap from J5 / J11 / J17** — late inbound message after `expired` can move the task back to `scheduled` and re-resolve.

### 2.4 Default packs

A **default pack** is a TypeScript-registered set of `ScheduledTask` records that ship enabled out of the box (or are offered at first-run). Examples:

- **GM/GN starter** (high confidence): morning ping at the user's wake anchor; night ping at bedtime anchor.
- **Daily check-in** (medium confidence): a `ScheduledTask` at 8am whose prompt is "ask the user how they're feeling and what's on their plate today". Pipelines into a secondary `ScheduledTask` 30 minutes later if no response.
- **Habit starters** (8 entries from current `seed-routines.ts`, recast): brush teeth (twice daily), shower (3×/week), invisalign (lunchtime weekday), drink water (interval), stretch (interval with `weekend_skip + late_evening_skip` gate), vitamins (with-meal trigger), workout (afternoon with workout-blocker pipeline), shave (weekly).
- **Morning brief** assembler is itself a `ScheduledTask` that fires at the wake anchor and runs an "assemble these N sections" prompt.
- **Inbox triage starter**: "every weekday at 9am, summarize unread email by sender" — a `ScheduledTask` whose prompt invokes the Gmail connector.

**Critical invariant:** no part of the runtime pattern-matches a default-pack entry's title, key, or prompt content. The runner cares about trigger / priority / pipeline / state — **not** what the prompt says.

### 2.5 Configuration surface

- Users author tasks in chat ("remind me at 4pm on weekdays to drink water") — planner emits the typed `ScheduledTask`; user can edit fields.
- Users compose pipelines by reference ("after the 4pm reminder, if I don't reply, ping me again at 5pm") — planner emits `pipeline.onSkip`.
- Default packs ship pre-curated tasks; first-run flow (§5) chooses which packs to enable.
- Plugin contributions: any plugin can register a default pack; `plugin-health` ships the bedtime / wake-up packs.

### 2.6 Extension points

- **Gate kinds** register through a small `TaskGateRegistry`: `weekend_skip`, `quiet_hours`, `during_travel`, `stretch.walk_out_reset`. Each is a contracted `(task, ctx) => GateDecision`.
- **Completion-check kinds** register through a small `CompletionCheckRegistry`: `user_acknowledged`, `user_replied_within(channel, minutes)`, `subject_updated(subjectKind, id)`, `health_signal_observed(kind)`.
- **Trigger kinds** are listed above as a closed-by-design union (anchor / event / cron / etc.); new triggers go through code review.
- **Pipeline composition** is data — no extension needed.

### 2.7 What it replaces

- `seed-routines.ts` (8-template constant array; `STRETCH_ROUTINE_TITLE` exported string) — `HARDCODING_AUDIT.md` §2 Cat 1 entries collapse to one default pack of `ScheduledTask` records.
- `stretch-decider.ts` (144-line single-routine module) — collapses to a registered gate kind on the stretch starter task.
- `service-mixin-reminders.ts:567-606` `isStretchDefinition` / `evaluateStretchReminderGate` — title-string match is replaced by `task.shouldFire.kind === "stretch.walk_out_reset"`.
- `proactive-worker.ts:581-585` hardcoded `SEEDING_MESSAGE` — generated from default-pack metadata.
- The closed `LifeOpsWorkflowAction` union — workflow actions become `ScheduledTask` instances composed via `pipeline`.
- The 8 sleep-specific event kinds in `LIFEOPS_EVENT_KINDS` — become triggers on `plugin-health`-contributed `ScheduledTask` records.
- The standalone follow-up actions (`LIST_OVERDUE_FOLLOWUPS`, `MARK_FOLLOWUP_DONE`, `SET_FOLLOWUP_THRESHOLD`) and the parallel `RELATIONSHIP.*_followup` subactions — both reduce to `ScheduledTask` queries (`list({ kind: "followup", subject: { kind: "relationship", id } })`).
- The `RELATIONSHIP` umbrella itself — its CRUD verbs become `ENTITY.*` (per §3.4: ENTITY is the user-visible umbrella; the data backing is `EntityStore` + `RelationshipStore`); its follow-up verbs collapse onto `SCHEDULED_TASK` queries.

### 2.8 Existing partial implementations to leverage

- `LifeOpsCadence`, `LifeOpsReminderPlan`, `LifeOpsReminderAttempt` — vocabulary that informs the trigger / escalation fields.
- `LIFEOPS_OCCURRENCE_STATES` enum and `/occurrences/:id/{complete,skip,snooze}` endpoints (§25.4) — the verb surface already exists; widen it to operate on `ScheduledTask`.
- `service-mixin-workflows.ts` and the existing workflow runner — provides the trigger-evaluation skeleton; gets wrapped by the new `ScheduledTaskRunner`.
- `lifeops/checkin/*` — the existing CHECKIN service becomes the assembly logic invoked by the daily-check-in `ScheduledTask`'s prompt.

---

## §3 Supporting capabilities

These compose with `ScheduledTask` and one another. They remain distinct because they own real domain concerns the spine does not.

### 3.1 `ConnectorRegistry` — uniform connector contract

**One-liner:** a registry where every connector (Google, X, Telegram, Discord, Twilio, Signal, WhatsApp, iMessage, Strava, Fitbit, Withings, Oura, Calendly, Duffel, Plaid, PayPal, 1Password, Proton Pass, …) self-registers a dispatcher with start/disconnect/verify/status/send.

**Journeys:** §1.4–§1.6, §20 (entire chapter), §10.2, §12.3, §13.x.

**Replaces:** `VALID_CONNECTORS` enum + `CONNECTOR_DISPATCHERS` map (`HARDCODING_AUDIT.md` §1 themes #3 #4, §2 Cat 10, §6 high-confidence #10).

**Interface:** as in the prior version of this document — `ConnectorContribution { kind, capabilities[], describe, start, disconnect, verify, status, send?, read? }`. Capability strings are namespaced (`google.calendar.read`).

**How it composes with `ScheduledTask`:** when a task fires, its prompt may instruct the agent to invoke a connector verb (e.g. `gmail.draft.create`); the registry resolves the dispatcher.

### 3.2 `ChannelRegistry` — uniform channel/transport contract

**One-liner:** one registry replacing the three overlapping channel enums. Per-channel capability descriptors (read / send / reminders / voice / attachments / quiet-hours-aware).

**Journeys:** §1.5, §7.1, §15.1, §17.6, §20.

**Replaces:** `LIFEOPS_REMINDER_CHANNELS` ∪ `LIFEOPS_CHANNEL_TYPES` ∪ `LIFEOPS_MESSAGE_CHANNELS` (`HARDCODING_AUDIT.md` §6 medium-confidence #15).

**How it composes:** a `ScheduledTask`'s escalation steps reference channel keys; the registry resolves the dispatcher and capability set. Connectors implicitly contribute their channels.

### 3.3 `ApprovalQueue` + `ApprovalResolverRegistry`

**One-liner:** any high-stakes action enqueues a typed approval request; resolvers register per `request.action` so the queue's `approve` doesn't import every executor.

**Journeys:** §10.2, §11.2, §12.1, §17.1, §20.8, §28.6.

**Replaces:** the hardcoded `executeApprovedBookTravel` import in `RESOLVE_REQUEST.approve` (`HARDCODING_AUDIT.md` §6 high-confidence — implicit; §5.8 service-registry candidate).

**How it composes with `ScheduledTask`:** an approval gate is a 3-task pipeline (draft → approval-ScheduledTask whose `completionCheck` is "user approved" → execute). The approval queue itself is the service that lists outstanding approval-typed `ScheduledTask` records.

### 3.4 `ENTITY` + `RELATIONSHIP` — knowledge-graph primitive

**One-liner:** every persistent thing the agent reasons about — a person, an organization, a place, a project, a recurring concept — is an `Entity`. Each Entity carries its own per-connector identities (Telegram username, Gmail address, Discord handle, etc.). `Relationship` is a typed edge between two Entities, extracted from observations and carrying its own metadata (relationship type, cadence, importance, evidence, sentiment). The user is the special `self` Entity; everything else is an Entity with edges back. Identity-merge collapses two Entities when evidence proves they're the same.

**Journeys:** §11.2, §11.3, §14, §15, §18.1–§18.3, §19.1, §10 (travel: Acme is an organization Entity), §6 (goals: a goal can be a project Entity).

**Why ENTITY + RELATIONSHIP, not PEOPLE:**
- A "people" registry conflates nodes and edges by stuffing relationship data inside the person record. That works for the 1:1 case (Pat is my colleague) but breaks down when:
  - The thing isn't a person — Acme Corp, my apartment, the Q4 launch project all want the same primitive.
  - There are multiple relationships between the same pair — Pat is my colleague AND my friend, with different evidence and different cadences.
  - The relationship has its own observable history — last-meeting, sentiment trajectory, cadence drift — none of which belong on the node.
  - An LLM extraction reading "Pat is my manager at Acme" wants to write **two Entities** (Pat, Acme) **and three Relationships** (`self → Pat: managed_by`, `self → Acme: works_at`, `Pat → Acme: works_at`) into one model. PEOPLE forces this into a single record and loses the structure.
- Splitting nodes from edges is the standard knowledge-graph shape, matches how observations actually arrive (an observation is evidence for an entity OR an edge), and absorbs the existing `IdentityGraph + ContactResolver` pair without re-introducing the conflation.
- The user-visible verb is `ENTITY` (CRUD + relationship CRUD on the entity). The data is two stores. The user mental model is "people / things I track" — they don't think "edges of a graph" — but the agent benefits from the graph shape internally.

**Replaces:**
- Today's `LifeOpsRelationship` (`packages/shared/src/contracts/lifeops-extensions.ts:52-67`) — `primaryChannel + primaryHandle` is one row per person; ENTITY has N identities per node.
- The standalone `RELATIONSHIP` action (1193 lines, contacts CRUD + interaction log + follow-up tracker conflated). The umbrella becomes `ENTITY` (CRUD + relationship-edge CRUD); the follow-up subactions collapse onto `SCHEDULED_TASK` queries.
- The "split RELATIONSHIP into CONTACTS + FOLLOW_UPS" path proposed in `HARDCODING_AUDIT.md` §6 #6 — superseded.
- The earlier `PEOPLE` revision of this section — superseded; PEOPLE flattened the graph and is replaced.
- The 3 standalone follow-up actions (`LIST_OVERDUE_FOLLOWUPS`, `MARK_FOLLOWUP_DONE`, `SET_FOLLOWUP_THRESHOLD`) — collapse onto `SCHEDULED_TASK` queries with `subject.kind = "relationship"` (the cadence lives on the edge).
- `IdentityGraph` + `ContactResolver` — the resolver is `EntityStore.resolve`; the graph is the (`Entity` + `Relationship`) pair.

**Data shape:**

```ts
Entity {
  entityId: string                       // canonical, stable
  type: string                           // "person" | "organization" | "place" | "project" | "concept" | …
                                          // open string registered via EntityTypeRegistry; built-ins listed here
  preferredName: string                  // what the agent calls it
  fullName?: string
  // Per-connector identities (this is what merges).
  identities: Array<{
    platform: string                     // "telegram" | "discord" | "imessage" | "x" | "gmail" | "email" | "phone" | "url" | …
    handle: string                       // username/email/phone/url — opaque to the runtime
    displayName?: string                 // platform-side display
    verified: boolean                    // operator confirmed vs auto-merged
    confidence: number                   // 0..1
    addedAt: string
    addedVia: "user_chat" | "merge" | "platform_observation" | "extraction" | "import"
    evidence: string[]                   // observation ids that contributed
  }>
  // Open-keyed extracted attributes (location, employer, role, birthday, …).
  // Per-attribute schema is registered through EntityAttributeRegistry; runtime
  // does not branch on attribute keys.
  attributes?: Record<string, { value: unknown; confidence: number; evidence: string[]; updatedAt: string }>
  state: {
    lastObservedAt?: string
    lastInboundAt?: string
    lastOutboundAt?: string
    lastInteractionPlatform?: string
  }
  tags: string[]
  visibility: "owner_only" | "agent_and_admin" | "owner_agent_admin"
  createdAt: string
  updatedAt: string
}

Relationship {
  relationshipId: string
  fromEntityId: string                   // the source — usually `self` for ego-network edges
  toEntityId: string
  type: string                           // "manages" | "managed_by" | "partner_of" | "colleague_of" |
                                          // "lives_at" | "works_at" | "follows" | "knows" | "owns" | …
                                          // open string registered via RelationshipTypeRegistry
  // Per-type typed metadata (RelationshipTypeRegistry constrains shape).
  // Examples: { cadenceDays: 14 } for "follows"; { role: "engineer" } for "works_at".
  metadata?: Record<string, unknown>
  state: {
    lastObservedAt?: string
    lastInteractionAt?: string           // distinct from Entity.state.lastInboundAt — this is per-edge
    interactionCount?: number
    sentimentTrend?: "positive" | "neutral" | "negative"
  }
  evidence: string[]
  confidence: number                     // 0..1
  source: "user_chat" | "platform_observation" | "extraction" | "import" | "system"
  createdAt: string
  updatedAt: string
}

EntityStore {
  upsert(entity): Entity
  get(entityId): Entity | null
  list(filter?): Entity[]
  observeIdentity(obs: { platform; handle; displayName?; evidence; confidence }): { entityId; mergedFrom?: string[] }
  resolve(query: { name?: string; identity?: { platform; handle }; type?: string }): Array<{ entity; confidence; evidence; safeToSend: boolean }>
  recordInteraction(entityId, { platform; direction; summary; occurredAt }): void
  merge(targetId: string, sourceIds: string[]): Entity     // explicit merge with full audit trail
}

RelationshipStore {
  upsert(rel): Relationship
  get(relationshipId): Relationship | null
  list(filter?: { fromEntityId?; toEntityId?; type?; "metadata.cadenceDays.<="?; … }): Relationship[]
  // Extraction entry point — observed evidence strengthens an existing edge or proposes a new one.
  observe(obs: { fromEntityId; toEntityId; type; metadataPatch?; evidence; confidence }): Relationship
  retire(relationshipId, reason: string): void            // soft-delete with audit
}
```

**Self entity:** the user is one Entity with `entityId = "self"` and `type = "person"`. All ego-network edges originate from `self`. The agent can also reason about edges that don't include `self` (Pat works at Acme) — these are extracted from messages or imports and form the broader graph.

**Journey support:**
- "Follow up with David" — planner calls `EntityStore.resolve({ name: "David", type: "person" })`; if multiple Davids, ambiguous-resolution `ScheduledTask` is created for the user to disambiguate.
- "Pat replied on Telegram" (after we sent on Gmail) — inbound contributes (a) an `observeIdentity` call adding a Telegram identity to `pat-smith-1`'s entity, and (b) a `RelationshipStore.observe` call strengthening the `self → pat-smith-1: colleague_of` edge with new evidence + updating `state.lastInteractionAt`.
- The followup `ScheduledTask` for that thread has `subject = { kind: "relationship", id: <self→pat edge id> }` and `completionCheck.kind = "subject_updated"` — when the relationship state advances (i.e. Pat replies on any platform), the task completes regardless of which connector carried the reply.
- Identity merge — `observeIdentity` collapses two Entity records when the new evidence proves they're the same person (e.g. same phone number observed across platforms).
- Group-chat handoff (J13) — `EntityStore.list({ filter: { involvedInRoom: roomId } })` tells the runner who else is in the thread; the planner uses that to decide handoff conditions.
- "Pat is my manager at Acme" extraction — produces `Entity(person, Pat)`, `Entity(organization, Acme)`, `Relationship(self → pat: managed_by)`, `Relationship(self → acme: works_at)`, `Relationship(pat → acme: works_at)`. Five rows from one utterance, each independently revisable as new evidence arrives.

**Wave-1 schema migration:** `lifeops_relationships` rows convert to **paired** `(Entity, Relationship)` rows:
- The `Entity` row promotes `primaryChannel + primaryHandle` into `identities[0]` with `verified: true, confidence: 1.0, addedVia: "import"`.
- A `Relationship` row from `self → entity` carries the prior `relationshipType` (mapped to type via a small migration table — `"partner"` → `"partner_of"`, `"colleague"` → `"colleague_of"`, etc.; unknown types pass through as raw strings), `notes` (in metadata), and `lastContactedAt` (in `state.lastInteractionAt`).
- `lifeops_relationship_interactions` rows survive in place; the new query layer reads them as Relationship-scoped history (the existing `relationshipId` foreign key already points at what is now an `entityId` — the migrator updates the reference column to point at the new `Relationship.relationshipId` instead, with the prior column kept as `legacyEntityId` for one release).
- Migrator runs dry-run by default; `--apply` writes; produces a manual-review JSON of every (entity, relationship) pair created, every merge proposal, and every type-mapping decision.

**How it composes with `ScheduledTask`:**
- `subject.kind` extends to `"entity" | "relationship" | "thread" | "document" | "calendar_event" | "self"`.
- Entity-scoped tasks (e.g. "remind me about Acme's Q4 launch on Friday") set `subject = { kind: "entity", id: <acmeId> }`.
- Edge-scoped tasks (follow-ups) set `subject = { kind: "relationship", id: <edgeId> }` because the cadence + interaction state lives on the edge, not the node.
- Identity-resolution at task fire-time uses `EntityStore.resolve` (e.g. to pick the right channel based on the Entity's most-recent active identity).

**Why this is better than the prior PEOPLE shape (and why it doesn't make things baroque):** the data is the same data — handles + relationship metadata + interactions. The schema split just refuses to lie about what's a node and what's an edge. Code that wanted to write `person.relationship.cadence` writes `relationshipStore.upsert({ from: "self", to: <id>, type: "follows", metadata: { cadenceDays } })`. Code that wanted `person.handles` writes `entityStore.observeIdentity(...)`. The user-visible verb stays `ENTITY` and the planner's mental model stays "people I track" — the graph is internal to the data layer, not an exposed surface.

### 3.5 `ActivitySignalBus` — unified signal stream

**One-liner:** every activity source (mobile device, browser focus, screen time, OS lock, charging, manual override, health connector via `plugin-health`) publishes typed signals on one bus; subscribers (anchor resolvers, completion-check evaluators, default-pack workflows) consume them.

**Journeys:** §16.1–§16.6, §21.4–§21.6, §22.4.

**Replaces:** the closed `LIFEOPS_TELEMETRY_FAMILIES` discriminated union (`HARDCODING_AUDIT.md` §2 Cat 7 row).

**How it composes:** `ScheduledTask` triggers of kind `event` filter against the bus; completion checks of kind `health_signal_observed` query the bus. After the `plugin-health` extraction (§4), health signals arrive on the bus from the plugin, not from app-lifeops core.

### 3.6 `BlockerRegistry` — generic block/unblock/earned-access primitive

**One-liner:** a registry where any "thing the user wants to be blocked from" (website, app, account, category, computer-use action) registers an enforcer + unlock-policy hooks; chat-driven block/unblock/earn-access works uniformly.

**Journeys:** §3.15, §13.1–§13.6, §21.4–§21.6, §28.13.

**Replaces:** `WEBSITE_BLOCK.unblock` / standalone `RELEASE_BLOCK` / `LIST_ACTIVE_BLOCKS` collisions; `DEFAULT_AUTOFILL_WHITELIST` 49-domain constant array (`HARDCODING_AUDIT.md` §2 Cat 4, §2 Cat 7 row, §6 high-confidence #6).

**How it composes:** unlock-on-callback maps to a `ScheduledTask` with `trigger.kind = "after_task"`. Earned-access workflows (workout completion → 30 min unblock) are pipelined `ScheduledTask` records.

### 3.7 `MultilingualPromptRegistry`

**One-liner:** action examples and routing hints live as registered translation tables, not as `ActionExample` literals embedded in source.

**Journeys:** §3.6, §8.8, §9 multilingual variants, §27.

**Replaces:** inline Spanish brush-teeth example in `life.ts:3509-3517` (`HARDCODING_AUDIT.md` §2 Cat 5, §6 low-confidence #21).

**How it composes:** the registry serves prompt examples to actions and to default-pack `ScheduledTask` records; user locale comes from `OwnerFactStore`.

### 3.8 `FeatureFlagRegistry`

**One-liner:** features self-register with metadata (label, description, costsMoney, default, cloud-default-on); the closed `LifeOpsFeatureKey` union is replaced by registered keys.

**Journeys:** §10.9, §24.5, §25.22.

**Replaces:** closed `LifeOpsFeatureKey` union (`HARDCODING_AUDIT.md` §2 Cat 7 row, §5.6).

**How it composes:** any `ScheduledTask` may declare a `requiresFeatureFlag`; the runner skips it (with audit) if disabled. Default packs declare which flags they need.

### 3.9 `OwnerFactStore`

**One-liner:** owner facts (name, partnerName, relationshipStatus, age, location, preferences, travel-booking-preferences, locale, notification preferences) live in a single typed store with provenance, distinguishing facts from policies.

**Journeys:** §10.1, §19.3, §19.5, §27.3.

**Replaces:** `PROFILE.save` ≡ `set` aliases; `set_reminder_preference` / `configure_escalation` mis-located as profile concerns (`HARDCODING_AUDIT.md` §6 high-confidence #7, #8).

**How it composes:** first-run (§5) writes the owner's initial facts here. Default packs read from it (e.g. wake anchor uses `ownerFact.morningWindow`); `ScheduledTask` prompts can reference owner facts through the runner's context.

### 3.10 First-run provider + action

See §5 below — this is a regular member of the supporting-capability list, distinct from `ScheduledTask` because it is the engine that **creates** the user's initial pack of tasks. Treated as its own capability so its lifecycle (provider runs until completion, then goes silent) is explicit.

### 3.11 `PendingPromptsProvider` — inbound-to-task correlation

**One-liner:** when a `ScheduledTask` fires and is awaiting a reply (`completionCheck.kind === "user_replied_within"` or implicit `user_acknowledged`), this provider tells the planner "room R has open prompt P from task T" so the planner can route the next inbound message to that task's `complete` / `acknowledge` verb instead of treating it as a fresh request.

**Journeys:** J5 (the user's check-in concern), J6 (approval reply), J10 (followup reply).

**Replaces:** the silent gap surfaced by game-through finding #1 — `user_replied_within` cannot resolve today because no surface tells the planner which task an inbound message replies to.

**Interface:**

```ts
PendingPromptsProvider {
  // Returns the open prompts for a given room/conversation, ranked by recency.
  // Used by the planner to decide whether to route inbound to an open task or
  // treat it as a fresh request.
  list(roomId: string, opts?: { lookbackMinutes?: number }):
    Array<{
      taskId: string
      promptSnippet: string         // first ~120 chars of promptInstructions
      firedAt: string
      expectedReplyKind: "any" | "yes_no" | "approval" | "free_form"
      expiresAt?: string
    }>
}
```

**Resolution rule:** when an inbound message arrives and exactly one open prompt exists for the room within `expiresAt`, the planner correlates by default. When more than one, the planner asks the user ("are you replying to the check-in or the draft?") OR uses an LLM classifier with the open-prompt list as context. When zero, the message routes as fresh.

**Pinned**: this provider is mandatory in Wave 1; without it the daily check-in journey (J5) does not work end-to-end.

### 3.12 `RecentTaskStatesProvider` + status aggregator

**One-liner:** the provider summarizes the user's recent `ScheduledTask` outcomes ("missed 3 check-ins in a row", "ignored gm 5 days running", "finished workout streak: 4 days") so the planner can both (a) bring it up proactively in the morning brief and (b) answer "did I check in yesterday?" without scanning rows.

**Journeys:** J5 (the user's specific concern: "did I check in / follow up?"), J4 (gm streaks), J16 (snooze patterns).

**Replaces:** the gap surfaced by game-through finding #5 — the spine has no aggregator. Without it, "did the user check in" is an ad-hoc DB scan with no consumer.

**Interface:**

```ts
RecentTaskStatesProvider {
  summarize(opts?: {
    kinds?: ScheduledTask["kind"][]
    subjectIds?: string[]
    lookbackDays?: number
  }): {
    summary: string                  // human-readable, planner-injectable
    streaks: Array<{ kind: ScheduledTask["kind"]; outcome: TerminalState; consecutive: number }>
    notable: Array<{ taskId: string; observation: string }>
  }
}
```

**Re-engagement aggregator:** a default-pack `ScheduledTask` (the "quiet-user watcher") fires at the wake anchor; its prompt instructs the agent to read the recent-task-states summary and surface "you've been quiet for N days" / "you missed yesterday's check-in" as part of the morning brief. This is the canonical surface for the silence-after-N-days re-engagement concern.

### 3.13 `FollowupWatcher` — canonical watcher runtime

**One-liner:** a single recurring `ScheduledTask` (`kind = "watcher"`) registered by the followup default pack. Its prompt scans `RelationshipStore` for cadence violations (`type === "follows"` or any edge type whose registered metadata declares a cadence), and creates child `ScheduledTask` records with `kind = "followup"`, `subject = { kind: "relationship", id: <edgeId> }`, and `completionCheck.kind = "subject_updated"` so any new interaction on the edge resolves it.

**Journeys:** J10 (Pat hasn't replied for 4 days), §11.4–§11.6.

**Replaces:** the unspecified watcher runtime flagged in game-through finding #10. With this section, the watcher IS a `ScheduledTask` — same primitive — owned by the followup default pack that W1-D ships.

**Why the watcher reads the edge, not the entity:** cadence is an edge property — "I want to stay in touch with Pat (the colleague edge) every 14 days." A pure-entity model couldn't express different cadences for different relationships to the same person (Pat the colleague: 14 days; Pat the friend: 30 days). Reading the edge avoids that loss.

**Why a watcher-task instead of a separate cron service:** keeps the spine homogeneous. The watcher is data, not code. Disabling all followups = disable one task. Adjusting cadence default = edit the prompt. Adding new watchers (document-staleness, calendar-conflict, project-stalled — all express as edge-watchers over different `RelationshipType`s) is a default-pack contribution, not a code change.

### 3.14 `HandoffStore` + `MESSAGE.handoff` verb

**One-liner:** a per-room state store + a verb. When the agent says "I'll let you take it from here" in a multi-party thread, the store flips the room into handoff mode; the planner's room-policy provider gates further agent contributions until a resume condition fires.

**Journeys:** J13 (group-chat handoff), §14.1.

**Replaces:** the zero-architecture gap flagged by game-through finding #2.

**Interface:**

```ts
HandoffStore {
  // Mark a room as handed off; the agent stops contributing until resume.
  enter(roomId, opts: { reason: string; resumeOn: ResumeCondition }): void
  exit(roomId): void
  status(roomId): { active: boolean; enteredAt?: string; resumeOn?: ResumeCondition }
}

type ResumeCondition =
  | { kind: "mention" }                                  // agent re-engages on @mention
  | { kind: "explicit_resume" }                          // user must say "agent come back"
  | { kind: "silence_minutes"; minutes: number }
  | { kind: "user_request_help"; userId: string }
```

**Provider integration:** a `RoomPolicyProvider` runs early in context assembly; if `HandoffStore.status(roomId).active`, it injects "this room is in handoff mode — do not respond unless [resume condition]" into the planner context. Combined with the planner's standard discretion, this halts contributions cleanly.

### 3.15 `GlobalPauseStore` — vacation / pause mode

**One-liner:** a single switch the user can throw to pause all `ScheduledTask` firing for a window ("pause everything for 5 days", "pause until Monday"). Tasks with `respectsGlobalPause = false` (emergencies, critical followups) fire anyway.

**Journeys:** new — flagged in the user's review additions. Without this, pausing 30 tasks for vacation requires snoozing each one.

**Interface:**

```ts
GlobalPauseStore {
  set(window: { startIso: string; endIso?: string; reason?: string }): void
  clear(): void
  current(): { active: boolean; startIso?: string; endIso?: string; reason?: string }
}
```

**Runner consultation:** before each fire evaluation, the runner calls `current()`. If active and the task `respectsGlobalPause`, the task is recorded as `skipped` with reason `global_pause`. If `endIso` exists, the runner reschedules at `endIso` (the user's "resume my routine" moment).

### 3.16 `ConsolidationPolicy` — anchor co-fire batching

**One-liner:** when N tasks fire on the same anchor (J15: gm + sleep recap + morning brief all on `wake.confirmed`), the runner batches their renders into a single user-facing message instead of spamming three notifications. Policy is data on the anchor, not on individual tasks.

**Journeys:** J15 (multi-task event-fire ordering), J4 (multi-task gm).

**Interface:**

```ts
AnchorConsolidationPolicy {
  anchorKey: string
  mode: "merge" | "sequential" | "parallel"   // merge = one combined message; sequential = staggered N min apart; parallel = concurrent (default for non-user-facing tasks like watchers)
  staggerMinutes?: number                     // for sequential mode
  maxBatchSize?: number                       // splits into multiple messages above this
  sortBy?: "priority_desc" | "fired_at_asc"
}
```

**Default-pack registration:** W1-D ships `wake.confirmed` with `mode: "merge", sortBy: "priority_desc"` so morning brief + gm + sleep recap render as one cohesive read.

### 3.17 `ConnectorTransportContract` — typed dispatch result + fallback

**One-liner:** `ConnectorContribution.send` returns a typed result that lets the runner choose between advance-escalation, retry-with-backoff, fail-loud, or queue-for-recovery. Without this, every connector outage is a silent failure (J17).

**Journeys:** J4, J16, J17.

**Interface:**

```ts
type DispatchResult =
  | { ok: true; messageId?: string }
  | { ok: false; reason: "disconnected" | "rate_limited" | "auth_expired" | "unknown_recipient" | "transport_error"; retryAfterMinutes?: number; userActionable: boolean }

// Channel dispatch policy applied by the runner:
// - userActionable failure (e.g. auth_expired) → surface in connector-degradation provider; advance to next escalation step.
// - retryAfterMinutes set → reschedule with backoff, do not advance ladder.
// - permanent failure → mark step as failed, advance to next escalation step.
// - all steps failed → state.status = "failed", pipeline.onFail fires.
```

---

## §4 `plugin-health` — extracted health/sleep/screen-time plugin

### 4.1 Why a separate plugin

Health, sleep, and screen-time are a coherent domain with their own platform-bridge complexity (`HealthKit` CLI helper, Google Fit OAuth, Strava / Fitbit / Withings / Oura connectors, screen-time aggregation, the entire sleep-cycle / circadian / regularity model). Today this is intermingled with LifeOps core: ~20 lifeops files own sleep/health logic, the contracts file declares 8 sleep-specific event kinds as first-class, and the activity-signal bus is partially shaped around health telemetry. Lifting it into its own plugin lets LifeOps remain a generic personal-life-operations engine that **consumes** health data through the connector / signal-bus contracts.

### 4.2 Naming and location

`eliza/plugins/plugin-health` — matches the repo's `plugin-<name>` convention (verified against `eliza/plugins/` listing: `plugin-bluebubbles`, `plugin-google`, `plugin-imessage`, `plugin-signal`, etc.). Not `app-health` because there is no user-facing app surface; the plugin contributes connectors / signals / default-pack `ScheduledTask` records but no dashboard UI of its own (LifeOps surfaces what it consumes).

### 4.3 Scope of the move (atomic, single wave)

Files / surfaces that move from `eliza/plugins/app-lifeops/src/` into `eliza/plugins/plugin-health/src/`:

**Sleep / circadian (server-side):**
- `lifeops/sleep-cycle.ts`
- `lifeops/sleep-episode-store.ts`
- `lifeops/sleep-regularity.ts`
- `lifeops/sleep-wake-events.ts`
- `lifeops/awake-probability.ts`
- `lifeops/circadian-rules.ts`
- `lifeops/service-mixin-sleep.ts`
- `lifeops/checkin/sleep-cycle-dispatch.ts`
- The 8 sleep event kinds (`lifeops.sleep.onset_candidate`, `lifeops.sleep.detected`, `lifeops.sleep.ended`, `lifeops.wake.observed`, `lifeops.wake.confirmed`, `lifeops.nap.detected`, `lifeops.bedtime.imminent`, `lifeops.regularity.changed`) and their filter types — currently in `packages/shared/src/contracts/lifeops.ts`.
- The `LIFEOPS_CIRCADIAN_STATES` / `LifeOpsCircadianState`, `LifeOpsScheduleInsight`, `LifeOpsPersonalBaseline`, `LifeOpsSleepCycle` types — same contract file.

**Health-bridge / fitness connectors:**
- `lifeops/health-bridge.ts` (HealthKit CLI helper, Google Fit OAuth-bridged read)
- `lifeops/health-connectors.ts`
- `lifeops/health-oauth.ts`
- `lifeops/service-mixin-health.ts`
- `lifeops/service-normalize-health.ts`
- `actions/health.ts`

**Screen-time:**
- `lifeops/service-mixin-screentime.ts`
- `actions/screen-time.ts`
- `lifeops/screen-context.ts` (if it ends up health-coupled — to be confirmed in Wave 1; if it's generic activity context it stays in lifeops)

**Platform note:** there is no separate iOS / Android / macOS native plugin in this repo today. The "platform" code is two integration points: (1) the `HealthKit` CLI helper invoked via `execFile` in `health-bridge.ts` (the helper binary is not in the repo; `process.platform === "darwin"` gates its use), and (2) the Google Fit REST API OAuth dance. The `eliza/plugins/app-lifeops/src/platform/` directory is a one-file misnomer (`lifeops-github.ts` only) and is not part of the move. Bluebubbles / iMessage / Signal connectors are already separate plugins and stay where they are.

**Cross-plugin contract:** sleep / health / screen-time types either move into `plugin-health/src/contracts/` (preferred) or into a new `packages/shared/src/contracts/health.ts` if cross-plugin shared typing turns out to be required. Roughly ~100 importers of sleep types from `packages/shared/src/contracts/lifeops.ts` need their imports remapped (verified by grep of `Sleep|Circadian|Bedtime|Wake|HealthMetric` across the eliza tree). The remap is part of the atomic move, not a phased re-export dance.

### 4.4 Interface LifeOps consumes

LifeOps uses `plugin-health` strictly through:

- **`ConnectorRegistry` contributions** — `plugin-health` registers `apple_health`, `google_fit`, `strava`, `fitbit`, `withings`, `oura`. LifeOps queries them via the connector contract; no direct import.
- **`ActivitySignalBus` publications** — `plugin-health` publishes `health.sleep.detected`, `health.wake.observed`, `health.workout.completed`, etc. on the bus. LifeOps subscribes through the bus contract.
- **`AnchorRegistry` contributions** — `plugin-health` contributes `wake.confirmed`, `bedtime.target`, `nap.start`. LifeOps uses anchors generically through its trigger field.
- **Default-pack `ScheduledTask` contributions** — `plugin-health` ships the bedtime / wake-up / sleep-recap default tasks. The lifeops runner schedules them like any other task.

### 4.5 Confidence / known unknowns

- **High confidence:** the move is well-bounded. The files are visible; the sleep contract is a clearly bounded sub-tree of `lifeops.ts`; the consumers of the moved types are addressable by grep.
- **Open question:** does `screen-context.ts` move with health (screen-time is health-adjacent) or stay in lifeops (screen-time may be a general activity-context concern)? Resolve in Wave 1 by reading the file in full and tracing call sites.
- **Open question:** does the `LIFEOPS_TELEMETRY_FAMILIES` discriminated union split — health families to `plugin-health`, generic activity families stay in lifeops — or stay together with health families re-registering via the bus contract from outside? The latter is preferred for symmetry; confirm in Wave 1.

---

## §5 First-run capability

### 5.1 Why this is a first-class capability

Every other capability is silent unless the user already knows what to ask for. First-run is the single moment where the agent says "I can do these things; want defaults or want me to ask you a few questions?" — and where the user's initial `ScheduledTask` pack gets created. Treating first-run as its own capability makes the lifecycle explicit (provider goes silent after completion) and makes both paths (defaults / customize) testable in isolation.

### 5.2 Two parts

- **Provider** — surfaces "first-run not yet completed" context to the planner. Quiet when first-run is done. Exposes one affordance the LLM can pick up: "the first-run flow is available". Zero noise after completion.
- **Action** — runs the first-run flow when invoked. The LLM picks it from the provider's affordance, or the user can invoke it directly ("run first-run setup again" — re-entrant for re-onboarding).

### 5.3 Two paths

#### Path A: Defaults

Apply a curated default pack:

- **Daily anchors** — gm reminder at the configured morning window; gn reminder at evening window (low priority, dismiss-friendly).
- **Daily check-in** — single `ScheduledTask` at 9am whose prompt is "ask the user how they're feeling and what's on their plate today".
- **Morning brief stub** — `ScheduledTask` at the wake anchor (or 9am default) that runs the morning-brief assembler.
- **Time windows** — register the four standard windows (`morning`, `afternoon`, `evening`, `night`) and three meal windows (`breakfast`, `lunch`, `dinner`) on the user's profile. (Once `TimeWindowRegistry` lands as part of the supporting registries.)
- **Notification channel** — defaults to `in_app`; user can change later.
- **No habits seeded silently.** The 8 habit starters from the legacy `seed-routines.ts` are **offered** in the provider's affordance ("want me to suggest some habits?") but not auto-seeded — matches the user's "leave it up to the user" principle.

User can edit any of the above later.

#### Path B: Customize

Agent asks a small set of questions, then seeds a personalized pack. **Recommended question set** (open to user override before Wave 1 default-pack curation):

1. **What should I call you?** — fills `ownerFact.preferredName`.
2. **What time zone are you in, and what counts as your morning / evening?** — fills `ownerFact.timezone`, `ownerFact.morningWindow`, `ownerFact.eveningWindow` (defaults `morning = 06:00–11:00`, `evening = 18:00–22:00` if user gives no specifics).
3. **Which categories sound useful to enable now?** Multi-select:
   - Sleep tracking (enables `plugin-health` connectors offer)
   - Reminder packs (offers gm/gn + check-in)
   - Inbox triage (gates on Gmail connector — offered later)
   - Blockers / focus (gates on `plugin-bluebubbles` or browser-bridge)
   - Follow-ups (offers relationship cadence default tasks)
4. **Where do you want me to nudge you?** — single-select among registered channels (`in_app`, `push`, `imessage`, `discord`, `telegram`); fills `ownerFact.preferredNotificationChannel`.
5. **(Optional, only if user picked "follow-ups")** — list 3–5 important relationships and a default cadence ("ping me if I haven't talked to them in N days").

Q1 / Q2 / Q4 always asked; Q3 / Q5 conditional. Answers populate `OwnerFactStore` plus a starter `ScheduledTask` set. Total interaction budget: under 90 seconds for a user who answers tersely.

### 5.4 Required tests

- **E2E — Defaults path:** invoke first-run with `path = "defaults"`; assert (a) the expected default-pack `ScheduledTask` records were created with correct triggers / priorities, (b) the provider goes silent on the next turn, (c) a re-invocation is a no-op (or surfaces "already completed").
- **E2E — Customize path:** invoke first-run with synthetic answers to the 5 questions; assert (a) `OwnerFactStore` contains the expected facts, (b) the seeded `ScheduledTask` records match the answers, (c) provider goes silent, (d) re-invocation is gated.
- **Validation tests for produced configuration:** schema-valid `ScheduledTask` records, no unregistered trigger / gate kinds referenced, all referenced channels registered in `ChannelRegistry`, all referenced anchors resolve.

### 5.5 Existing surface to leverage

The current onboarding messages in `service-mixin-definitions.ts`'s `checkAndOfferSeeding` / `applySeedRoutines` (`service-mixin-definitions.ts:75,247-348`) are roughly the right shape — they're the closest existing analog. The first-run capability supersedes them: their logic moves into the first-run action, parameterized by path + answer set.

---

## §6 Coverage Matrix

Coverage today: ✅ exists generically | 🟡 exists but hardcoded/scenario-shaped | ❌ missing entirely.

Every domain is now expressed as **`ScheduledTask` (with default-pack entries) + supporting capabilities**. The matrix shows both what each domain needs and where it stands today.

| Journey domain (§ in `UX_JOURNEYS.md`) | Required: `ScheduledTask` default-pack entries + supporting capabilities | Coverage today |
|---|---|---|
| §1 Onboarding | First-run capability (§5) + `OwnerFactStore` + `ConnectorRegistry` + default packs offered | 🟡 (seed-routines hardcoded; no first-run capability per se) |
| §2 Core data model | `ScheduledTask` spine + `OccurrenceStateMachine` verbs as task verbs + `ChannelRegistry` | 🟡 (occurrence states are clean; channels are 3 overlapping enums; spine not extracted) |
| §3 Habits | `ScheduledTask` (per-habit) + gates registered (`weekend_skip` etc.) + `TimeWindowRegistry` + `MultilingualPromptRegistry` | 🟡 (cadence types clean; gates and seeds are stretch-coupled, hardcoded) |
| §4 Routines & multi-step daily flows | `ScheduledTask` pipelines (the "obvious series of instructions" pattern) + anchors | 🟡 (CHECKIN action misplaced; pipelines do not exist as a primitive) |
| §5 Tasks (one-off) | `ScheduledTask` (`trigger.kind = "once" | "manual"`) + verbs | ✅ (mostly clean; reduces to spine) |
| §6 Goals | `OwnerFactStore` + goal-grounding (existing) — goals are a separate concept that may schedule supporting `ScheduledTask` reviews | ✅ |
| §7 Reminders & escalation | `ScheduledTask.escalation` + `ChannelRegistry` + gate kinds (quiet hours, weekend skip) | 🟡 (channel enums; review-without-ack hardwired) |
| §8 Calendar | `ConnectorRegistry` (Google + Calendly + Duffel) + `ScheduledTask` (e.g. T-1h meeting prep) + anchors + time windows | 🟡 (CALENDAR umbrella has 24 subactions; named-person tags) |
| §9 Inbox & email triage | `ConnectorRegistry` (Gmail) + `ScheduledTask` (draft → approval → send pipeline) + send-policy on Gmail connector | 🟡 (Gmail-coupled; OWNER_APPROVAL_REQUIRED hardcoded) |
| §10 Travel | `ConnectorRegistry` (Duffel) + `ApprovalQueue + Resolver` + `FeatureFlagRegistry` (kept compound — see §7) | 🟡 (Duffel hardcoded; resolver hardcoded import) |
| §11 Follow-up repair | `ScheduledTask` (`kind = "followup"`, `subject = { kind: "relationship", id }`) + `FollowupWatcher` (§3.13) + `ENTITY + RELATIONSHIP` (§3.4 — cadence on the edge) + draft-pipeline | 🟡 (collisions: standalone follow-up actions vs RELATIONSHIP subactions; entity/relationship split not yet implemented) |
| §12 Documents, signatures, portals | `ApprovalQueue + Resolver` + `ScheduledTask` (signature-deadline followups via pipeline) + `ConnectorRegistry` (browser-bridge) | 🟡 (signature/portal flows ad-hoc; resolver missing) |
| §13 Self-control / blockers | `BlockerRegistry` + `ScheduledTask` (relock callbacks) | 🟡 (collisions: standalone block actions vs WEBSITE_BLOCK subactions) |
| §14 Group chat handoff | `HandoffStore` (§3.14) + `MESSAGE.handoff` verb + `EntityStore` (multi-party room awareness via entity-room participation) + draft-pipeline | ❌ (no handoff verb today — see game-through J13) |
| §15 Multi-channel & cross-channel search | `ChannelRegistry` + `ConnectorRegistry` | 🟡 (channels enumerated three ways) |
| §16 Activity signals & screen context | `ActivitySignalBus` + anchors fed from bus | 🟡 (telemetry families closed discriminated union) |
| §17 Approval queues & action gating | `ApprovalQueue + ApprovalResolverRegistry` + `ScheduledTask` for queued items | 🟡 (lifecycle clean; resolver dispatch hardcoded) |
| §18 Identity merge | `EntityStore.observeIdentity` + `EntityStore.merge` (§3.4) | 🟡 (today's identity-graph + observations exist; consolidate into EntityStore) |
| §19 Memory recall | `OwnerFactStore` + `EntityStore` + `RelationshipStore` + reflection (existing) | ✅ |
| §20 Connectors & permissions | `ConnectorRegistry` + capability strings | 🟡 (per-connector capability enums hardcoded) |
| §21 Health, money, screen time | `plugin-health` (extracted) consumed via `ConnectorRegistry` + `ActivitySignalBus`; money via separate connectors | 🟡 (sleep / health / screen-time intermingled in lifeops core) |
| §22 Push notifications | `ChannelRegistry` (push channel) + `ScheduledTask.escalation` | 🟡 (Twilio/ntfy hardcoded as singletons) |
| §23 Remote sessions | (largely standalone — keep as-is) | ✅ |
| §24 Settings & UX | `FeatureFlagRegistry` + `OwnerFactStore` + first-run re-entry | 🟡 |
| §25 REST API surface | All capabilities project a REST surface; `ScheduledTask` adds CRUD endpoints | ✅ (other endpoints) / ❌ (`ScheduledTask` REST) |
| §26 Workflows | `ScheduledTask` with `trigger.kind = "event"` (workflows are tasks) + `ActivitySignalBus` + `AnchorRegistry` | 🟡 (closed action union; sleep-coupled schedule kinds) |
| §27 Multilingual coverage | `MultilingualPromptRegistry` + `OwnerFactStore` (locale) | ❌ (everything inline today) |
| §28 Suspected-but-unconfirmed flows | Various — mostly "exists but not exercised end-to-end" | n/a |

---

## §7 What is NOT a gap

These items might look like targets for capability-fication but should remain compound or domain-shaped. They are intentional structure, not sediment.

### 7.1 `BOOK_TRAVEL` stays compound
`HARDCODING_AUDIT.md` §7: search → missing-detail collection → draft → approval → book → payment → calendar sync is a transactional thread. The owner approves the trip, not each step. Cleanup is putting Duffel behind `ConnectorRegistry` (§3.1) and the resolver behind `ApprovalResolverRegistry` (§3.3); the action stays one verb. (Confirmed: `HARDCODING_AUDIT.md` §7 explicitly lists this as "must remain transactional".)

### 7.2 `bulk_reschedule` and the `negotiate_*` lifecycle stay compound
`HARDCODING_AUDIT.md` §7: `bulk_reschedule` is preview→commit transactional; `negotiate_*` is a single long-running stateful actor whose 7 lifecycle verbs (`start / propose / respond / finalize / cancel / list_active / list_proposals`) belong on one entity.

### 7.3 `RESOLVE_REQUEST` stays one verb
The dispatcher table becomes a registry (§3.3), but `approve` / `reject` are two verbs of one action — not three actions.

### 7.4 `RELEASE_BLOCK` and `OWNER_SEND_APPROVAL` stay transactional
Both are multi-step but state-must-be-coherent. (`HARDCODING_AUDIT.md` §7.)

### 7.5 Per-connector wiring is irreducibly per-connector
`ConnectorContribution` (§3.1) makes the **registration shape** uniform. Google OAuth, Telegram MTProto auth, Signal QR pairing are not the same code under the hood and shouldn't be forced behind a misleadingly uniform pretend-implementation. Contract uniform; implementations domain-specific.

### 7.6 Compound briefings (morning brief, night brief, dossier, daily-left-today) stay as one operation
§4.1 morning brief composes 6 sections from underlying registries. The composition is one operation — splitting it into 6 actions would yield inconsistent time slices. The `ScheduledTask` for the morning-brief fires at the wake anchor and runs an "assemble these N sections" prompt whose body is one cohesive read.

### 7.7 Calendar `feed`, `next_event`, `search_events`, `create_event`, `delete_event`, `update_event`, `trip_window` stay as planner-classified subactions
`UX_JOURNEYS.md` §8.8 multilingual subaction matrix is the asserted contract — these are the irreducible verbs of a calendar provider. Behind `ConnectorRegistry` per provider but the verb set itself is real.

### 7.8 The 4-window `morning/afternoon/evening/night` baseline stays
`TimeWindowRegistry` is extensible, but having 4 well-known defaults that everyone shares is intentional — user, planner, and downstream policies all benefit from the shared vocabulary. The bug is meal labels being closed (the registry fixes that), not the windows being named.

### 7.9 `LIFE` and `MESSAGE` umbrellas stay (with internal registry-driven dispatch)
The user-visible LLM action stays one umbrella because that maps to the user mental model. The internal switch becomes a registry consultation. Per `HARDCODING_AUDIT.md` §6 medium-confidence #13 + §8: keeping umbrellas avoids per-turn LLM round-trip multiplication.

---

## §8 Cross-cutting concerns

### 8.1 Persistence

`ScheduledTask` records persist in their own table (`scheduled_tasks` — to be created; replaces or absorbs aspects of the existing `lifeops_workflows` and reminder tables once migration completes). State transitions write to an append-only log for audit and observability. Default packs are TypeScript-registered (not persisted); user-edited packs persist as overrides keyed by task id.

Other registries are in-memory at runtime; their content comes from three sources:

- **Built-in default packs / contributions** (TypeScript) — registered at plugin init. Not persisted.
- **User customizations** (custom routine templates, custom windows, user-authored workflows, user-authored `ScheduledTask` records) — persisted in existing tables (`lifeops_definitions.metadata`, `lifeops_workflows`, owner profile) plus the new `scheduled_tasks` table.
- **Cloud-distributed packs** — persisted as fetched manifests, registered at boot.

This avoids the "registry is its own god-DB" anti-pattern.

### 8.2 Event vocabulary post-cleanup

The closed `LIFEOPS_EVENT_KINDS` union goes away. Event kinds are namespaced strings:

- `gmail.message.received`, `gmail.thread.needs_response`, `calendar.event.ended` — registered by their connectors.
- `health.sleep.detected`, `health.wake.observed`, `health.bedtime.imminent`, etc. — registered by `plugin-health` (post-extraction).
- `task.fired`, `task.completed`, `task.skipped`, `task.escalated` — registered by the `ScheduledTaskRunner` itself, so other tasks can pipeline on task lifecycle.

A small first-party-vendored list of kinds remains as a literal type for autocomplete (`KnownLifeOpsEventKind`); the runtime contract accepts any registered string.

### 8.3 LLM-tool exposure cost — one runner action vs many

**The question:** does `ScheduledTask` surface as one LLM-visible action (`SCHEDULED_TASK` with subactions `create / list / snooze / complete / pipeline_after / ...`) or as N separate verbs?

**Tradeoff:** N small actions = better planner targeting but more planner-decision latency; one umbrella = simpler planner but the umbrella becomes a `subaction` switchboard. `HARDCODING_AUDIT.md` §6.13 / §8 calls out this tradeoff explicitly.

**Recommendation:** **one umbrella `SCHEDULED_TASK` with subaction-style verbs**, mirroring the existing `LIFE` / `CALENDAR` / `MESSAGE` pattern. Reasons:

- The user mental model is "the agent's reminders / tasks / pipelines" — one mental concept, one umbrella.
- The user-facing planner traffic for `ScheduledTask` is high (every "remind me…" / "check on me…" / "follow up if I don't…" routes here) — keeping it one umbrella avoids per-turn round-trip multiplication on the most common request type.
- Internally the umbrella consults the `ScheduledTaskRunner` registry-style; from outside it is one verb.
- Existing primitives (`SNOOZE`, `COMPLETE`, etc.) map cleanly as similes / subactions of the umbrella.

Compounds (BOOK_TRAVEL, RELEASE_BLOCK, RESOLVE_REQUEST, negotiate_*) stay as their own actions per §7.

### 8.4 Multilingual handling

§3.7 `MultilingualPromptRegistry`. Actions describe themselves in en; localization packs register translations for examples + tags. `ScheduledTask` prompts are in the user's locale (read from `OwnerFactStore.locale`); the runner does not pattern-match prompt content, so a Spanish user asking the agent to "ping me at 4pm" produces a `ScheduledTask` with a Spanish prompt and routes the same as the English version.

### 8.5 Test infrastructure

`prd-coverage.contract.test.ts:156-164` should assert primitive coverage rather than pinned named scenarios:

- Every row in the matrix points to a real test file (existing assertion — keep).
- Every test file in the canonical scenarios directory is referenced by exactly one matrix row.
- The matrix row's `journey-domain` value is one of the 28 domains in `UX_JOURNEYS.md`'s table of contents.
- **(new)** A spine-coverage assertion: at least one test exercises `ScheduledTask` for each of the 28 domains where the matrix says it's the primary primitive.

This locks "every journey is exercised" without locking "exactly N named journeys exist". Decompositions / consolidations stop fighting the test.

### 8.6 Observability

Per the parallel-wave delivery model (`IMPLEMENTATION_PLAN.md` §3 / §5), each registry phase ships a "registry health" endpoint accessible via `GET /api/lifeops/dev/registries` (loopback only). For `ScheduledTask`, also: a per-task lifecycle log surfaced at `GET /api/lifeops/dev/scheduled-tasks/:id/log`.

A user-visible counterpart lifts the dev log to the dashboard: `GET /api/lifeops/scheduled-tasks/:id/history` returns the recent state transitions + their reason strings (e.g. "skipped: weekend_skip gate denied", "fired but not delivered: telegram disconnected"). This addresses the "why didn't this fire?" gap from J9 / J16 / J17.

### 8.7 Priority → notification posture

The three priority levels are distinct user surfaces, not just sort order:

| Priority | Channel default | Banner | Sound | Badge |
|---|---|---|---|---|
| `low` | in_app card | no | no | yes |
| `medium` | in_app + mobile push (if registered) | yes | no | yes |
| `high` | escalation ladder mandatory; falls through channels until ack | yes | yes | yes |

When a task lacks an explicit `escalation`, the runner injects a default ladder based on priority: `low` → no ladder (single attempt); `medium` → 1 retry after 30 min; `high` → 3-step ladder across channels. The check-in default-pack task ships at `medium`; gm/gn ship at `low`.

### 8.8 Quiet hours

Owner facts include `ownerFact.quietHours = { start: "HH:MM", end: "HH:MM", tz: string }`. The `quiet_hours` gate kind reads from this fact; if no value, the gate returns ALLOW (no-op). The runner does NOT pattern-match content against quiet hours — quiet hours are a registered gate, not a hardcoded behavior.

`high`-priority tasks bypass `quiet_hours` by default (the gate registers its own opt-out); `medium` and `low` defer to the next allowed window.

### 8.9 Prompt-content lint pass for default packs

The runtime can't semantically prevent a curator from embedding "if user is Samantha do X" in a `promptInstructions` string. To keep the registry-driven invariant from being violated by content drift:

- Wave 1 ships a lint pass (run during `bun run verify`) that scans default-pack `promptInstructions` for: known PII names (`Jill | Marco | Sarah | Suran | Samantha | …` from `HARDCODING_AUDIT.md` §3), absolute paths, hardcoded ISO times outside owner-fact references, and embedded conditional logic (`if user`, `when X = Y`).
- Findings are warnings in Wave 1; CI-fail in Wave 2 once the false-positive rate is calibrated.
- The lint corpus is open: contributors add new patterns as they're observed.

### 8.10 `pipeline.onSkip` vs `completionCheck.followupAfterMinutes`

Both mechanisms can express "fire something else if no response". They are not redundant:

- `completionCheck.followupAfterMinutes` is the lightweight, single-step retry (gm fires; if no ack in 30 min, fire once more on the same channel). The runner clones the task with a new `pipelineParentId` link and re-fires.
- `pipeline.onSkip[]` is the full pipeline composition (gm fires; on skip, fire a "user is offline check" task; on its skip, fire a "sleeping in?" task).

**Resolution rule:** if both are set, `pipeline.onSkip` wins; the runner ignores `followupAfterMinutes`. This is enforced at validation time and recorded in the state log.

### 8.11 Snooze + escalation interaction

When a user snoozes a task with an active escalation ladder, the ladder **resets to step 0** at the new fire time. Rationale: snooze means "ask me again later" — the user is signaling they will engage at the new time, so starting the ladder over is the lowest-friction posture. Alternative policies (advance-by-elapsed, freeze-at-current-step) optimize for the wrong thing in the common case.

`high`-priority tasks cap snoozes at 3 (configurable in default pack). After the cap, the next fire ignores snooze and goes straight to the final escalation step. This prevents indefinite snooze-into-oblivion for tasks the user explicitly marked urgent.

### 8.12 Late inbound after terminal state (`reopen` semantics)

When a task is `expired` and a correlated inbound message arrives (J5, J6, J17), the runner applies `reopen` automatically if the inbound arrives within `state.lastFollowupAt + 24h`. After 24h, the inbound routes as fresh (the planner does not connect it to the closed task). The 24h window is configurable per-task via `metadata.reopenWindowHours`.

### 8.13 First-run defaults need one wake-time question

Per game-through finding #8: even Path A (defaults) cannot ship a 06:00 gm reminder without first asking "what time do you wake up?" Path A's UX becomes:
1. "Want me to get you set up with defaults?" → user agrees.
2. "What time do you usually wake up?" → user replies (free-text, parsed).
3. Defaults applied with `morningWindow.start` set from the answer.

This adds 1 LLM round-trip to Path A. Worth it.

### 8.14 First-run re-run / disable semantics

Pinned per game-through finding #9:

- **Re-run (`FIRST_RUN.replay`):** keeps existing `ScheduledTask` records intact. Only OwnerFactStore facts that the questions touch are updated. New answers append; previously-answered fields show their current value as "default" for the user to confirm or change. Customizations (user-authored tasks) are never touched.
- **Disable (`LIFEOPS.pause`):** sets `GlobalPauseStore` with no `endIso`. All `respectsGlobalPause` tasks are skipped; no task is deleted. `LIFEOPS.resume` clears the pause.
- **Wipe (`LIFEOPS.wipe`):** explicit destructive action. Confirms ("this will delete N tasks and reset facts — type 'wipe' to confirm"). Then deletes `scheduled_tasks`, clears OwnerFactStore (preserving user identity), and re-runs first-run.

### 8.15 Channel availability validation at customize time

Per game-through finding 9.4: when first-run customize Q4 records a notification channel, the action validates the channel is registered in `ChannelRegistry` AND has a connected dispatcher. If not, the action either offers to connect now or stores the preference with a warning to the user ("Telegram isn't connected — your reminders will fall back to in-app until you connect").

---

## §9 Risks to capability-fication

For each, mitigation paired in line.

### 9.1 LLM latency when many pipelined `ScheduledTask`s fire
**Risk:** if a "morning routine" expands into 8 tasks fired in series and each consults the LLM for its prompt, latency multiplies and the user feels lag.
**Mitigation:** the `ScheduledTaskRunner` batches sibling pipeline tasks into one LLM context where prompts are independent (the prompts are data; the runner can render them in one assembled message and let the LLM walk through them in order). Pipelines that depend on prior outcomes (`onComplete` / `onSkip`) wait for the gate to settle but the gate evaluation is in-process, not LLM-call-per-step. Concretely: `pipeline.onComplete` cascades by re-triggering the runner with the next task; the runner's "fire" path is in-process bookkeeping, not an LLM round-trip per task.

### 9.2 Observability when "everything is just a task"
**Risk:** debugging "why didn't the user get the gm reminder" becomes hard if `ScheduledTask` is opaque.
**Mitigation:** every `ScheduledTask` gets (a) an append-only state log, (b) a `source` field (default_pack / user_chat / first_run / plugin) so the operator can trace where the task came from, (c) a `dev/scheduled-tasks/:id/log` endpoint, and (d) explicit gate / completion-check / escalation evaluations recorded with the task id. The runner emits structured log lines on every state transition.

### 9.3 Default-pack curation work to keep agent feeling alive on day one
**Risk:** if the default packs are weak, a fresh user opens LifeOps and sees nothing; the entire "agent is alive" feeling depends on default packs being good. This work is non-trivial and is its own deliverable (it's an open question — see `IMPLEMENTATION_PLAN.md` §8).
**Mitigation:** treat the default-pack curation as a real Wave-1 deliverable with its own owner. Wave-1 ships at least: the daily check-in starter, gm/gn starters, the morning-brief starter, and the 8 habit starters (offered, not auto-seeded). Validate with a usability pass (the user, a friend, or both) before Wave 2.

### 9.4 Contract test relaxation impact
**Risk:** relaxing `prd-coverage.contract.test.ts` could let coverage shrink unnoticed.
**Mitigation:** the relaxed assertion still requires every matrix row to have a real test file and every test file to be referenced by exactly one matrix row. Add a weekly diff-of-matrix report so removed rows surface in review. Per §8.5 the new spine-coverage assertion adds positive coverage of the spine.

### 9.5 Spine-collapse temptation: stuffing non-task concerns into `ScheduledTask`
**Risk:** "everything is a task" tempts contributors to mash one-off logic (e.g. a complex multi-party negotiation) into a `ScheduledTask` instead of treating it as a compound action.
**Mitigation:** §7 (What is NOT a gap) is the protected list. PR review flags any `ScheduledTask` whose `promptInstructions` is more than ~500 chars or whose pipeline branches more than 3 levels deep — that's a sign it should be a compound action.

### 9.6 The "rename PII" trap
**Risk:** `HARDCODING_AUDIT.md` §3 PII appears in source, fixtures, catalogs, test imports, and `coverage-matrix.md`. Rename in the wrong order and CI breaks for hours.
**Mitigation:** atomic per-file renames; test-imports updated in same commit. (`IMPLEMENTATION_PLAN.md` §2 carries this as pre-wave hygiene.)

### 9.7 Sleep-extraction blast radius
**Risk:** `plugin-health` extraction touches ~100 file imports of sleep types from `packages/shared/src/contracts/lifeops.ts`.
**Mitigation:** the extraction is **atomic in Wave 1**, not phased. A single wave with parallel sub-agents touching disjoint surfaces, integration gate at end. No re-export "for one release cycle" dance — the verification gate is "everything still typechecks and tests pass." If the gate fails, fix in place rather than punting to a second wave. (Detailed in `IMPLEMENTATION_PLAN.md` §3.)

### 9.8 The "we made it generic but nothing changed" trap
**Risk:** registry-fy 12 things, ship none of the new contributors, and the codebase has more layers but identical behavior.
**Mitigation:** every Wave-1 foundation ships with at least one real contributor beyond the migrated legacy set: `ScheduledTask` ships the daily-check-in default pack (new); `plugin-health` ships its registered connectors and bedtime/wake-up packs (new); first-run ships both paths (new). The registries land with new behavior, not just refactored old behavior.

### 9.9 First-run UX regression
**Risk:** the first-run customize path's question set might be wrong (too many questions → drop-off; too few → empty agent).
**Mitigation:** the recommended 5-question set in §5.3 is a starting point; treat it as a default-pack-curation open question alongside the default-pack contents themselves. Run the path with at least one real user before Wave-2 e2e tests lock the question set in.

### 9.10 Discoverability of pure primitives
**Risk:** "what can you do?" becomes harder to answer when everything is "a task".
**Mitigation:** first-run (§5) is the structural answer — every fresh user is offered defaults or customize. Settings UI lists features pulled from `FeatureFlagRegistry`. Settings → "My scheduled tasks" lists the user's `ScheduledTask` records by source so they can see what the agent is currently doing.

---

*End of gap assessment. See `IMPLEMENTATION_PLAN.md` for the two-wave parallel-agent delivery plan.*
