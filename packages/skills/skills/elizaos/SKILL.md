---
name: elizaos
description: "Use when the task involves elizaOS core runtime concepts, plugins, actions, providers, evaluators, services, memories, state composition, or upstream elizaOS development. Covers the main abstractions and the TypeScript runtime mental model."
---

# elizaOS

<<<<<<< HEAD
elizaOS is the plugin-based agent runtime that Eliza builds on top of.
=======
elizaOS is the plugin-based agent runtime that Milady builds on top of.
>>>>>>> c5b9e96bc6 (chore(testing): add shared test utilities and helper scripts)

## Read These References First

- `references/core-abstractions.md` for the runtime mental model and message flow
- `references/plugin-development.md` for plugin extension points and implementation patterns

## Use This Skill When

- a change touches `eliza/`
- you need to reason about `AgentRuntime`
- you are implementing or debugging actions, providers, evaluators, services, or model handlers
<<<<<<< HEAD
- you need the correct plugin lifecycle instead of guessing from Eliza wrappers

## Working Rules

- Treat the TypeScript runtime in `eliza/packages/core/src/` as the primary reference implementation.
=======
- you need the correct plugin lifecycle instead of guessing from Milady wrappers

## Working Rules

- Treat the TypeScript runtime in `eliza/packages/typescript/src/` as the primary reference implementation.
>>>>>>> c5b9e96bc6 (chore(testing): add shared test utilities and helper scripts)
- Prefer elizaOS-native abstractions over product-specific wrappers when reasoning about upstream behavior.
- Remember the split between persistent `Memory` and ephemeral `State`.
- Remember that plugins are the main composition mechanism.
