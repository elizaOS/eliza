# Plugin And Skill Lifecycle

## Skills

Repo-owned default skills live in:

```text
packages/skills/skills/<slug>/SKILL.md
```

They are published by `@elizaos/skills`. Startup seeding copies shipped skills into the managed state-dir skills folder when the user does not already have an editable copy. Workspace or managed skills can override bundled defaults without changing the package copy.

Important paths and concepts:

- `packages/skills/skills/` is the bundled default source of truth.
- `$ELIZA_STATE_DIR/skills` or `~/.eliza/skills` is the managed editable store.
- `packages/agent/src/runtime/eliza.ts` wires bundled, workspace, and extra skill roots into the runtime.
- `@elizaos/plugin-agent-skills` owns skill discovery, eligibility, edit/copy behavior, and the `USE_SKILL` action.
- The agent orchestrator renders a task-local `SKILLS.md` for spawned workers.

To change default behavior for every install, edit `packages/skills/skills/<slug>/SKILL.md` and its references. To customize one app/workspace, edit the copied skill in the managed skills store.

## Plugins

elizaOS plugins are runtime objects that can register:

- actions
- providers
- services
- model handlers
- evaluators
- routes
- events
- schemas or adapters

Use `elizaos/references/plugin-development.md` for core plugin shape. Use the app's existing package patterns before creating a new layout.

## Loading And Unloading Plugins

Plugin loading is runtime-managed. In this repo, check these areas first:

- `packages/agent/` for app-side runtime glue and default plugin setup
- `packages/app-core/` for CLI/API/config behavior that selects runtime and plugin sources
- `packages/cli/` for commands that build, test, publish, or manage plugins
- `packages/plugin-*` and `plugins/plugin-*` for existing plugin packages
- the active config/onboarding path for enabled plugins and linked credentials

Do not hot-load arbitrary plugin code by ad hoc `import()` from a worker unless an existing runtime command/API is designed for that. Prefer the repo's CLI/runtime helpers and restart the runtime when a plugin load boundary requires it.

## Building And Testing Plugins

Common repo-level commands:

```bash
bun install
bun run verify
bun run test
```

For narrower work, inspect each package's `package.json` and use its local scripts. Prefer targeted tests for a plugin package before broad workspace tests.

## Worker Guidance

When a spawned worker needs to build or change the running agent:

1. Read `AGENTS.md` and `CLAUDE.md` in the CWD.
2. Inspect the plugin/package being changed and follow its existing scripts.
3. Use `USE_SKILL parent-agent` for runtime state or external connector actions.
4. Use `DECISION:` only when a human choice is required.
