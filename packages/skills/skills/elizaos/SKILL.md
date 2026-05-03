---
name: elizaos
description: "Use when the task involves elizaOS core runtime concepts, plugins, actions, providers, evaluators, services, memories, state composition, or upstream elizaOS development. Covers the main abstractions and the TypeScript runtime mental model."
---

# elizaOS

elizaOS is the plugin-based agent runtime that Milady builds on top of.

## Read These References First

- `references/core-abstractions.md` for the runtime mental model and message flow
- `references/plugin-development.md` for plugin extension points and implementation patterns

## Use This Skill When

- a change touches `eliza/`
- you need to reason about `AgentRuntime`
- you are implementing or debugging actions, providers, evaluators, services, or model handlers
- you need the correct plugin lifecycle instead of guessing from Milady wrappers

## Working Rules

- Treat the TypeScript runtime in `eliza/packages/core/src/` as the primary reference implementation.
- Prefer elizaOS-native abstractions over product-specific wrappers when reasoning about upstream behavior.
- Remember the split between persistent `Memory` and ephemeral `State`.
- Remember that plugins are the main composition mechanism.
