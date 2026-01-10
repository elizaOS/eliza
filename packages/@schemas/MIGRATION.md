# Type Migration Guide

This document explains how to migrate from the legacy manual types to the proto-generated types.

## Overview

elizaOS now has a **single source of truth** for all types, defined in Protocol Buffer schemas under `/schemas/eliza/v1/*.proto`. These schemas are compiled to generate types for:

- **TypeScript** → `packages/typescript/src/types/generated/`
- **Python** → `packages/python/elizaos/types/generated/`
- **Rust** → `packages/rust/src/types/generated/`

## Migration Strategy

We use a **gradual migration** approach:

1. **Legacy types remain** in their original locations for backwards compatibility
2. **Proto types are exported** alongside legacy types under the `proto` namespace
3. **New code should use** proto types for cross-language interoperability
4. **Existing code can migrate** incrementally

## Usage Examples

### TypeScript

```typescript
// Legacy imports (still work)
import { Memory, Content, State } from "@elizaos/core";

// Proto imports (new way)
import { proto } from "@elizaos/core";
const memory = proto.Memory.create({ entityId: "...", roomId: "..." });

// Or import directly from generated
import { Memory, Content } from "@elizaos/core/types/generated";
```

### Python

```python
# Legacy imports (still work)
from elizaos.types import Memory, Content, State

# Proto imports (new way)
from elizaos.types.generated import Memory, Content, State
```

### Rust

```rust
// Legacy imports (still work)
use elizaos::types::{Memory, Content, State};

// Proto imports (new way)
use elizaos::types::generated::{Memory, Content, State};
```

## Key Differences

### 1. Enum Values

Proto enums use `ENUM_NAME_VALUE` format:

```typescript
// Legacy
MemoryType.MESSAGE

// Proto
MemoryType.MEMORY_TYPE_MESSAGE
// or use the numeric value
```

### 2. Optional Fields

Proto types explicitly mark optional fields:

```typescript
// Legacy
interface Memory {
  id?: string;  // Optional but any string
}

// Proto  
interface Memory {
  id: string | undefined;  // Explicitly undefined when not set
}
```

### 3. Dynamic Properties

Use `google.protobuf.Struct` (represented as `JsonObject`) for dynamic data:

```typescript
// Legacy
interface Content {
  [key: string]: unknown;  // Any extra properties
}

// Proto
interface Content {
  data: JsonObject;  // Dynamic properties go in data field
}
```

## Generating Types

Run from the project root:

```bash
# Generate types for all languages
npm run generate:types

# Or from schemas directory
cd schemas
buf lint
buf generate
```

## Adding New Types

1. Edit the appropriate `.proto` file in `schemas/eliza/v1/`
2. Run `buf lint` to validate
3. Run `buf generate` to regenerate code
4. Update any compatibility layers if needed

## Schema Files

| File | Contents |
|------|----------|
| `primitives.proto` | UUID, Content, Media, Metadata |
| `memory.proto` | Memory, MemoryMetadata types |
| `state.proto` | State, ActionPlan, WorkingMemory |
| `environment.proto` | Entity, Room, World, Relationship |
| `components.proto` | Action, Provider, Evaluator |
| `agent.proto` | Character, Agent |
| `service.proto` | Service types |
| `model.proto` | Model types, generation params |
| `events.proto` | Event types and payloads |
| `plugin.proto` | Plugin, Route definitions |
| `task.proto` | Task types |
| `database.proto` | Database, logging types |
| `messaging.proto` | WebSocket, streaming types |
| `ipc.proto` | Cross-language IPC messages |

## Troubleshooting

### Types don't match between languages

Regenerate types: `npm run generate:types`

### Proto lint errors

Check the [Buf Style Guide](https://buf.build/docs/best-practices/style-guide) for naming conventions.

### Missing `@bufbuild/protobuf` module

Install the dependency:
```bash
npm install @bufbuild/protobuf
```

