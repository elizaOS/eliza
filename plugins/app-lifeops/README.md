# `@elizaos/app-lifeops`

LifeOps is the elizaOS app that runs the user's day: routines, goals,
calendar, email, messaging, follow-ups with people, blockers, watchers, and
the operational glue around them. This README is the architecture summary
for contributors. User-facing docs live in `docs/user/lifeops-setup.mdx`;
the QA reference lives in `docs/launchdocs/14-lifeops-qa.md`; the REST
contract lives in `docs/rest/lifeops.md`.

## The single primitive

Every reminder, check-in, follow-up, watcher, recap, approval surface, and
nag-the-user-when-they-go-quiet flow is a **`ScheduledTask`** owned by the
runner at `src/lifeops/scheduled-task/runner.ts`. There is no second
mechanism. If LifeOps does it, it is a `ScheduledTask`.

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

The frozen contract lives in `docs/audit/wave1-interfaces.md` §1.

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
  ...other domain helpers (calendar, email, messaging, payments,
                          subscriptions, sleep, screen-time, etc.)
```

## Default packs

Default packs are bundles of `ScheduledTask` records (and sometimes
anchor-consolidation policies, escalation ladders, autofill whitelists).
LifeOps-owned packs live in `src/default-packs/`:

- `daily-rhythm` — gm, gn, daily check-in.
- `morning-brief` — fired on `wake.confirmed`.
- `quiet-user-watcher` — daily watcher.
- `habit-starters` — eight habits, **offered** (not auto-seeded).
- `inbox-triage-starter` — opt-in, gated on Gmail.
- `followup-starter` — watcher firing per overdue relationship.
- `autofill-whitelist-pack`, `consolidation-policies`, `escalation-ladders`
  — policy-only packs.

`@elizaos/plugin-health` ships `bedtime`, `wake-up`, `sleep-recap` and
registers them when a health connector pairs.

### Adding a new default pack

1. Add a file under `src/default-packs/<name>.ts` that exports a
   `DefaultPack` matching `registry-types.ts`.
2. Import and append it to `DEFAULT_PACKS` in `src/default-packs/index.ts`.
3. If the pack should be **auto-enabled**, list it in
   `getDefaultEnabledPacks`. If it should be **offered** during first-run
   customize, list it in `getOfferedDefaultPacks`. If neither, the pack
   only seeds when invoked explicitly.
4. Run `bun run lint:default-packs` (also runs as `pretest`). The lint
   rules live in `docs/audit/prompt-content-lint.md`. CI rejects packs
   that violate them.
5. Add a record-id constant export so consumers can target the records by
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
- **REST surface** — see `docs/rest/lifeops.md`.

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

LifeOps consumes `@elizaos/plugin-health` for sleep/circadian/health metrics
and screen-time. The plugin contributes through the registries listed above
(`AnchorRegistry`, `ConnectorRegistry`, `FamilyRegistry`, default packs).
LifeOps does not import directly into the health internals; it consumes the
plugin's public exports only. See `plugins/plugin-health/README.md`.

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

- Frozen interface contracts: `docs/audit/wave1-interfaces.md`.
- Implementation plan: `docs/audit/IMPLEMENTATION_PLAN.md`.
- Post-cleanup architecture summary: `docs/audit/post-cleanup-architecture.md`.
- Coverage matrix: `coverage-matrix.md`.
- Prompt-content lint rules: `docs/audit/prompt-content-lint.md`.
- Health domain: `plugins/plugin-health/README.md`.
- REST: `docs/rest/lifeops.md`.
- QA reference: `docs/launchdocs/14-lifeops-qa.md`.
- User-facing setup: `docs/user/lifeops-setup.mdx`.
