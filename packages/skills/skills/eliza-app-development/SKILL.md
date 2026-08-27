---
name: eliza-app-development
description: "Use when building or changing an elizaOS-based application in this repository. Covers eliza app architecture, monorepo layout, local versus remote versus cloud routing, where to edit features, and non-negotiable runtime constraints. Eliza is the product name of this particular eliza app checkout."
---

# eliza app development

This repository is an **elizaOS application**: a local-first assistant with CLI, dashboard, Electrobun desktop shell, connectors, and Eliza Cloud integration. **Eliza** is this app’s product and CLI name—not a separate platform from elizaOS.

## Read These References First

- `references/repo-map.md` for layout, edit targets, and common commands
- `references/runtime-and-cloud.md` for runtime flow, onboarding, service routing, skills, and Eliza Cloud behavior

## Editing Heuristics

- Prefer `packages/app-core/` for app shell behavior (API, CLI, onboarding, config).
- Prefer `packages/agent/` for agent providers, services, and runtime glue around elizaOS.
- Prefer `packages/app/` for UI work and `packages/app-core/platforms/electrobun/` for the Electrobun native shell.
- Treat `packages/cloud/` as the Eliza Cloud product and backend surface.
- Before creating UI, search `@elizaos/ui` exports, layouts, state components,
  registries, and existing plugin views. Consume the canonical primitives and
  extend them when the product semantics match; keep only domain composition
  in the app or plugin.
- Before creating a utility or contract, search `@elizaos/core`,
  `@elizaos/shared`, and the domain owner. Fix a missing export or dependency
  direction instead of maintaining an app-local copy.

## Hard Constraints

- Do not remove `NODE_PATH` setup.
- Do not remove the Bun exports patch.
- Do not remove Electrobun startup error guards.
- Keep Node and Bun paths working.

## Repo Workflow

```bash
bun install
bun run verify
bun run test
```

Narrower commands when useful:

```bash
bun run start
bun run dev
bun run dev:desktop
bun run test:e2e
```

## Where to Look First

- Product and runtime behavior: `packages/app-core/src/`
- Prompt, provider, and skill plumbing: `packages/agent/src/`
- Onboarding and routing: `packages/ui/src/first-run/` and `packages/app-core/src/runtime/`
- Shipped default skills: bundled in `@elizaos/skills`, seeded into the state-dir skills folder by `packages/app-core/scripts/ensure-skills.mjs`
- Eliza Cloud backend or monetization: `packages/cloud/` and the shipped `eliza-cloud` skill

## Cloud Default

If the task involves building an app and Eliza Cloud is enabled, linked, or explicitly requested, treat Cloud as the default managed backend before inventing custom auth, billing, analytics, or hosting. Use the `eliza-cloud` skill for app, monetization, and container details.

## Related Skills

- `elizaos` — core runtime abstractions and upstream plugin patterns
- `eliza-cloud` — apps, billing, monetization, auth, containers
