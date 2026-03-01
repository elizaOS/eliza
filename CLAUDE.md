# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Build
```bash
bun install                  # Install all dependencies
bun run build                # Build all packages (via Turbo)
bun run build:core           # Build only @elizaos/core (no cache)
bun run generate:types       # Regenerate protobuf types (requires buf CLI)
```

### Test
```bash
bun run test                 # Run all tests (excludes Python)
bun run test:core            # Test packages/typescript only
cd packages/typescript && bunx vitest run src/__tests__/runtime.test.ts  # Single test file
cd packages/python && pytest tests/test_validation.py  # Single Python test
```

### Lint & Typecheck
```bash
bun run lint                 # Lint all packages (Biome for TS, ruff for Python)
bun run typecheck            # Typecheck TypeScript packages
# Python virtual env at .venv_py/ - activate before running Python lint
source .venv_py/bin/activate && cd packages/python && ruff check --fix . && ruff format .
```

## Architecture

This is a bun monorepo using Turbo for build orchestration. The core idea is a polyglot agent runtime: the same agent model is implemented in TypeScript, Python, and (partially) Rust, sharing protobuf schemas for type definitions.

### Package Layout

- **`packages/typescript/`** — `@elizaos/core`: The authoritative TypeScript agent runtime. Everything else derives from this.
- **`packages/python/`** — `@elizaos/python`: Python mirror of the TypeScript runtime API. Mirrors the same class/function structure.
- **`packages/rust/`** — Rust implementation (native + WASM target).
- **`packages/schemas/`** — Protobuf schemas (`eliza/v1/*.proto`) that define the canonical type system. TypeScript types are generated into `packages/typescript/src/types/generated/`, Python types into `packages/python/elizaos/types/generated/`.
- **`packages/elizaos/`** — `elizaos` CLI binary for creating/managing agent projects.
- **`packages/interop/`** — Cross-language plugin interoperability layer.
- **`packages/daemon/`** — Cross-platform daemon/service management (launchd, systemd).
- **`packages/prompts/`** — Prompt templates shared across the runtime.

Build order is enforced by Turbo: `@elizaos/schemas` → `@elizaos/prompts` → `@elizaos/core` → everything else.

### Core Runtime (`packages/typescript/src/`)

**`AgentRuntime`** (`runtime.ts`) is the central class implementing `IAgentRuntime` (which also extends `IDatabaseAdapter`). It manages:
- Plugin registration (`actions`, `providers`, `evaluators`, `services`, `routes`)
- Model invocation via `useModel(modelType, params)` — model types defined in `ModelType` enum
- State composition for LLM prompts via `composeState()`
- Task worker scheduling
- Sandbox mode with secret redaction and SSRF protection

**Plugin System** (`types/plugin.ts`): A `Plugin` is the extension unit — it provides `actions`, `providers`, `evaluators`, `services`, `routes`, and event handlers. Register via `runtime.registerPlugin(plugin)`.

**Bootstrap Plugin** (`bootstrap/index.ts`): The default plugin created by `createBootstrapPlugin()`. Wires up message handling, the core action set (reply, ignore, follow/mute room, send message, image generation, etc.), providers (recentMessages, knowledge, entities, time, facts, etc.), and evaluators (reflection, relationship extraction). This is the central message processing loop.

**Types** (`types/`): All types are defined as TypeScript interfaces that extend or mirror protobuf-generated types from `types/generated/`. Key types:
- `Character` — Agent identity, bio, plugins, settings
- `Action` — Handler + validate + parameters + examples
- `Provider` — `get(runtime, message, state)` → `ProviderValue`
- `Evaluator` — `handler(runtime, message, state)` runs post-response
- `Service` — Long-running service with static `start(runtime)` factory
- `Memory` — A stored memory entry (messages, facts, knowledge)
- `State` — The composed context object passed to LLM prompts

**Services** (`services/`): Specialized long-running services including `EmbeddingGenerationService`, `TaskService`, `ActionFilterService`, `ToolPolicyService`, `ApprovalService`, `TrajectoryLoggerService`, `TriggerSchedulingService`, and others for onboarding, pairing, and voice caching.

**Autonomy** (`autonomy/`): Autonomous agent loop — `AutonomyService` drives self-initiated actions without external messages.

**Security** (`security/`, `network/`): Sandbox mode token manager for obfuscating secrets in LLM prompts; SSRF protection and fetch guard for outbound requests from plugins.

### Protobuf Schemas

All cross-language types are defined in `packages/schemas/eliza/v1/*.proto`. Use `bun run generate:types` (which runs `buf generate`) to regenerate TypeScript and Python bindings after modifying `.proto` files. The buf config is at `packages/schemas/buf.yaml`.

### Python Runtime

`packages/python/elizaos/runtime.py` mirrors `AgentRuntime` from TypeScript with identical method signatures. The Python package uses `pytest` for tests and `ruff` for linting. Python virtual environment lives at `.venv_py/` in the repo root.

### Testing Conventions

- TypeScript tests use **vitest** and live in `src/__tests__/` directories.
- Set `ELIZA_TEST_MODE=true` or `NODE_ENV=test` to disable plugin auto-install during tests.
- Bootstrap plugin tests are in `packages/typescript/src/bootstrap/__tests__/`.
- Integration tests that require a live runtime are in `src/__tests__/integration/`.
