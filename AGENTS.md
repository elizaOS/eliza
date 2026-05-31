# AGENTS — elizaOS repository

This is the contributor charter for the elizaOS repository. The
companion `CLAUDE.md` covers tooling and review conventions; this file
covers what the codebase enforces.

## Cloud frontend visual review (REQUIRED for any UI change in `packages/cloud-frontend/`)

Any change in `packages/cloud-frontend/` MUST go through the screenshot +
manual-review loop before being declared done. Run:

```bash
bun run --cwd packages/cloud-frontend audit:cloud
```

This walks every route in `src/App.tsx` (53 routes × desktop + mobile × rest +
hover), logs in with the synthetic injected-ethereum JWT, captures the populated
UI, and auto-stubs `aesthetic-audit-output/manual-review/<slug>.md` for any new
route. You then fill in the verdict for every page you touched (and every page
your change can reach via shared layout/theme/components).

- Verdicts: `good` · `needs-work` · `needs-eyeball` · `broken`.
- No page can stay at `needs-work` or `broken` when a UI task is declared done.
- Iterate the loop at least 5 times for any meaningful redesign — screenshot,
  evaluate, fix, re-audit, repeat.
- Hover transitions to black-from-orange, or any blue at all, are banned.
- Full protocol + checklist template: `packages/cloud-frontend/AGENTS.md`.
- E2E coverage gap list per page: `packages/cloud-frontend/docs/E2E_COVERAGE_GAPS.md`.
- Hover/color rules: `packages/cloud-frontend/docs/HOVER_SYSTEM.md`.
- Dashboard IA: `packages/cloud-frontend/docs/DASHBOARD_REDESIGN.md`.

## LifeOps app + plugin-health

LifeOps (`@elizaos/plugin-lifeops`) and the health plugin
(`@elizaos/plugin-health`) follow a single scheduled-item architecture:

- **One LifeOps scheduled-item record: `ScheduledTask`.** Reminders,
  check-ins, follow-ups, watchers, recaps, approvals, and outputs are
  `ScheduledTask` records routed through one runner at
  `plugins/plugin-lifeops/src/lifeops/scheduled-task/runner.ts`. This is
  not the repository-wide task primitive: core runtime tasks, coding-agent
  tasks, project tasks, and feature tasks stay outside LifeOps and may be
  integrated through plugins/services instead of becoming LifeOps internals.
  Do not add a parallel LifeOps scheduling mechanism.
- **Behavior is structural, not textual.** The runner pattern-matches on
  `kind`, `trigger`, `shouldFire`, `completionCheck`, `pipeline`,
  `output`, `subject`, `priority`, and `respectsGlobalPause`. It never
  inspects `promptInstructions` content.
- **Health is a separate plugin.** `@elizaos/plugin-health` contributes
  through registries (connectors, anchors, bus families, default packs).
  LifeOps does not import its internals.

For the architecture details, frozen contracts, and contribution paths,
read in this order:

1. `plugins/plugin-lifeops/README.md` — LifeOps architecture summary.
2. `plugins/plugin-health/README.md` — health plugin summary.
3. `plugins/plugin-lifeops/docs/audit/post-cleanup-architecture.md` —
   what changed and what to read next.
4. `plugins/plugin-lifeops/docs/audit/wave1-interfaces.md` — frozen
   `ScheduledTask`, entity/relationship, connector/channel, first-run,
   and pack contracts.
5. `plugins/plugin-lifeops/docs/audit/IMPLEMENTATION_PLAN.md` — the wave
   plan that drove the cleanup, useful as historical context.

### Adding a new default pack

1. Add a file under `plugins/plugin-lifeops/src/default-packs/<name>.ts`
   exporting a `DefaultPack` (see `registry-types.ts`).
2. Append the pack to `DEFAULT_PACKS` in
   `plugins/plugin-lifeops/src/default-packs/index.ts`.
3. Decide enablement: auto-enabled (`getDefaultEnabledPacks`),
   offered during first-run customize (`getOfferedDefaultPacks`), or
   manual-only (neither).
4. Run `bun run lint:default-packs` (also runs as `pretest`). Lint rules
   live in `plugins/plugin-lifeops/docs/audit/prompt-content-lint.md` and
   are CI-enforced.
5. Export a record-id constant so consumers target records by stable ID.

Health-domain packs go to `plugins/plugin-health/src/default-packs/`
instead and follow the same registration shape.

### What NOT to add

- A second LifeOps scheduled-item mechanism.
- A second knowledge-graph store. Use `EntityStore` and
  `RelationshipStore`; cadence lives on the relationship edge.
- Behavior driven by `promptInstructions` string content.
- A `boolean` return from a connector or channel dispatch — use the
  typed `DispatchResult`.
- An identity-merge rule that bypasses the merge engine. Identity is
  observed via `observeIdentity`; manual merges are auditable.
