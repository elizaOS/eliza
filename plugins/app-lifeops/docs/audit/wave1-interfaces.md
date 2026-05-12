# Wave 1 — Interface Contract

**Companion to:** `IMPLEMENTATION_PLAN.md`, `GAP_ASSESSMENT.md`.

**Purpose:** the interface contract every Wave-1 agent (W1-A through W1-G) builds against. Frozen on day 1 of Wave 1; subsequent changes only via the integration gate. Cross-agent integration breaks if anyone diverges from these signatures.

**Wave-1 agent map:**
- **W1-A** — `ScheduledTask` spine
- **W1-B** — `plugin-health` extraction
- **W1-C** — first-run + `PendingPromptsProvider` + `RecentTaskStatesProvider` + `GlobalPauseStore`
- **W1-D** — default-pack curation + consolidation policies + prompt-content lint
- **W1-E** — ENTITY + RELATIONSHIP knowledge-graph (`EntityStore` + `RelationshipStore`)
- **W1-F** — connector + channel + transport contract (this doc is W1-F's first deliverable)
- **W1-G** — repo hygiene + `lifeops-samantha` rename + non-action helper relocation

---

## §1 W1-A — `ScheduledTask` core types and runner

Source of truth: `GAP_ASSESSMENT.md` §2.3. Reproduced here for stability.

### 1.1 `ScheduledTask` schema (frozen)

```ts
export type TerminalState = "completed" | "skipped" | "expired" | "failed" | "dismissed";

export type ScheduledTaskStatus = TerminalState | "scheduled" | "fired" | "acknowledged";

export interface ScheduledTask {
  taskId: string;
  kind: "reminder" | "checkin" | "followup" | "approval" | "recap" | "watcher" | "output" | "custom";
  promptInstructions: string;
  contextRequest?: {
    includeOwnerFacts?: ("preferredName" | "timezone" | "morningWindow" | "eveningWindow" | "locale")[];
    includeEntities?: { entityIds: string[]; fields?: ("preferredName" | "type" | "identities" | "state.lastInteractionPlatform")[] };
    includeRelationships?: { relationshipIds?: string[]; forEntityIds?: string[]; types?: string[] };
    includeRecentTaskStates?: { kind?: ScheduledTask["kind"]; lookbackHours?: number };
    includeEventPayload?: boolean;
  };
  trigger:
    | { kind: "once"; atIso: string }
    | { kind: "cron"; expression: string; tz: string }
    | { kind: "interval"; everyMinutes: number; from?: string; until?: string }
    | { kind: "relative_to_anchor"; anchorKey: string; offsetMinutes: number }
    | { kind: "during_window"; windowKey: string }
    | { kind: "event"; eventKind: string; filter?: EventFilter }
    | { kind: "manual" }
    | { kind: "after_task"; taskId: string; outcome: TerminalState };
  priority: "low" | "medium" | "high";
  shouldFire?: {
    compose?: "all" | "any" | "first_deny";
    gates: Array<{ kind: string; params?: GateParams }>;
  };
  completionCheck?: {
    kind: string;
    params?: CompletionCheckParams;
    followupAfterMinutes?: number;
  };
  escalation?: { ladderKey?: string; steps?: EscalationStep[] };
  output?: {
    destination: "in_app_card" | "channel" | "apple_notes" | "gmail_draft" | "memory";
    target?: string;
    persistAs?: "task_metadata" | "external_only";
  };
  pipeline?: {
    onComplete?: ScheduledTaskRef[];
    onSkip?: ScheduledTaskRef[];
    onFail?: ScheduledTaskRef[];
  };
  subject?: {
    kind: "entity" | "relationship" | "thread" | "document" | "calendar_event" | "self";
    id: string;
  };
  idempotencyKey?: string;
  respectsGlobalPause: boolean;
  state: ScheduledTaskState;
  source: "default_pack" | "user_chat" | "first_run" | "plugin";
  createdBy: string;
  ownerVisible: boolean;
  metadata?: Record<string, unknown>;
}

export interface ScheduledTaskState {
  status: ScheduledTaskStatus;
  firedAt?: string;
  acknowledgedAt?: string;
  completedAt?: string;
  followupCount: number;
  lastFollowupAt?: string;
  pipelineParentId?: string;
  lastDecisionLog?: string;
}

export type ScheduledTaskRef = string | ScheduledTask;
export type EventFilter = unknown;       // typed via EventKindRegistry per kind
export type GateParams = unknown;        // typed via TaskGateRegistry per kind
export type CompletionCheckParams = unknown;  // typed via CompletionCheckRegistry per kind
export interface EscalationStep {
  delayMinutes: number;
  channelKey: string;
  intensity?: "soft" | "normal" | "urgent";
}
```

### 1.2 Runner verbs (frozen)

```ts
export type ScheduledTaskVerb =
  | "snooze" | "skip" | "complete" | "dismiss" | "escalate" | "acknowledge" | "edit" | "reopen";

export interface ScheduledTaskRunner {
  schedule(task: Omit<ScheduledTask, "taskId" | "state">): Promise<ScheduledTask>;
  list(filter?: ScheduledTaskFilter): Promise<ScheduledTask[]>;
  apply(taskId: string, verb: ScheduledTaskVerb, payload?: unknown): Promise<ScheduledTask>;
  pipeline(taskId: string, outcome: TerminalState): Promise<ScheduledTask[]>;
}

export interface ScheduledTaskFilter {
  kind?: ScheduledTask["kind"];
  status?: ScheduledTaskStatus | ScheduledTaskStatus[];
  subject?: ScheduledTask["subject"];
  source?: ScheduledTask["source"];
  firedSince?: string;
  ownerVisibleOnly?: boolean;
}
```

### 1.3 Gate / completion-check registries (frozen)

```ts
export type GateDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "defer"; until: { offsetMinutes: number } | { atIso: string }; reason: string };

export interface TaskGateContribution {
  kind: string;       // namespaced: "weekend_skip", "stretch.walk_out_reset", …
  paramsSchema?: unknown;   // optional Zod / JSONSchema for params validation
  evaluate(task: ScheduledTask, context: GateEvaluationContext): GateDecision | Promise<GateDecision>;
}

export interface CompletionCheckContribution {
  kind: string;
  paramsSchema?: unknown;
  shouldComplete(task: ScheduledTask, context: CompletionCheckContext): boolean | Promise<boolean>;
}
```

`GateEvaluationContext` and `CompletionCheckContext` are W1-A-defined; they expose owner facts, current time, recent activity, and access to `EntityStore` / `RelationshipStore` / `ActivitySignalBus` via injected handles.

### 1.4 Anchor + consolidation registries (frozen)

```ts
export interface AnchorContribution {
  anchorKey: string;       // "wake.observed", "wake.confirmed", "bedtime.target", "meeting.ended", …
  describe: { label: string; provider: string };
  resolve(context: AnchorContext): { atIso: string } | null | Promise<{ atIso: string } | null>;
}

export interface AnchorConsolidationPolicy {
  anchorKey: string;
  mode: "merge" | "sequential" | "parallel";
  staggerMinutes?: number;
  maxBatchSize?: number;
  sortBy?: "priority_desc" | "fired_at_asc";
}
```

### 1.5 Snooze / escalation policy (frozen)

- Snooze **resets** the ladder to step 0 at the new fire time.
- Default ladders by priority (when `escalation` is undefined): `low` = no ladder; `medium` = 1 retry @ 30 min; `high` = 3-step cross-channel.
- `acknowledged` is non-terminal; `pipeline.onComplete` only fires on `completed`.
- `reopen` window default: 24h after `lastFollowupAt`. Configurable via `metadata.reopenWindowHours`.

### 1.6 REST surface (frozen)

```
GET    /api/lifeops/scheduled-tasks                              list
POST   /api/lifeops/scheduled-tasks                              schedule
POST   /api/lifeops/scheduled-tasks/:id/snooze                   apply snooze
POST   /api/lifeops/scheduled-tasks/:id/skip                     apply skip
POST   /api/lifeops/scheduled-tasks/:id/complete                 apply complete
POST   /api/lifeops/scheduled-tasks/:id/dismiss                  apply dismiss
POST   /api/lifeops/scheduled-tasks/:id/escalate                 apply escalate
POST   /api/lifeops/scheduled-tasks/:id/acknowledge              apply acknowledge
POST   /api/lifeops/scheduled-tasks/:id/reopen                   apply reopen
POST   /api/lifeops/scheduled-tasks/:id/edit                     apply edit
GET    /api/lifeops/scheduled-tasks/:id/history                  user-visible history
GET    /api/lifeops/dev/scheduled-tasks/:id/log                  dev log (loopback)
GET    /api/lifeops/dev/registries                               registry health (loopback)
```

---

## §2 W1-E — ENTITY + RELATIONSHIP

Source of truth: `GAP_ASSESSMENT.md` §3.4.

### 2.1 `Entity` (frozen)

```ts
export interface Entity {
  entityId: string;
  type: string;     // "person" | "organization" | "place" | "project" | "concept" | …
  preferredName: string;
  fullName?: string;
  identities: EntityIdentity[];
  attributes?: Record<string, EntityAttribute>;
  state: EntityState;
  tags: string[];
  visibility: "owner_only" | "agent_and_admin" | "owner_agent_admin";
  createdAt: string;
  updatedAt: string;
}

export interface EntityIdentity {
  platform: string;
  handle: string;
  displayName?: string;
  verified: boolean;
  confidence: number;
  addedAt: string;
  addedVia: "user_chat" | "merge" | "platform_observation" | "extraction" | "import";
  evidence: string[];
}

export interface EntityAttribute {
  value: unknown;
  confidence: number;
  evidence: string[];
  updatedAt: string;
}

export interface EntityState {
  lastObservedAt?: string;
  lastInboundAt?: string;
  lastOutboundAt?: string;
  lastInteractionPlatform?: string;
}
```

### 2.2 `Relationship` (frozen)

```ts
export interface Relationship {
  relationshipId: string;
  fromEntityId: string;
  toEntityId: string;
  type: string;          // "follows" | "colleague_of" | "manages" | "works_at" | …
  metadata?: Record<string, unknown>;   // typed per-type via RelationshipTypeRegistry
  state: RelationshipState;
  evidence: string[];
  confidence: number;
  source: "user_chat" | "platform_observation" | "extraction" | "import" | "system";
  createdAt: string;
  updatedAt: string;
}

export interface RelationshipState {
  lastObservedAt?: string;
  lastInteractionAt?: string;
  interactionCount?: number;
  sentimentTrend?: "positive" | "neutral" | "negative";
}
```

### 2.3 Stores (frozen)

```ts
export interface EntityStore {
  upsert(input: Omit<Entity, "entityId" | "createdAt" | "updatedAt"> & { entityId?: string }): Promise<Entity>;
  get(entityId: string): Promise<Entity | null>;
  list(filter?: EntityFilter): Promise<Entity[]>;
  observeIdentity(obs: { platform: string; handle: string; displayName?: string; evidence: string[]; confidence: number; suggestedType?: string }): Promise<{ entity: Entity; mergedFrom?: string[] }>;
  resolve(query: { name?: string; identity?: { platform: string; handle: string }; type?: string }): Promise<EntityResolveCandidate[]>;
  recordInteraction(entityId: string, interaction: { platform: string; direction: "inbound" | "outbound"; summary: string; occurredAt: string }): Promise<void>;
  merge(targetId: string, sourceIds: string[]): Promise<Entity>;
}

export interface EntityResolveCandidate {
  entity: Entity;
  confidence: number;
  evidence: string[];
  safeToSend: boolean;
}

export interface RelationshipStore {
  upsert(input: Omit<Relationship, "relationshipId" | "createdAt" | "updatedAt"> & { relationshipId?: string }): Promise<Relationship>;
  get(relationshipId: string): Promise<Relationship | null>;
  list(filter?: RelationshipFilter): Promise<Relationship[]>;
  observe(obs: { fromEntityId: string; toEntityId: string; type: string; metadataPatch?: Record<string, unknown>; evidence: string[]; confidence: number }): Promise<Relationship>;
  retire(relationshipId: string, reason: string): Promise<void>;
}

export interface RelationshipFilter {
  fromEntityId?: string;
  toEntityId?: string;
  type?: string | string[];
  metadataMatch?: Record<string, unknown>;
  cadenceOverdueAsOf?: string;    // returns edges where metadata.cadenceDays exists AND state.lastInteractionAt < (asOf - cadenceDays)
}
```

### 2.4 REST surface (frozen)

```
GET    /api/lifeops/entities                                     list
POST   /api/lifeops/entities                                     upsert
PATCH  /api/lifeops/entities/:id                                 patch
POST   /api/lifeops/entities/:id/identities                      observeIdentity
POST   /api/lifeops/entities/merge                               explicit merge
GET    /api/lifeops/entities/resolve?q=                          resolve (query)

GET    /api/lifeops/relationships                                list
POST   /api/lifeops/relationships                                upsert
PATCH  /api/lifeops/relationships/:id                            patch
POST   /api/lifeops/relationships/observe                        observe (extraction-time)
POST   /api/lifeops/relationships/:id/retire                     retire
```

---

## §3 W1-F — Connector / Channel / Transport contracts

### 3.1 `ConnectorContribution` (frozen)

```ts
export type ConnectorMode = "local" | "cloud";

export interface ConnectorStatus {
  state: "ok" | "degraded" | "disconnected";
  message?: string;
  observedAt: string;
}

export type DispatchResult =
  | { ok: true; messageId?: string }
  | { ok: false; reason: "disconnected" | "rate_limited" | "auth_expired" | "unknown_recipient" | "transport_error"; retryAfterMinutes?: number; userActionable: boolean; message?: string };

export interface ConnectorContribution {
  kind: string;                    // "google", "telegram", "discord", "apple_health", …
  capabilities: string[];          // namespaced: "google.calendar.read", "telegram.send", …
  modes: ConnectorMode[];
  describe: { label: string };
  start(): Promise<void>;
  disconnect(): Promise<void>;
  verify(): Promise<boolean>;
  status(): Promise<ConnectorStatus>;
  send?(payload: unknown): Promise<DispatchResult>;
  read?(query: unknown): Promise<unknown>;
  requiresApproval?: boolean;      // Gmail sets true → owner-send-policy gate fires
}

export interface ConnectorRegistry {
  register(c: ConnectorContribution): void;
  list(filter?: { capability?: string; mode?: ConnectorMode }): ConnectorContribution[];
  get(kind: string): ConnectorContribution | null;
  byCapability(capability: string): ConnectorContribution[];
}
```

### 3.2 `ChannelContribution` (frozen)

```ts
export interface ChannelContribution {
  kind: string;                    // "in_app", "push", "imessage", "telegram", …
  describe: { label: string };
  capabilities: {
    send: boolean;
    read: boolean;
    reminders: boolean;
    voice: boolean;
    attachments: boolean;
    quietHoursAware: boolean;
  };
  send?(payload: unknown): Promise<DispatchResult>;
}

export interface ChannelRegistry {
  register(c: ChannelContribution): void;
  list(filter?: { supports?: Partial<ChannelContribution["capabilities"]> }): ChannelContribution[];
  get(kind: string): ChannelContribution | null;
}
```

### 3.3 Priority-to-posture map (frozen)

```ts
export const PRIORITY_TO_POSTURE = {
  low:    { defaultChannelKeys: ["in_app"],            banner: false, sound: false, badge: true,  mandatoryEscalation: false },
  medium: { defaultChannelKeys: ["in_app", "push"],    banner: true,  sound: false, badge: true,  mandatoryEscalation: false },
  high:   { defaultChannelKeys: ["in_app", "push"],    banner: true,  sound: true,  badge: true,  mandatoryEscalation: true },
} as const;
```

### 3.4 Default escalation ladders (frozen)

```ts
export const DEFAULT_ESCALATION_LADDERS = {
  priority_low_default:    { steps: [] },
  priority_medium_default: { steps: [{ delayMinutes: 30, channelKey: "in_app", intensity: "normal" }] },
  priority_high_default:   { steps: [
    { delayMinutes: 0,  channelKey: "in_app",   intensity: "soft" },
    { delayMinutes: 15, channelKey: "push",     intensity: "normal" },
    { delayMinutes: 45, channelKey: "imessage", intensity: "urgent" },
  ]},
};
```

---

## §4 W1-C — First-run + providers + global pause

### 4.1 First-run affordance (frozen)

```ts
export interface FirstRunAffordance {
  kind: "first_run_pending";
  oneLine: string;            // shown to planner ≤ 120 chars
  suggestedActionKey: "FIRST_RUN";
  paths: ("defaults" | "customize")[];
}
```

### 4.2 First-run action signature (frozen)

```ts
export type FirstRunPath = "defaults" | "customize" | "replay";
export interface FirstRunActionInput {
  path: FirstRunPath;
  partialAnswers?: Record<string, unknown>;   // for resume from abandon
}
```

Defaults path asks one wake-time question before scheduling gm.

### 4.3 `PendingPromptsProvider` (frozen)

```ts
export interface PendingPromptsProvider {
  list(roomId: string, opts?: { lookbackMinutes?: number }): Promise<PendingPrompt[]>;
}

export interface PendingPrompt {
  taskId: string;
  promptSnippet: string;
  firedAt: string;
  expectedReplyKind: "any" | "yes_no" | "approval" | "free_form";
  expiresAt?: string;
}
```

Open prompts retained for the `reopen` window (24h) past `expiresAt`.

### 4.4 `RecentTaskStatesProvider` (frozen)

```ts
export interface RecentTaskStatesProvider {
  summarize(opts?: {
    kinds?: ScheduledTask["kind"][];
    subjectIds?: string[];
    lookbackDays?: number;
  }): Promise<RecentTaskStatesSummary>;
}

export interface RecentTaskStatesSummary {
  summary: string;
  streaks: Array<{ kind: ScheduledTask["kind"]; outcome: TerminalState; consecutive: number }>;
  notable: Array<{ taskId: string; observation: string }>;
}
```

### 4.5 `GlobalPauseStore` (frozen)

```ts
export interface GlobalPauseStore {
  set(window: { startIso: string; endIso?: string; reason?: string }): Promise<void>;
  clear(): Promise<void>;
  current(): Promise<{ active: boolean; startIso?: string; endIso?: string; reason?: string }>;
}
```

The runner consults `current()` pre-fire; tasks with `respectsGlobalPause: true` skip with reason `global_pause`.

---

## §5 W1-B — `plugin-health` contributions

`plugin-health` registers through W1-F's contracts. Specifically:

### 5.1 Connectors registered

`apple_health`, `google_fit`, `strava`, `fitbit`, `withings`, `oura` — each as `ConnectorContribution`.

### 5.2 Anchors registered

```ts
export const HEALTH_ANCHORS = ["wake.observed", "wake.confirmed", "bedtime.target", "nap.start"] as const;
```

### 5.3 Bus families registered

`health.sleep.detected`, `health.sleep.ended`, `health.wake.observed`, `health.wake.confirmed`, `health.nap.detected`, `health.bedtime.imminent`, `health.regularity.changed`, `health.workout.completed`.

### 5.4 Default packs

`bedtime`, `wake-up`, `sleep-recap` — `ScheduledTask` records consuming the W1-A schema.

---

## §6 W1-D — Default packs

Default packs ship via the registration entry point W1-A exposes. Each pack declares `ScheduledTask` records + (optionally) anchor-consolidation policies.

### 6.1 Wave-1 packs to ship

- `daily-rhythm` — gm, gn, daily check-in (`kind: "checkin"`, `priority: "medium"`, `completionCheck.kind: "user_replied_within"`).
- `morning-brief` — assembler triggered on `wake.confirmed`.
- `quiet-user-watcher` — daily watcher reading `RecentTaskStatesProvider.summarize`.
- `habit-starters` — 8 habits, **offered** (not auto-seeded). Stretch uses multi-gate composition.
- `inbox-triage-starter` — opt-in; gates on Gmail connector.
- `followup-starter` — watcher reading `RelationshipStore.list({ cadenceOverdueAsOf: now })` and creating child followup `ScheduledTask`s with `subject = { kind: "relationship", id }`.

### 6.2 Consolidation policies

- `wake.confirmed` — `{ mode: "merge", sortBy: "priority_desc" }`.
- `bedtime.target` — `{ mode: "sequential", staggerMinutes: 5 }`.

### 6.3 Lint pass

Wave 1 ships `scripts/lint-default-packs.mjs` as warning-only. Promoted to CI-fail in Wave 3 (W3-B).

---

## §7 Cross-agent invariants

1. **The runner never pattern-matches `promptInstructions` content.** Behavior is driven by `kind`, `trigger`, `gates`, `completionCheck`, `pipeline`, `output`, `subject`, `priority`, `respectsGlobalPause` — not by the prompt string.
2. **`subject.kind = "relationship"` for cadence-bearing tasks; `subject.kind = "entity"` for "everything about Pat" lists.** Cadence lives on the edge.
3. **Identities are observed, not assigned.** New (platform, handle) pairs go through `observeIdentity`; the merge engine collapses entities.
4. **Connectors return `DispatchResult`; channels also.** Pre-Wave-1 free-form `boolean` returns are the legacy shape; Wave-2 W2-B normalizes.
5. **`shouldFire` is always an array.** Single-gate cases write `[{ kind, params }]`.
6. **`acknowledged` ≠ `completed`.** Pipeline `onComplete` only fires on `completed`.
7. **Snooze resets ladder.** Documented explicitly; no per-task variance.
8. **Global pause skips tasks with `respectsGlobalPause: true`.** Default true; emergency tasks flip it false explicitly.

---

## §8 Stub vs production

Some Wave-1 deliverables ship as **stubs** with the caller-side interface stable; the production implementation lands in Wave 2.

| Surface | Wave 1 | Wave 2 |
|---|---|---|
| `OwnerFactStore` | Interim wrapper around `LifeOpsOwnerProfile` (W1-C uses) | Full generalization (W2-E) |
| `ContactResolver` | Backward-compat shim over `EntityStore.resolve` (W1-E ships) | Shim deleted (W2-D) |
| `ChannelRegistry` (populated) | Empty / minimal (W1-F ships contracts only) | Populated by 12 connector contributions (W2-B) |
| Telemetry-family union | Open temporarily | Closed via `FamilyRegistry` (W2-D) |

Agents do not call across stub boundaries with assumptions about post-stub behavior; tests assert behavior at the documented stub boundary.

---

*End of wave 1 interface contract. Frozen on day 1 of Wave 1; updates only via integration gate.*
