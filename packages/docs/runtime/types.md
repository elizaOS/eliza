---
title: "TypeScript contracts"
sidebarTitle: "Types"
description: "Find the canonical TypeScript contracts for elizaOS configuration, runtime, and plugins."
---

elizaOS exports its public runtime contracts from `@elizaos/core`. Product
configuration contracts live in `@elizaos/shared`. Import these types instead
of recreating local copies.

```typescript
import type {
  Action,
  Character,
  IAgentRuntime,
  Memory,
  Plugin,
  Provider,
  Service,
  State,
} from "@elizaos/core";

import type { ElizaConfig } from "@elizaos/shared";
```

## Contract map

| Contract | Canonical source | Purpose |
| --- | --- | --- |
| `IAgentRuntime` | `packages/core/src/types/runtime.ts` | Runtime methods and registered capability collections |
| `Plugin` and routes | `packages/core/src/types/plugin.ts` | Plugin registration and HTTP extension surfaces |
| `Action`, `Provider`, results | `packages/core/src/types/components.ts` | Planner operations and state context |
| `Service` | `packages/core/src/types/service.ts` | Long-lived runtime capabilities |
| `ModelType` and model maps | `packages/core/src/types/model.ts` | Model-agnostic inference contracts |
| `Memory` | `packages/core/src/types/memory.ts` | Persisted message and knowledge records |
| `State` | `packages/core/src/types/state.ts` | Turn-scoped composed context |
| `EventType` and payloads | `packages/core/src/types/events.ts` | Runtime event subscriptions |
| `Character` | `packages/core/src/types/agent.ts` | Agent identity and behavior configuration |
| `ElizaConfig` | `packages/shared/src/config/types.eliza.ts` | Product configuration root |
| `AgentConfig` | `packages/shared/src/config/types.agents.ts` | Per-agent product configuration |

Browse the exported core types in
[`packages/core/src/types`](https://github.com/elizaOS/eliza/tree/develop/packages/core/src/types)
and shared configuration in
[`packages/shared/src/config`](https://github.com/elizaOS/eliza/tree/develop/packages/shared/src/config).

## Runtime validation

TypeScript types do not validate JSON, environment variables, HTTP bodies, or
model output at runtime. Validate each untrusted boundary with the schema owned
by that boundary, then pass typed values inward.

Avoid `any`, unchecked casts, and optional fallbacks for required data. A value
that failed to load is not equivalent to an empty value.

## Compatibility

The exported declarations in each published package define its supported
contract. Internal types may change without being a public API. Before using a
deep source import, check the package `exports` map and prefer its documented
entry points.

See [Core runtime](/runtime/core), [Plugin architecture](/plugins/architecture),
and [Configuration](/configuration) for usage examples.
