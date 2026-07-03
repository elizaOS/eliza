# `@elizaos/plugin-personal-assistant`

LifeOps is the elizaOS app that runs the user's day: routines, goals,
calendar, email, messaging, follow-ups with people, blockers, watchers, and
the operational glue around them. This README is the architecture summary
for contributors.

## Scheduled items, not generic tasks

Every reminder, check-in, follow-up, watcher, recap, approval surface, and
nag-the-user-when-they-go-quiet flow is a **LifeOps scheduled item** stored
as a `ScheduledTask` record and owned by the runner at
`plugins/plugin-scheduling/src/scheduled-task/runner.ts` (the personal-assistant
side wires it in via `src/lifeops/scheduled-task/{service,scheduler,runtime-wiring}.ts`).
There is no second LifeOps scheduling mechanism.

`ScheduledTask` is intentionally not the repository-wide "task" primitive.
Core runtime tasks are persisted `Task` rows handled by `TaskService`; coding
agent work is orchestrator/task-coordinator state; project and feature tasks
may have their own plugin-owned records. LifeOps integrates with those
surfaces through public plugin/runtime contracts instead of importing or
owning them as LifeOps primitives.

The shape:

```ts
interface ScheduledTask {
  taskId: string;
  kind: "reminder" | "checkin" | "followup" | "approval" | "recap" | "watcher" | "output" | "custom";
  promptInstructions: string;
  contextRequest?: { /* owner facts, entities, relationships, recent task states, event payload */ };
  trigger: /* once | cron | interval | relative_to_anchor | during_window | event | manual | after_task */;
  priority: "low" | "medium" | "high";
  shouldFire?: { compose: "all" | "any" | "first_deny"; gates: Array<{ kind: string; params? }> };
  completionCheck?: { kind: string; params?: ...; followupAfterMinutes? };
  escalation?: { ladderKey?: string; steps?: EscalationStep[] };
  output?: { destination: ...; target?: string; persistAs?: ... };
  pipeline?: { onComplete?, onSkip?, onFail? };
  subject?: { kind: "entity" | "relationship" | "thread" | "document" | "calendar_event" | "self"; id: string };
  idempotencyKey?: string;
  respectsGlobalPause: boolean;
  state: ScheduledTaskState;
  source: "default_pack" | "user_chat" | "first_run" | "plugin";
  createdBy: string;
  ownerVisible: boolean;
  metadata?: Record<string, unknown>;
}
```

The runner pattern-matches **only** on the structural fields above
(`kind`, `trigger`, `shouldFire`, `completionCheck`, `pipeline`, `output`,
`subject`, `priority`, `respectsGlobalPause`). It never inspects
`promptInstructions` content. This is non-negotiable.

The frozen contract is defined in `src/lifeops/scheduled-task/types.ts`
(the runner imports `ScheduledTask` from there). `src/lifeops/wave1-types.ts`
is a slightly diverged copy consumed only by the `first-run` module.

### No-reply semantics

Completion timeouts are structural scheduler behavior, not prompt text. For
scheduled items that wait on a user reply, personal-assistant resolves a
persisted no-reply contract from `metadata.noReplyPolicy` plus
`metadata.noReplyState` and applies it in the single scheduler timeout pass:

```ts
metadata: {
  noReplyPolicy?: {
    maxRetries: number;
    retryCadenceMinutes: number[];
    terminalStatus: "skipped" | "expired" | "failed";
    terminalReason: string;
    sensitive: boolean;
    allowCrossChannel: boolean;
    allowNonOwnerNotification: boolean;
  };
  noReplyState?: {
    retryCount: number;
    lastTimedOutAt?: string;
    nextRetryAt?: string;
    terminalReason?: string;
    terminalOutcome?: "skipped" | "expired" | "failed" | "denied";
  };
}
```

Defaults are deliberately conservative:

- reminders retry once after 60 minutes, then `skipped`;
- check-ins retry once after 24 hours, then `expired`;
- non-sensitive approvals retry after 30 minutes and 2 hours, then `expired`;
- sensitive approvals retry once after 30 minutes, then expire with
  `terminalOutcome: "denied"`;
- cross-channel escalation and non-owner notification default to `false`.

No no-reply path may auto-execute a sensitive output. Silence on money, data,
or external-send approvals fails closed. No-reply expiry is not a user skip, so
approval expiry does not fire `pipeline.onSkip`; authored skip pipelines remain
reserved for explicit skip transitions.

## Runtime layout

```
src/lifeops/
  scheduled-task/        Spine: runner, state log, gate registry,
                         completion-check registry, escalation, runtime
                         wiring.
  entities/              Entity primitive: store, merge engine, types.
  relationships/         Relationship edges: store, observation
                         extraction, types.
  registries/            AnchorRegistry, EventKindRegistry, FamilyRegistry,
                         BlockerRegistry, app/website blocker contributions.
  signals/               ActivitySignalBus.
  channels/              ChannelRegistry, priority-posture map, default
                         channel pack.
  connectors/            ConnectorRegistry + per-connector contributions
                         (calendly, discord, duffel, google, imessage,
                         signal, telegram, twilio, whatsapp, x).
  send-policy/           Per-connector send-policy contract + registry.
  owner/                 OwnerFactStore.
  first-run/             FirstRunService, state store, customize
                         questions, replay.
  pending-prompts/       PendingPromptsStore (the planner-visible
                         "questions waiting for the user" surface).
  global-pause/          GlobalPauseStore.
  handoff/               HandoffStore (per-room handoff state).
  i18n/                  MultilingualPromptRegistry.
  graph-migration/       Migration into the entity/relationship graph.
  seed-routine-migration/  Migration off legacy seed routines.
  ...other LifeOps-owned helpers (calendar, email, messaging, payments,
                                  subscriptions, assistant workflows, etc.)
```

## Default packs

Default packs are bundles of typed scheduled-item definitions compiled into
`ScheduledTask` records (and sometimes anchor-consolidation policies,
escalation ladders, autofill whitelists). LifeOps-owned packs live in
`src/default-packs/`:

- `daily-rhythm` — gm, gn, daily check-in.
- `morning-brief` — fired on `wake.confirmed`.
- `quiet-user-watcher` — daily watcher.
- `habit-starters` — eight habits, **offered** (not auto-seeded).
- `executive-assistant` — twenty-five scheduled records covering twenty
  personal/executive assistant scenario families, **offered** (not auto-seeded).
- `inbox-triage-starter` — opt-in, gated on Gmail.
- `followup-starter` — watcher firing per overdue relationship.
- `autofill-whitelist-pack`, `consolidation-policies`, `escalation-ladders`
  — policy-only packs.

`@elizaos/plugin-health` ships `bedtime`, `wake-up`, `sleep-recap` and
registers them when a health connector pairs.

### Adding a new default pack

1. Add a file under `src/default-packs/<name>.ts` that exports a
   `DefaultPack` matching `registry-types.ts`.
2. Define `ReminderTaskDefinition`, `CheckInTaskDefinition`,
   `WatcherTaskDefinition`, `ApprovalTaskDefinition`, `RecapTaskDefinition`,
   or `OutputTaskDefinition` values and compile them with
   `compileTaskDefinition` / `compileTaskDefinitions`. Pack files should not
   construct raw `ScheduledTaskSeed` records.
3. Import and append it to `DEFAULT_PACKS` in `src/default-packs/index.ts`.
4. If the pack should be **auto-enabled**, list it in
   `getDefaultEnabledPacks`. If it should be **offered** during first-run
   customize, list it in `getOfferedDefaultPacks`. If neither, the pack
   only seeds when invoked explicitly.
5. Run `bun run lint:default-packs` (also runs as `pretest`). The lint
   rules are embedded in `scripts/lint-default-packs.mjs`. CI rejects packs
   that violate them, including raw `ScheduledTask` construction.
6. Add a record-id constant export so consumers can target the records by
   stable ID.

The runtime never seeds packs by name string-match; everything goes through
`getAllDefaultPacks()`.

## Knowledge graph

`EntityStore` (nodes) and `RelationshipStore` (edges) at
`src/lifeops/entities/` and `src/lifeops/relationships/`. The graph is
per-agent. The `entityId === "self"` row is bootstrapped on first use.

- **Cadence lives on the edge.** "Pat — every 14 days" is a
  `Relationship`, not an `Entity` attribute. Cadence-bearing
  `ScheduledTask`s use `subject.kind = "relationship"`.
- **Identities are observed.** `(platform, handle)` pairs route through
  `observeIdentity`; the merge engine in `entities/merge.ts` collapses
  entities with high-confidence identity matches. Manual merges go through
  `POST /api/lifeops/entities/merge` and are audited.
- **REST surface** — routes live in `src/routes/`.

## Pause and handoff

- **Global pause** (`global-pause/store.ts`) — stops every
  `ScheduledTask` with `respectsGlobalPause: true`. Toggleable via UI or
  `/api/lifeops/app-state`.
- **Per-room handoff** (`handoff/store.ts`) — flips a multi-party room
  into handoff after the agent says "I'll let you take it from here."
  Typed resume conditions (`mention | explicit_resume | silence_minutes |
  user_request_help`). The `RoomPolicyProvider` reads
  `HandoffStore.status(roomId).active` and gates further agent
  contributions.

## Plugin dependencies

LifeOps consumes `@elizaos/plugin-health` for sleep/circadian/health metrics,
screen-time action planning, health action planning, health-context formatting,
and health connector contributions.
The plugin contributes through the registries listed above (`AnchorRegistry`,
`ConnectorRegistry`, `FamilyRegistry`, default packs) and public factories such
as `createHealthActionRunner`, `createScreenTimeActionRunner`, and
`createHealthProvider`. LifeOps does not import directly into the health
internals; it consumes the plugin's public exports only. See
`plugins/plugin-health/README.md`.

## Cross-agent invariants

1. The runner never pattern-matches `promptInstructions`.
2. `subject.kind = "relationship"` for cadence-bearing tasks.
3. Identities are observed, not assigned.
4. Connectors and channels return typed `DispatchResult`. No `boolean`.
5. `shouldFire.gates` is always an array.
6. `acknowledged` ≠ `completed`. Pipeline `onComplete` only fires on
   `completed`.
7. Snooze resets the escalation ladder.
8. Global pause skips tasks with `respectsGlobalPause: true`.

## Where to look next

- Frozen interface types: `src/lifeops/scheduled-task/types.ts`.
- Prompt-content lint rules: `scripts/lint-default-packs.mjs`.
- Health domain: `plugins/plugin-health/README.md`.
- REST routes: `src/routes/`.
