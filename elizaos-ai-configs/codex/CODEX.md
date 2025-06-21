# ElizaOS Development with OpenAI Codex

## Project Overview

ElizaOS V2: Multi-agent framework with cross-platform presence, blockchain management, autonomous workflows.

**Repository:** https://github.com/elizaos/eliza
**Runtime:** Bun (required - not Node.js)
**Language:** TypeScript (all code)
**Testing:** Vitest framework with elizaos commands
**Database:** Drizzle ORM with PostgreSQL/PGLite

## Core Development Methodology

### 1. Flow - Always Plan First
- Research ALL related files before writing code
- Create complete change plan with impact analysis
- Document thorough implementation plan BEFORE coding
- Once planning complete, implement immediately
- Never proceed without understanding full scope

### 2. No Stubs or Incomplete Code
**CRITICAL:** Never generate stubs, fake code, or incomplete implementations
- Continue until ALL stubs replaced with finished code
- No proof-of-concepts - only production-ready code
- Iterate until perfect, ensuring all tests pass

### 3. Test-Driven Development
- Models hallucinate - thorough testing essential
- Write tests before implementation when possible
- All tests must pass before declaring changes correct
- Use `elizaos test component`, `elizaos test e2e`, `elizaos test all`

## Package Architecture

```
packages/core          - @elizaos/core (runtime and types) 
packages/client         - Frontend GUI displayed by CLI
packages/app           - Desktop/mobile Tauri application
packages/cli           - CLI with agent runtime, REST API, GUI
packages/plugin-bootstrap - Default handlers, actions, providers
packages/plugin-sql     - Database adapters
```

**CRITICAL DEPENDENCY RULES:**
- Everything depends on @elizaos/core - NO circular dependencies
- Core cannot depend on other packages
- Use @elizaos/core in packages, packages/core internally
- Validate dependency patterns before implementing

## Component Specifications

### Actions
- Purpose: Define agent capabilities and response mechanisms
- Decision Flow: Message → Agent evaluation → LLM → Handler response
- Required: validation(), handler(), examples[], name, similes[]
- Handler must include "thought" component

### Providers  
- Purpose: Supply dynamic contextual information (agent's "senses")
- Required: get() method returning formatted context
- Execute during or before action execution
- Bridge external systems to agent context

### Evaluators
- Purpose: Post-interaction cognitive processing
- Required: evaluate(), handler() methods
- Execute after response generation with AgentRuntime
- Handle knowledge extraction, relationship tracking

### Tasks
- Purpose: Manage deferred, scheduled, interactive operations
- Required: execute(), validation() methods
- Handle queued work, repeated actions, user input workflows

### Services
- Purpose: Enable agent interaction with external platforms
- Access pattern: getService(serviceName)
- Maintain system state, support service-to-service calls

## Architecture Abstractions

### Channel → Room Mapping
- Discord/Twitter/GUI channels become "rooms"
- IDs swizzled with agent UUID for deterministic consistency
- Agent perspective key for all abstractions

### Server → World Mapping
- Servers become "worlds" in agent memory
- Some connectors may use "world" on both sides
- Maintain agent-centric view of all abstractions

## Testing Requirements

**Commands:**
- `elizaos test component` - Component tests with Vitest
- `elizaos test e2e` - End-to-end runtime tests  
- `elizaos test all` - Complete test suite (default)

**Test Types:**
- Component tests: Use vitest, test in isolation
- E2E tests: Use actual runtime, no vitest state conflicts
- Integration tests: Test real workflows and interactions

## Code Standards

- TypeScript for all code with comprehensive types
- Comprehensive error handling required
- Descriptive variable and function names
- Comment complex logic only, never change notes
- Follow existing ElizaOS codebase patterns
- Never omit code or use "// ..." placeholders

## Quality Gates

Before considering any task complete:
- All tests pass (component + e2e + integration)
- No stubs or incomplete implementations remain
- No circular dependencies introduced
- TypeScript compilation successful
- Comprehensive error handling implemented
- Agent perspective maintained in abstractions
- Code follows existing patterns and conventions
