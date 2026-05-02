# eliza app repo map

## What this repository is

This checkout is an **elizaOS application**: runtime, UI, connectors, and Cloud hooks bundled as the **Eliza** product (CLI `eliza`, user-facing name Eliza). Same stack patterns apply to other eliza apps; this repo is one concrete implementation.

It combines:

- a local-first runtime and CLI
- a web dashboard
- an Electrobun desktop shell
- connector integrations
- Eliza Cloud routing, provisioning, and billing hooks

## Main edit targets

### `packages/app-core/`

Primary app-shell logic.

- `src/runtime/` for runtime bootstrap, env shaping, provider routing, and process behavior
- `src/cli/` for CLI wiring
- `src/api/` for app HTTP routes
- `src/config/` for config schemas and canonical routing/storage fields
- `src/connectors/` for platform integrations
- `src/providers/` for prompt/state context builders

### `packages/agent/`

Agent layer on elizaOS: providers, skill discovery and catalog plumbing, runtime compatibility layers, training and testing helpers.

### `apps/app/`

Main React UI and desktop shell: web UI, onboarding, settings, Electrobun native process under `apps/app/electrobun/`.

### `eliza/cloud/`

Eliza Cloud product code (git submodule nested under `eliza/`): apps, billing, earnings, auth, containers, domains, cloud-side agent runtime and plugins.

### `eliza/`

Repo-local upstream elizaOS checkout for linked development. Change this only when the issue is genuinely upstream or the user asks for upstream work.

## Commands

```bash
bun install
bun run verify
bun run test
```

Useful narrower commands:

```bash
bun run dev
bun run dev:desktop
bun run eliza ...
bun run test:e2e
bun run test:coverage
```

## Non-negotiable runtime invariants

- `NODE_PATH` setup is required for dynamic plugin imports.
- The Bun exports patch is required for some published `@elizaos/*` packages.
- Electrobun startup guards keep the desktop UI usable when the runtime fails.

## Default skill seeding

Shipped skills are bundled in `@elizaos/skills` and are seeded into the state-dir skills folder (e.g. `~/.eliza/skills` when `ELIZA_NAMESPACE=eliza`) by Eliza’s `scripts/ensure-skills.mjs`. They are default agent knowledge, not optional extras.
