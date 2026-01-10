# @elizaos/plugin-bootstrap

Core Bootstrap Plugin for elizaOS - providing fundamental agent capabilities across TypeScript, Python, and Rust.

## Overview

The Bootstrap Plugin provides the essential building blocks that every elizaOS agent needs to function:

- **Actions**: What the agent can do (REPLY, IGNORE, FOLLOW_ROOM, etc.)
- **Providers**: Context information for the agent (CHARACTER, RECENT_MESSAGES, WORLD, etc.)
- **Evaluators**: Self-assessment capabilities (GOAL, REFLECTION)
- **Services**: Background utilities (Task management, Embedding generation)

## Multi-Language Support

This plugin is implemented in three languages to support the full elizaOS ecosystem:

| Language | Directory | Package Manager | Status |
|----------|-----------|-----------------|--------|
| TypeScript | `typescript/` | npm/bun | ✅ Production |
| Python | `python/` | PyPI | ✅ Production |
| Rust | `rust/` | crates.io | ✅ Production |

## Installation

### TypeScript (npm)

```bash
npm install @elizaos/plugin-bootstrap
# or
bun add @elizaos/plugin-bootstrap
```

### Python (PyPI)

```bash
pip install elizaos-plugin-bootstrap
```

### Rust (crates.io)

```toml
[dependencies]
elizaos-plugin-bootstrap = "2.0.0-alpha.0"
```

## Usage

### TypeScript

```typescript
import { bootstrapPlugin } from '@elizaos/plugin-bootstrap';

// Register with the agent runtime
runtime.registerPlugin(bootstrapPlugin);
```

### Python

```python
from elizaos_plugin_bootstrap import bootstrap_plugin

# Register with the agent runtime
await runtime.register_plugin(bootstrap_plugin)
```

### Rust

```rust
use elizaos_plugin_bootstrap::BootstrapPlugin;

let plugin = BootstrapPlugin::new();
runtime.register_plugin(plugin).await?;
```

## Components

### Actions (13 total)

| Action | Description |
|--------|-------------|
| `REPLY` | Generate and send a response message |
| `IGNORE` | Ignore the current message |
| `NONE` | Take no action, continue processing |
| `CHOOSE_OPTION` | Select from available options |
| `FOLLOW_ROOM` | Follow a room for updates |
| `UNFOLLOW_ROOM` | Stop following a room |
| `MUTE_ROOM` | Mute notifications from a room |
| `UNMUTE_ROOM` | Unmute a room |
| `GENERATE_IMAGE` | Generate images using AI models |
| `UPDATE_ROLE` | Update entity roles |
| `UPDATE_SETTINGS` | Modify agent settings |
| `SEND_MESSAGE` | Send a message to a specific target |
| `UPDATE_ENTITY` | Update entity information |

### Providers (9 total)

| Provider | Description |
|----------|-------------|
| `CHARACTER` | Agent character definition and personality |
| `RECENT_MESSAGES` | Recent conversation history |
| `CURRENT_TIME` | Current time and date information |
| `WORLD` | World context and settings |
| `ENTITIES` | Information about participants |
| `KNOWLEDGE` | Relevant knowledge from the knowledge base |
| `FACTS` | Known facts about entities |
| `ACTION_STATE` | Current action state and available actions |
| `AGENT_SETTINGS` | Agent configuration (filtered for security) |

### Evaluators (2 total)

| Evaluator | Description |
|-----------|-------------|
| `GOAL` | Evaluate progress toward defined goals |
| `REFLECTION` | Reflect on agent behavior and provide feedback |

### Services (2 total)

| Service | Description |
|---------|-------------|
| `TaskService` | Task creation, tracking, and management |
| `EmbeddingService` | Text embedding generation with caching |

## Development

### TypeScript

```bash
cd packages/plugin-bootstrap

# Build
bun run build

# Type check
bun run typecheck

# Lint
bun run lint

# Format
bun run format
```

### Python

```bash
cd packages/plugin-bootstrap/python

# Create virtual environment
python -m venv .venv
source .venv/bin/activate

# Install with dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Type check
mypy elizaos_plugin_bootstrap

# Lint
ruff check elizaos_plugin_bootstrap
```

### Rust

```bash
cd packages/plugin-bootstrap/rust

# Build
cargo build

# Test
cargo test

# Lint
cargo clippy -- -D warnings

# Format
cargo fmt
```

## Architecture

```
plugin-bootstrap/
├── typescript/           # TypeScript implementation
│   ├── actions/         # Action implementations
│   ├── providers/       # Provider implementations
│   ├── evaluators/      # Evaluator implementations
│   ├── services/        # Service implementations
│   └── index.ts         # Main entry point
├── python/              # Python implementation
│   ├── elizaos_plugin_bootstrap/
│   │   ├── actions/
│   │   ├── providers/
│   │   ├── evaluators/
│   │   └── services/
│   ├── tests/
│   └── pyproject.toml
├── rust/                # Rust implementation
│   ├── src/
│   │   ├── actions/
│   │   ├── providers/
│   │   ├── evaluators/
│   │   └── services/
│   ├── tests/
│   └── Cargo.toml
├── package.json         # npm package config
└── README.md           # This file
```

## Design Principles

1. **Strong Types**: All implementations use strict typing with no `any` types or optionals where avoidable.

2. **Fail Fast**: Invalid data is rejected immediately rather than being silently handled.

3. **No Defensive Programming**: We don't catch and swallow errors - failures propagate for proper handling.

4. **Consistent API**: All three implementations expose the same API surface and behavior.

5. **Production Ready**: Complete implementations with real functionality, no stubs or placeholders.

## License

MIT License - see LICENSE file for details.
