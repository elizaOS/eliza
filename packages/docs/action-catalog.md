---
title: "Action Catalog"
sidebarTitle: "Action Catalog"
description: "Where action and provider contracts are defined and registered."
---

# Action Catalog

Actions and providers are authored in their owning TypeScript implementations.
Their descriptions, parameters, roles, and handlers form one contract; there is
no second JSON catalog or generated application-source copy to keep in sync.
The actions available to an agent depend on its explicitly registered plugins,
its current view, and the caller's authority.

## Ownership

| Surface | Source | Responsibility |
| --- | --- | --- |
| Runtime contracts | `packages/core/src/types/components.ts` | Action, provider, handler, and result contracts |
| Assistant composition | `plugins/plugin-assistant/src/index.ts` | Explicit assistant plugin registration |
| Assistant capabilities | `plugins/plugin-assistant/src/features` | Conversation, memory, autonomy, messaging, and credential workflows |
| Coding tools | `plugins/plugin-coding-tools/src/actions` | Shell execution and workspace file operations |
| Host view actions | `packages/agent/src/api/builtin-views.ts` | Actions contributed by the active application view |
| Prompt templates | `packages/prompts/src/index.ts` | Shared templates that render the registered contracts |

Core does not install the assistant's actions by default. Register the assistant
plugin or your own plugins when creating an agent. A discovered action is not
necessarily enabled or authorized in a running agent.

## Inspect the source inventory

From the repository root, print the current action names and implementing files:

```sh
node --input-type=module -e 'import { collectRegisteredActionInventory } from "./packages/prompts/scripts/registered-action-inventory.js"; console.log(JSON.stringify(collectRegisteredActionInventory(process.cwd()), null, 2))'
```

This read-only lexical inventory discovers typed action declarations and builtin
view actions. It is a navigation aid, not a runtime registry: dynamically created
registrations may not be discoverable statically. Inspect the owning plugin for
its activation conditions, provider list, and initialization requirements.

## Change a contract

Edit the action or provider in its owning plugin, update its callers if the
contract changes, and run that plugin's behavior tests. Metadata is read directly
from those definitions. Package builds emit JavaScript and declarations into
`dist`; they do not regenerate a catalog in another package's source tree.

Benchmark context is an explicit test fixture in
`packages/testing/src/benchmark-context-provider.ts`, not an assistant default.
