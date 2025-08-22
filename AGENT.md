# ElizaOS Agent Development Guide

## Build/Test Commands

- **Build**: `bun run build` (all packages), `bun run build:core`, `bun run build:cli`, `bun run build:client`
- **Test**: `bun test` (all), `bun run test:core`, `bun run test:client`
- **Single Test**: `bun test src/path/to/file.test.ts` or `cd packages/core && bun test specific.test.ts`
- **Lint**: `bun run lint`, **Format**: `bun run format`, **Type Check**: `cd packages/core && bun run typecheck`
- **Development**: `bun start` (monorepo), `bun run dev` (watch mode)

## Architecture

**Core Dependencies**: @elizaos/core (foundation) → plugins → services. No circular deps.
**Key Packages**: packages/core (types/runtime), packages/cli (elizaos command), packages/client (React UI), packages/server (API), packages/plugin-bootstrap (REQUIRED for message handling), packages/plugin-sql (REQUIRED for database)
**Database**: Drizzle ORM with PGLite (dev) or PostgreSQL (prod)
**Abstractions**: Channel→Room, Server→World, deterministic UUID swizzling per agent

## Code Style

**Language**: TypeScript with comprehensive types. **Package Manager**: bun (NEVER npm/pnpm)
**Process Execution**: Use `Bun.spawn()` or bun-exec utils (packages/cli/src/utils/bun-exec.ts), NEVER Node.js child_process
**Events**: Use EventTarget API, NEVER EventEmitter (Bun compatibility issues)
**Node.js APIs**: NEVER use Node.js specific APIs (child_process, fs, path, etc.) - use Bun equivalents
**Naming**: camelCase (vars/functions), PascalCase (components/interfaces), descriptive names
**Error Handling**: Comprehensive error handling required, no stubs/incomplete code
**Imports**: @elizaos/core in packages, packages/core internally

## Component Types

**Actions**: Handle user commands, return ActionResult, use callback() for messages
**Providers**: Supply read-only context data, no state changes
**Services**: Manage state/external APIs, accessed via runtime.getService()
**Evaluators**: Post-interaction processing, NOT for input parsing
