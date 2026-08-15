---
title: Testing plugins
description: Use the generated component and real-runtime E2E lanes to verify an elizaOS plugin.
---

The plugin template ships a current Vitest setup, runtime fixture, and an E2E
suite. Start from that harness so tests follow the same package versions and
runtime construction as generated plugins:

```bash
npx elizaos create my-plugin --template plugin
cd my-plugin
bun install
bun run test
```

The maintained reference is
[`packages/elizaos/templates/plugin/src`](https://github.com/elizaOS/eliza/tree/develop/packages/elizaos/templates/plugin/src).

## Test lanes

| Script | Scope |
| --- | --- |
| `test:component` | Fast deterministic tests under `src/__tests__`. |
| `test:e2e` | Plugin behavior through the generated agent/runtime harness. |
| `test` | Both lanes, in that order. |

The generated package also exposes `test:e2e:manual` as an explicit alias for
the E2E lane.

## What to test

- **Actions:** validation, parameter handling, callback output, structured
  `ActionResult`, and surfaced dependency failures.
- **Providers:** the real context returned for representative runtime state,
  including unavailable dependencies.
- **Services:** startup, observable behavior, concurrency, and teardown through
  an actual runtime lifecycle.
- **Routes and events:** authentication or ownership boundaries, invalid input,
  response shape, and real event dispatch.
- **Plugin loading:** package resolution, initialization, registration, and
  disposal from a host project.

Use unit doubles only around a narrow external boundary when testing pure local
logic. A mocked runtime does not prove plugin registration, planner selection,
model interaction, persistence, or network behavior; cover those in E2E.

## Live-model behavior

If a change affects action selection, prompt context, provider output, or model
handling, run a real model path and inspect the trajectory. Repository plugins
can use the scenario runner:

```bash
packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <output>
```

Keep secrets out of fixtures and reports. Tests that require live services
should fail clearly when their credentials or service are unavailable, rather
than silently substituting a healthy-looking result.

## Repository plugins

Inside this monorepo, use the package-local scripts and read the plugin's
`CLAUDE.md` before editing:

```bash
bun run --cwd plugins/<plugin-directory> build
bun run --cwd plugins/<plugin-directory> typecheck
bun run --cwd plugins/<plugin-directory> test
```

Run the repository verification command before handing off a change:

```bash
bun run verify
```

## Related

- [Create a plugin](/plugins/create-a-plugin)
- [Plugin patterns](/plugins/patterns)
- [Scenario testing](/plugins/scenarios)
- [Publishing plugins](/plugins/publish)
