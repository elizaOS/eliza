# AGENTS — elizaOS repository

This is the contributor charter for the elizaOS repository. The
companion `CLAUDE.md` covers tooling and review conventions; this file
covers what the codebase enforces.

## LifeOps app + plugin-health

LifeOps (`@elizaos/app-lifeops`) and the health plugin
(`@elizaos/plugin-health`) follow a single architecture:

- **One task primitive: `ScheduledTask`.** Reminders, check-ins,
  follow-ups, watchers, recaps, approvals, and outputs are all
  `ScheduledTask` records routed through one runner at
  `plugins/app-lifeops/src/lifeops/scheduled-task/runner.ts`. Do not
  add a parallel mechanism.
- **Behavior is structural, not textual.** The runner pattern-matches on
  `kind`, `trigger`, `shouldFire`, `completionCheck`, `pipeline`,
  `output`, `subject`, `priority`, and `respectsGlobalPause`. It never
  inspects `promptInstructions` content.
- **Health is a separate plugin.** `@elizaos/plugin-health` contributes
  through registries (connectors, anchors, bus families, default packs).
  LifeOps does not import its internals.

For the architecture details, frozen contracts, and contribution paths,
read in this order:

1. `plugins/app-lifeops/README.md` — LifeOps architecture summary.
2. `plugins/plugin-health/README.md` — health plugin summary.
3. `plugins/app-lifeops/docs/audit/post-cleanup-architecture.md` —
   what changed and what to read next.
4. `plugins/app-lifeops/docs/audit/wave1-interfaces.md` — frozen
   `ScheduledTask`, entity/relationship, connector/channel, first-run,
   and pack contracts.
5. `plugins/app-lifeops/docs/audit/IMPLEMENTATION_PLAN.md` — the wave
   plan that drove the cleanup, useful as historical context.

### Adding a new default pack

1. Add a file under `plugins/app-lifeops/src/default-packs/<name>.ts`
   exporting a `DefaultPack` (see `registry-types.ts`).
2. Append the pack to `DEFAULT_PACKS` in
   `plugins/app-lifeops/src/default-packs/index.ts`.
3. Decide enablement: auto-enabled (`getDefaultEnabledPacks`),
   offered during first-run customize (`getOfferedDefaultPacks`), or
   manual-only (neither).
4. Run `bun run lint:default-packs` (also runs as `pretest`). Lint rules
   live in `plugins/app-lifeops/docs/audit/prompt-content-lint.md` and
   are CI-enforced.
5. Export a record-id constant so consumers target records by stable ID.

Health-domain packs go to `plugins/plugin-health/src/default-packs/`
instead and follow the same registration shape.

### What NOT to add

- A second task primitive.
- A second knowledge-graph store. Use `EntityStore` and
  `RelationshipStore`; cadence lives on the relationship edge.
- Behavior driven by `promptInstructions` string content.
- A `boolean` return from a connector or channel dispatch — use the
  typed `DispatchResult`.
- An identity-merge rule that bypasses the merge engine. Identity is
  observed via `observeIdentity`; manual merges are auditable.
