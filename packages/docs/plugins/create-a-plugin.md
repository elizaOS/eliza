---
title: Create a plugin
description: Scaffold, extend, test, and load an elizaOS plugin.
---

Use the maintained CLI template instead of assembling a package by hand. It
tracks the current `@elizaos/core` version, build pipeline, frontend shell, and
test harness.

```bash
npx elizaos create my-plugin --template plugin
cd my-plugin
bun install
bun run build
bun run test
```

The source of truth for generated files is
[`packages/elizaos/templates/plugin`](https://github.com/elizaOS/eliza/tree/develop/packages/elizaos/templates/plugin).

## Generated structure

```text
my-plugin/
├── build.ts
├── package.json
├── src/
│   ├── index.ts
│   ├── plugin.ts
│   ├── __tests__/
│   ├── e2e/
│   └── frontend/
└── tsconfig.json
```

`src/index.ts` is the package entry point. `src/plugin.ts` contains the starter
`Plugin` object and examples of the supported registration surfaces. Split it
into `actions/`, `providers/`, and `services/` modules as the plugin grows.

## Plugin object

Every plugin exports a `Plugin` object from `@elizaos/core`:

```typescript
import type { Plugin } from "@elizaos/core";
import { healthAction } from "./actions/health.ts";
import { accountProvider } from "./providers/account.ts";
import { ApiService } from "./services/api.ts";

export const myPlugin: Plugin = {
  name: "plugin-my-feature",
  description: "Adds my feature to an Eliza agent",
  actions: [healthAction],
  providers: [accountProvider],
  services: [ApiService],
};

export default myPlugin;
```

A plugin can also register evaluators, events, routes, model handlers, tests,
and initialization or disposal hooks. [Plugin architecture](/plugins/architecture)
documents when to use each surface.

## Configuration

Declare public configuration metadata under `agentConfig.pluginParameters` in
`package.json`, validate values at the plugin boundary, and read secrets through
runtime settings. Never include real credentials in the plugin object or
published package.

The generated template includes a Zod configuration example. Replace its
placeholder variable with the settings your service actually requires and let
invalid required configuration fail during initialization.

## Load the plugin locally

Link the package into an Eliza project:

```bash
cd ../my-agent
bun add link:../my-plugin
```

Add the installed package name to the character's `plugins` array or to
`plugins.allow` in `eliza.json`, depending on whether the capability belongs to
one character or the whole runtime. See [Local plugins](/plugins/local-plugins)
for resolution rules.

## Verify before publishing

```bash
bun run build
bun run typecheck
bun run lint:check
bun run test
```

The generated `test` script runs component tests and the plugin's end-to-end
lane. Extend the real-runtime E2E suite for every behavior the plugin adds; use
isolated unit tests only for deterministic computation.

## Publish and discover

Publish the built package to npm with the `elizaos` keyword. The CLI can inspect
the registry metadata it would submit:

```bash
elizaos plugins submit --dry-run
```

See [Publishing plugins](/plugins/publish) for package metadata and release
guidance.

## Related

- [Plugin anatomy](/tracks/plugin/anatomy)
- [Patterns](/plugins/patterns)
- [Testing](/plugins/testing)
- [Schemas](/plugins/schemas)
