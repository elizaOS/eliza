# ElizaOS V2 Development Rules for Windsurf

## Project Overview

ElizaOS V2 is the enhanced multi-agent development framework with cross-platform presence, unified blockchain management, and autonomous workflows. Built with TypeScript and Bun runtime.

Repository: https://github.com/elizaos/eliza

## Package Structure

- `packages/core` - @elizaos/core - The runtime and types foundation
- `packages/client` - Frontend GUI displayed by CLI
- `packages/app` - Desktop/mobile application built in Tauri
- `packages/cli` - CLI containing agent runtime, REST API, GUI launcher
  - Primary entry point for `bun run test` and `bun run start`
  - Contains the `elizaos` command
- `packages/plugin-bootstrap` - Default event handlers, actions, providers
- `packages/plugin-sql` - DatabaseAdapter for Postgres and PGLite

## Core Development Principles

### 1. Flow - Always Plan First

**Bug Fixes Process:**
- First identify the bug completely
- Research ALL related files and dependencies
- Create complete change plan with impact analysis
- Document thorough PRD and implementation plan BEFORE coding
- Identify risks and offer multiple approaches
- Choose best approach and implement immediately

**Key Rule:** Once planning is complete, start coding without waiting for user response.

### 2. No Stubs or Incomplete Code

**Strict Requirements:**
- Never use stubs, fake code, or incomplete implementations
- Continue writing until ALL stubs are replaced with working code
- No proof-of-concepts - only finished, production-ready code
- Iterate on files until perfect, testing and fixing until all tests pass

### 3. Test-Driven Development

**Critical Requirements:**
- Models hallucinate frequently - thorough testing is essential
- Verify tests are complete and passing before declaring changes correct
- First attempts are usually incorrect - test extensively
- Write tests before implementation when possible

## Technology Stack

**Runtime:** Bun (required)
**Language:** TypeScript (all code)
**Testing:** Vitest framework
**ORM:** Drizzle with IDatabaseAdapter interface
**Database:** PostgreSQL (production), PGLite (development)

## Architecture Constraints

### Core Dependencies
- Everything depends on @elizaos/core or packages/core
- NO circular dependencies allowed
- Core cannot depend on other packages
- Import pattern: @elizaos/core in packages, packages/core internally

### Key Files
- `packages/core/src/types.ts` - All core type definitions
- `packages/core/src/runtime.ts` - Main runtime implementation
- Plugin compatibility through /specs (defaulting to v2)

## Code Quality Standards

**Required Standards:**
- TypeScript for all code
- Comprehensive error handling
- Clear separation of concerns
- Follow existing codebase patterns
- Descriptive variable and function names
- Comment complex logic only
- Never omit code or use "// ..." placeholders

## Critical Notes

- Agent perspective is key for all abstractions
- Memory system uses deterministic UUID generation
- Each agent has unique UUID set for same world/rooms
- All components integrate through runtime
- Services handle state management
- Actions drive agent behavior
- Providers supply context
- Evaluators enable learning and reflection
