# LifeOps REST API

LifeOps registers HTTP routes under `/api/lifeops/*`. Three groups matter
for callers building against the new architecture:

1. **Scheduled tasks** — the canonical action surface.
2. **Entities + relationships** — the knowledge graph LifeOps reasons over.
3. **App state, connectors, and dev tooling** — operational surfaces.

Source of truth: `plugins/app-lifeops/src/routes/`. Every path listed here
is registered there.

## Scheduled tasks

Defined in `plugins/app-lifeops/src/routes/scheduled-tasks.ts`. The
`ScheduledTask` shape is the runtime contract every reminder, check-in,
follow-up, watcher, recap, and approval flows through.

| Method | Path                                              | Purpose                                                    |
| ------ | ------------------------------------------------- | ---------------------------------------------------------- |
| GET    | `/api/lifeops/scheduled-tasks`                    | List tasks, filterable by `kind`, `status`, `subject`.     |
| POST   | `/api/lifeops/scheduled-tasks`                    | Create a task. Body must satisfy the `ScheduledTaskInput` shape. |
| POST   | `/api/lifeops/scheduled-tasks/:id/snooze`         | Push the next-fire time. Resets the escalation ladder.     |
| POST   | `/api/lifeops/scheduled-tasks/:id/skip`           | Mark this occurrence skipped (terminal). Cron tasks generate next occurrence. |
| POST   | `/api/lifeops/scheduled-tasks/:id/complete`       | Mark complete (terminal). Triggers `pipeline.onComplete`. |
| POST   | `/api/lifeops/scheduled-tasks/:id/dismiss`        | Mark dismissed (terminal). Does not trigger `onComplete`.  |
| POST   | `/api/lifeops/scheduled-tasks/:id/escalate`       | Force the next escalation step.                            |
| POST   | `/api/lifeops/scheduled-tasks/:id/acknowledge`    | Record acknowledgement (non-terminal).                     |
| POST   | `/api/lifeops/scheduled-tasks/:id/reopen`         | Move a terminal task back to scheduled.                    |
| POST   | `/api/lifeops/scheduled-tasks/:id/edit`           | Patch the task definition in place.                        |
| GET    | `/api/lifeops/scheduled-tasks/:id/history`        | State-log entries for the task.                            |

### Dev-only

| Method | Path                                              | Purpose                                                                  |
| ------ | ------------------------------------------------- | ------------------------------------------------------------------------ |
| GET    | `/api/lifeops/dev/scheduled-tasks/:id/log`        | Full transition log (`state-log.ts`).                                    |
| GET    | `/api/lifeops/dev/registries`                     | Snapshot of `AnchorRegistry`, `EventKindRegistry`, `FamilyRegistry`, `BlockerRegistry`, `ChannelRegistry`, `ConnectorRegistry`. Useful for debugging "why didn't this fire?" |

## Entities

Defined in `plugins/app-lifeops/src/routes/entities.ts`. Backed by
`EntityStore` (`plugins/app-lifeops/src/lifeops/entities/store.ts`). The
graph is per-agent and includes the bootstrapped `entityId === "self"`.

| Method | Path                              | Purpose                                                                                  |
| ------ | --------------------------------- | ---------------------------------------------------------------------------------------- |
| GET    | `/api/lifeops/entities`           | List entities, filterable by `type` and identity.                                        |
| POST   | `/api/lifeops/entities`           | Create an entity. Identities are observed via `observeIdentity` and may auto-merge.     |
| GET    | `/api/lifeops/entities/resolve`   | Resolve a `(platform, handle)` pair to an `entityId` (uses the merge engine).            |
| POST   | `/api/lifeops/entities/merge`     | Manually merge two entities. Audited.                                                    |

## Relationships

Defined in `plugins/app-lifeops/src/routes/relationships.ts`. Relationships
are **edges** carrying cadence, confidence, last-interaction state, and
similar per-edge data. Anything that says "I haven't talked to Pat in N
days" reads from here.

| Method | Path                                  | Purpose                                                                                |
| ------ | ------------------------------------- | -------------------------------------------------------------------------------------- |
| GET    | `/api/lifeops/relationships`          | List relationships, filterable by entity, type, or cadence-overdue threshold.          |
| POST   | `/api/lifeops/relationships`          | Create a relationship between two entities.                                            |
| POST   | `/api/lifeops/relationships/observe`  | Append an observation that updates `lastInteractionAt` and confidence.                 |

## App state and operational surfaces

Defined in `plugins/app-lifeops/src/routes/lifeops-routes.ts`. Highlights;
the file is the canonical inventory.

| Method | Path                                            | Purpose                                                                |
| ------ | ----------------------------------------------- | ---------------------------------------------------------------------- |
| GET    | `/api/lifeops/app-state`                        | Current app-level state (paused, first-run status, packs enabled).     |
| PUT    | `/api/lifeops/app-state`                        | Patch app-level state, including global pause.                         |
| POST   | `/api/lifeops/features/toggle`                  | Enable/disable a feature flag.                                         |
| GET    | `/api/lifeops/inbox`                            | The inbox-triage view.                                                 |
| GET    | `/api/lifeops/calendar/feed`                    | Calendar feed across connected calendars.                              |
| POST   | `/api/lifeops/calendar/events`                  | Create a calendar event.                                               |
| GET    | `/api/lifeops/gmail/triage` etc.                | Gmail triage / search / send / spam-review / unresponded surfaces.     |
| GET    | `/api/lifeops/connectors/<kind>/status`         | Connector status for `imessage`, `telegram`, `signal`, `x`, `health`.  |
| POST   | `/api/lifeops/connectors/<kind>/<verb>`         | Connector control surfaces (start, pair, send, disconnect, …).         |
| GET    | `/api/lifeops/health/summary`                   | Health summary (proxied through `@elizaos/plugin-health`).             |

## What changed from the pre-cleanup API

- **Reminder, follow-up, check-in, and watcher endpoints collapsed into
  `/api/lifeops/scheduled-tasks/*`.** There is one task primitive; verbs
  (`snooze`, `skip`, `complete`, `dismiss`, `escalate`, `acknowledge`,
  `reopen`, `edit`) are uniform across all kinds.
- **Health endpoints moved.** `@elizaos/plugin-health` owns the connectors,
  anchors, and bus families; LifeOps proxies `/health/summary` and
  `/health/sync` to the plugin's bridge. There is no separate health-only
  REST surface.
- **`/api/lifeops/relationships/*` is new.** The relationship graph used to
  be implicit inside the contact resolver; it is now an explicit edge
  store with its own routes and own action (`RELATIONSHIP`).
- **`/api/lifeops/dev/registries` is new.** Inspect the connector / channel
  / anchor / event-kind / family / blocker registries at runtime; primary
  use case is debugging "why didn't this task fire?"
