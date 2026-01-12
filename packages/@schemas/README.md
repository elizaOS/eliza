# elizaOS Protocol Buffer Schemas

This directory contains the **single source of truth** for all elizaOS types. These Protocol Buffer schemas are compiled to generate type definitions for TypeScript, Python, and Rust.

## Architecture

```
schemas/
├── buf.yaml              # Buf module configuration
├── buf.gen.yaml          # Code generation configuration
├── eliza/v1/             # Proto definitions (versioned)
│   ├── primitives.proto  # UUID, Content, Media, Metadata
│   ├── memory.proto      # Memory, MemoryMetadata
│   ├── state.proto       # State, ActionPlan, WorkingMemory
│   ├── environment.proto # Entity, Room, World, Relationship
│   ├── components.proto  # Action, Provider, Evaluator
│   ├── agent.proto       # Character, Agent
│   ├── service.proto     # Service types
│   ├── model.proto       # Model types, generation params
│   ├── events.proto      # Event types and payloads
│   ├── plugin.proto      # Plugin, Route definitions
│   ├── task.proto        # Task types
│   ├── database.proto    # Database, logging types
│   ├── messaging.proto   # WebSocket, streaming types
│   └── ipc.proto         # Cross-language IPC messages
└── README.md

Generated output:
├── packages/typescript/src/types/generated/  # TypeScript
├── packages/python/elizaos/types/generated/  # Python
└── packages/rust/src/types/generated/        # Rust
```

## Quick Start

### Prerequisites

Install Buf CLI:

```bash
# macOS
brew install bufbuild/buf/buf

# Linux
curl -sSL "https://github.com/bufbuild/buf/releases/latest/download/buf-$(uname -s)-$(uname -m)" -o /usr/local/bin/buf
chmod +x /usr/local/bin/buf

# npm (cross-platform)
npm install -g @bufbuild/buf
```

### Generate Types

```bash
# From the schemas directory
cd schemas

# Lint proto files
buf lint

# Generate code for all languages
buf generate

# Or use the npm script from project root
npm run generate:types
```

### Development Workflow

1. **Edit proto files** in `eliza/v1/`
2. **Run `buf lint`** to check for errors
3. **Run `buf generate`** to regenerate types
4. **Commit both** proto changes and generated code

## Schema Design Principles

### 1. Versioning

All schemas are under `eliza/v1/`. When breaking changes are needed, create `eliza/v2/` and maintain both during migration.

### 2. JSON Compatibility

Proto3 has first-class JSON mapping. All messages can be serialized to JSON for debugging:

- `snake_case` in proto → `camelCase` in JSON (automatic)
- Use `google.protobuf.Struct` for dynamic/unknown fields

### 3. Optional Fields

Use `optional` keyword for fields that may not be present:

```protobuf
message Memory {
  optional string id = 1;      // Optional on creation
  string entity_id = 2;        // Always required
}
```

### 4. Enums

Always include `UNSPECIFIED = 0` as the first enum value:

```protobuf
enum MemoryType {
  MEMORY_TYPE_UNSPECIFIED = 0;
  MEMORY_TYPE_DOCUMENT = 1;
  MEMORY_TYPE_MESSAGE = 2;
}
```

### 5. Dynamic Properties

Use `google.protobuf.Struct` for JSON-like dynamic data:

```protobuf
import "google/protobuf/struct.proto";

message Content {
  string text = 1;
  google.protobuf.Struct data = 2;  // Dynamic properties
}
```

## Language-Specific Notes

### TypeScript

- Generated with `@bufbuild/protobuf`
- Import from `@elizaos/core/types/generated`
- Full TypeScript types with proper inference

### Python

- Generated with `betterproto` for clean, Pythonic code
- Dataclass-style types with type hints
- Import from `elizaos.types.generated`

### Rust

- Generated with `prost` (WASM-compatible)
- Includes `serde` support for JSON serialization
- Import from `elizaos::types::generated`

## Adding New Types

1. Create or edit a `.proto` file in `eliza/v1/`
2. Follow naming conventions:
   - Messages: `PascalCase`
   - Fields: `snake_case`
   - Enums: `SCREAMING_SNAKE_CASE`
   - Enum values: `ENUM_NAME_VALUE_NAME`
3. Run `buf lint` to validate
4. Run `buf generate` to create code
5. Update imports in consuming code

## Migration from Manual Types

The generated types replace the manual type definitions in:

- `packages/typescript/src/types/*.ts`
- `packages/python/elizaos/types/*.py`
- `packages/rust/src/types/*.rs`

### Compatibility Layer

During migration, a compatibility layer re-exports generated types with the original names. This allows gradual migration:

```typescript
// packages/typescript/src/types/index.ts
export * from "./generated";
export { Memory as MemoryType } from "./generated/eliza/v1/memory_pb";
```

## Buf Commands Reference

```bash
# Lint proto files
buf lint

# Check for breaking changes
buf breaking --against '.git#branch=main'

# Generate code
buf generate

# Update dependencies
buf dep update

# Format proto files
buf format -w
```

## Resources

- [Buf Documentation](https://buf.build/docs)
- [Protocol Buffers Language Guide](https://protobuf.dev/programming-guides/proto3/)
- [bufbuild/protobuf-es](https://github.com/bufbuild/protobuf-es) (TypeScript)
- [danielgtaylor/python-betterproto](https://github.com/danielgtaylor/python-betterproto) (Python)
- [tokio-rs/prost](https://github.com/tokio-rs/prost) (Rust)
