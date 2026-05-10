# Post-cleanup architecture — short summary

Three-line orientation: LifeOps now has **one task primitive**
(`ScheduledTask`) **one runner**, **one entity/relationship graph**, and
**one set of registries** (anchors, event kinds, families, blockers,
channels, connectors, send-policy). The health domain is a separate plugin
(`@elizaos/plugin-health`) that contributes through those registries.

This document is the map for new contributors. It is intentionally short.
For the per-section detail, follow the file paths.

## What changed

### Spine collapse

Reminder, check-in, follow-up, watcher, recap, approval, and output flows
all became `ScheduledTask` records routed through one runner at
`plugins/app-lifeops/src/lifeops/scheduled-task/runner.ts`. Pre-cleanup,
each kind had its own bespoke handler with overlapping but inconsistent
semantics around firing, snoozing, escalation, and completion. The single
runner fixed that and made the verbs (`snooze | skip | complete | dismiss
| escalate | acknowledge | reopen | edit`) uniform.

The runner pattern-matches on structural fields only. It never inspects
`promptInstructions` content. The frozen schema lives in
`wave1-interfaces.md` §1.

### Health extraction

`@elizaos/plugin-health` became a separate plugin owning sleep, circadian
regularity, screen-time, six health connectors, four sleep/wake anchors,
eight bus families, and three default packs (`bedtime`, `wake-up`,
`sleep-recap`). LifeOps consumes the plugin through registry contributions
only.

### Knowledge graph

`EntityStore` (nodes) and `RelationshipStore` (edges) replaced the implicit
contact-resolver model. Cadence lives on the relationship edge, not the
entity. Identity resolution is observation-based — `(platform, handle)`
pairs flow through `observeIdentity` and the merge engine collapses
duplicates.

### Default-pack registry

Default packs are explicit registrations in
`plugins/app-lifeops/src/default-packs/index.ts` (LifeOps) and
`plugins/plugin-health/src/default-packs/` (health). The lint at
`plugins/app-lifeops/scripts/lint-default-packs.mjs` runs on `pretest` and
enforces the rules in `prompt-content-lint.md`. There is no string-match
seeding.

### First-run

`FIRST_RUN` action with three paths (defaults / customize / replay) backed
by `FirstRunStateStore` and `OwnerFactStore`. Customize is a fixed
five-question flow with persisted-per-question answers. Replay reads the
current owner facts and pre-fills the customize answers without destroying
existing tasks.

### Pause and handoff

Two separate primitives. `GlobalPauseStore` is global; respects
`respectsGlobalPause: true` on the task. `HandoffStore` is per-room with
typed resume conditions. The `RoomPolicyProvider` reads
`HandoffStore.status(roomId).active` and gates further agent contributions
in handed-off rooms.

### Other supporting capabilities

- `MultilingualPromptRegistry` — locale-aware prompt content for default
  packs.
- `OwnerFactStore` — generalized from the prior `LifeOpsOwnerProfile`;
  holds preferred name, timezone, morning/evening windows, locale,
  escalation rules.
- `PendingPromptsStore` — the planner-visible "questions waiting for the
  user" surface, fed to providers.
- `BlockerRegistry` — app blockers and website blockers contribute through
  the same registry.
- `ActivitySignalBus` — pub/sub fabric for `LifeOpsBusFamily` events.

## What to read next

- **`IMPLEMENTATION_PLAN.md`** — the wave plan that drove the cleanup.
  Sections §3 (foundations) and §5 (migration) describe the moving pieces
  in order.
- **`wave1-interfaces.md`** — the frozen contract every component builds
  against. §1 (`ScheduledTask`), §2 (entity/relationship), §3 (connector /
  channel / transport), §4 (first-run / providers / global pause), §5
  (plugin-health), §6 (default packs), §7 (cross-agent invariants).
- **`prompt-content-lint.md`** — the rules the default-pack lint enforces.
- **`coverage-matrix.md`** (in the parent plugin dir) — the
  domain-anchored test/journey coverage map.
- **`../../README.md`** — `app-lifeops` architecture summary.
- **`../../../plugin-health/README.md`** — `plugin-health` summary.
- **`../../../../docs/user/lifeops-setup.mdx`** — user-facing setup.
- **`../../../../docs/rest/lifeops.md`** — REST surface.
- **`../../../../docs/launchdocs/14-lifeops-qa.md`** — QA reference.

## What NOT to add

- A second task primitive. Reminder/check-in/follow-up/watcher/recap are
  `ScheduledTask` records. Adding a parallel mechanism breaks the single
  runner contract.
- A second knowledge-graph store. Use `EntityStore` and
  `RelationshipStore`; if you need a new attribute, extend the existing
  shapes.
- Behavior driven by `promptInstructions` string content. Behavior is
  driven by structural fields (`kind`, `trigger`, `shouldFire`,
  `completionCheck`, `pipeline`, `output`, `subject`, `priority`,
  `respectsGlobalPause`).
- A free-form `boolean` return from a connector or channel dispatch. Use
  the typed `DispatchResult`.
- A new default pack without registering it in
  `default-packs/index.ts` and running `bun run lint:default-packs`.
- A new auto-merge identity rule that bypasses the merge engine. Identity
  is observed; merges are auditable.

## Audit-doc relevance

The other docs in this directory document the cleanup itself:

- `GAP_ASSESSMENT.md`, `HARDCODING_AUDIT.md`, `JOURNEY_GAME_THROUGH.md`,
  `UX_JOURNEYS.md` — pre-cleanup audits.
- `IMPLEMENTATION_PLAN.md` — the plan that drove the work.
- `wave1-interfaces.md` — frozen contract.
- `prompt-content-lint.md` — lint rules (CI-enforced).
- `default-packs-rationale.md`, `default-pack-curation-rationale.md`,
  `default-pack-simulation-7day.json` — pack curation evidence.
- `post-Wave-2-ambiguity-register.md` — open questions surfaced during
  migration.
- `post-cleanup-architecture.md` — this file.

For shipping work going forward, follow `wave1-interfaces.md` and the
plugin READMEs. The audit docs are historical context; the contracts are
the rules.
