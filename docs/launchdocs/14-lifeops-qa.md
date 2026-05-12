# LifeOps — Launch QA reference

This is the QA reference for the LifeOps app and its supporting plugins.
Use it to verify behavior, write release-gate checklists, and reproduce
issues. Architecture detail and contribution guidance live in the plugin
READMEs (`plugins/app-lifeops/README.md`, `plugins/plugin-health/README.md`).

## What LifeOps is

LifeOps is a domain-spanning elizaOS app: routines, goals, calendar, email,
messaging, follow-ups, blockers, watchers, and the operational glue around
them. It is shipped as `@elizaos/app-lifeops` and consumes
`@elizaos/plugin-health` for the health/sleep/circadian/screen-time domain.

## The single primitive

Every reminder, check-in, follow-up, watcher, recap, approval surface, and
nag-the-user-when-they-go-quiet flow is a **`ScheduledTask`** owned by the
runner at `plugins/app-lifeops/src/lifeops/scheduled-task/runner.ts`. There
is no second mechanism. If LifeOps does it, it is a `ScheduledTask`.

Behavioral fields the runner pattern-matches on:

- `kind` — `"reminder" | "checkin" | "followup" | "approval" | "recap" | "watcher" | "output" | "custom"`
- `trigger` — `once | cron | interval | relative_to_anchor | during_window | event | manual | after_task`
- `shouldFire` — gate composition (`all | any | first_deny`)
- `completionCheck` — when "done" is true
- `escalation` — laddered re-notification across channels
- `output` — destination (`in_app_card | channel | apple_notes | gmail_draft | memory`)
- `pipeline` — chained tasks on `onComplete | onSkip | onFail`
- `subject` — `entity | relationship | thread | document | calendar_event | self`
- `priority` — `low | medium | high` (drives channel posture)
- `respectsGlobalPause` — opt-out for emergencies

The runner **never** pattern-matches on the contents of `promptInstructions`.
QA scenarios that depend on prompt-string matching are bugs.

## Supporting capabilities

These are the runtime singletons the runner reads from. QA failures often
reduce to "the right registry was not populated"; the dev endpoint
`/api/lifeops/dev/registries` returns a snapshot of all of them.

- **Owner facts** — `OwnerFactStore` at
  `plugins/app-lifeops/src/lifeops/owner/fact-store.ts`. Holds preferred
  name, timezone, morning/evening windows, locale, escalation rules. Sourced
  from first-run.
- **Entities + relationships** — `EntityStore` and `RelationshipStore` at
  `plugins/app-lifeops/src/lifeops/entities/` and `relationships/`. The
  knowledge graph LifeOps reasons over. Cadence lives on the relationship
  edge. New `(platform, handle)` pairs are observed (not assigned) and the
  merge engine collapses entities with high-confidence identity matches.
- **Anchors** — `AnchorRegistry` at
  `plugins/app-lifeops/src/lifeops/registries/anchor-registry.ts`.
  `wake.observed`, `wake.confirmed`, `bedtime.target`, `nap.start` come
  from `@elizaos/plugin-health`; `meeting.ended`, `morning.start`,
  `lunch.start`, `night.start` come from LifeOps itself.
- **Event kinds + bus families** — `EventKindRegistry` and `FamilyRegistry`
  in `plugins/app-lifeops/src/lifeops/registries/`. Drive the `event` and
  `during_window` triggers, plus the `ActivitySignalBus`.
- **Blockers** — `BlockerRegistry` at
  `plugins/app-lifeops/src/lifeops/registries/blocker-registry.ts`. App
  blockers and website blockers contribute through the same registry.
- **Channels + connectors** — `ChannelRegistry` and `ConnectorRegistry` at
  `plugins/app-lifeops/src/lifeops/channels/` and `connectors/`. Connector
  contributions return a typed `DispatchResult`; channels also. There is
  no free-form boolean return on the dispatch path.
- **Send policy** — `plugins/app-lifeops/src/lifeops/send-policy/`. The
  per-connector contract owners use to decide whether the agent can send a
  given draft (e.g. requires owner approval, requires explicit consent,
  always allowed for in-app).
- **Multilingual prompts** — `MultilingualPromptRegistry` at
  `plugins/app-lifeops/src/lifeops/i18n/prompt-registry.ts`. The locale-aware
  source for default-pack prompt content.
- **Handoff** — `HandoffStore` at
  `plugins/app-lifeops/src/lifeops/handoff/store.ts`. Per-room handoff state
  with typed resume conditions (`mention | explicit_resume | silence_minutes
  | user_request_help`).

## Default packs

The set is fixed at boot. LifeOps-owned packs live in
`plugins/app-lifeops/src/default-packs/`:

- `daily-rhythm` — gm, gn, daily check-in.
- `morning-brief` — fired on `wake.confirmed`, consolidated by anchor policy.
- `quiet-user-watcher` — daily watcher reading recent task states.
- `habit-starters` — eight habits, **offered**.
- `inbox-triage-starter` — opt-in, gated on Gmail.
- `followup-starter` — watcher firing per overdue relationship.
- `autofill-whitelist-pack`, `consolidation-policies`, `escalation-ladders`
  — non-task packs that contribute policy.

`@elizaos/plugin-health` contributes `bedtime`, `wake-up`, `sleep-recap`
when a health connector pairs.

The lint script `plugins/app-lifeops/scripts/lint-default-packs.mjs` runs
on `pretest` and fails CI if any pack violates the prompt-content lint
rules in `plugins/app-lifeops/docs/audit/prompt-content-lint.md`.

## First-run flow

`FIRST_RUN` action with three paths: defaults, customize (5 questions, two
conditional, persisted Q-by-Q), and replay. The
`FirstRunStateStore` and `OwnerFactStore` are the source of truth; replay
reads current facts and pre-fills the customize questionnaire.

## Pause and handoff

- **Global pause** stops every `ScheduledTask` with `respectsGlobalPause:
  true`. UI toggle and `app-state` REST endpoint.
- **Per-room handoff** flips a multi-party room into hand-off mode after the
  agent says "I'll let you take it from here." Resume conditions are
  typed; multiple rooms can be in handoff simultaneously.

## QA invariants

These hold across every journey. A failing scenario is either a bug or a
miswritten QA test.

1. The runner never pattern-matches `promptInstructions` content.
2. `subject.kind = "relationship"` for cadence-bearing tasks; `subject.kind
   = "entity"` for "everything about Pat" lists. Cadence lives on the edge.
3. Identities are observed, not assigned. New `(platform, handle)` pairs
   route through `observeIdentity`; the merge engine collapses entities.
4. Connectors return `DispatchResult`; channels also. No free-form boolean
   returns.
5. `shouldFire` is always an array. Single-gate cases write
   `[{ kind, params }]`.
6. `acknowledged` ≠ `completed`. Pipeline `onComplete` only fires on
   `completed`.
7. Snooze resets the escalation ladder. No per-task variance.
8. Global pause skips tasks with `respectsGlobalPause: true`. Default true;
   emergency tasks flip it false explicitly.

## Where to look when something goes wrong

| Symptom                                    | Look here                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| Task fired late or not at all              | `GET /api/lifeops/dev/scheduled-tasks/:id/log` for transitions; check `shouldFire` gate decisions. |
| Anchor unresolved (`wake.confirmed` etc.)  | `GET /api/lifeops/dev/registries` and confirm the anchor is registered.              |
| Default pack didn't seed                   | Check first-run state in `FirstRunStateStore`; replay if needed.                     |
| Health pack absent                         | Confirm a health connector is paired; `@elizaos/plugin-health` registers packs lazily. |
| Quiet-user watcher silent                  | Confirm `RecentTaskStatesProvider` has data; the watcher reads from there.           |
| Channel not used                           | `GET /api/lifeops/dev/registries` — confirm the channel is registered AND has a connected dispatcher. |
| Group chat not responding                  | Check `HandoffStore.status(roomId)` — the room may be in handoff.                    |
