# ElizaOS Claude Code Configuration

## Project Context

ElizaOS V2 is a multi-agent development framework with cross-platform presence, unified blockchain management, and autonomous workflows. This project uses TypeScript, Bun runtime, and follows strict architectural patterns.

## Key Information

**Repository:** https://github.com/elizaos/eliza
**Runtime:** Bun (required - not Node.js)
**Language:** TypeScript (all code)
**Testing:** Vitest framework
**Database:** Drizzle ORM with PostgreSQL/PGLite

## Critical Development Rules

### 1. Flow - Always Plan First
- Research ALL related files before coding
- Create complete change plan with impact analysis
- Document thorough implementation plan BEFORE writing code
- Once planning complete, implement immediately without waiting

### 2. No Stubs or Incomplete Code
- Never use stubs, fake code, or incomplete implementations
- Continue writing until ALL stubs are replaced with working code
- No proof-of-concepts - only finished, production-ready code
- Iterate until all tests pass

### 3. Test-Driven Development
- Models hallucinate frequently - thorough testing is critical
- Write tests before implementation when possible
- All tests must pass before declaring changes correct
- Use `elizaos test` commands (component, e2e, all)

## Package Architecture

```
packages/core          - @elizaos/core (runtime and types)
packages/client         - Frontend GUI
packages/app           - Desktop/mobile Tauri app
packages/cli           - CLI with agent runtime, REST API, GUI
packages/plugin-bootstrap - Default handlers, actions, providers
packages/plugin-sql     - Database adapters
```

## Dependency Rules

**CRITICAL:** Everything depends on @elizaos/core - NO circular dependencies
- Core cannot depend on other packages
- Use @elizaos/core in package code
- Use packages/core in internal references

## Component Types

### Actions
- Define agent capabilities and response mechanisms
- Message → Agent evaluation → LLM decision → Handler response

### Providers
- Supply dynamic contextual information (agent's "senses")
- Inject real-time info, bridge external systems

### Evaluators
- Post-interaction cognitive processing
- Knowledge extraction, relationship tracking, reflection

### Tasks
- Manage deferred, scheduled, interactive operations
- Queue work, repeat actions, await user input

### Services
- Enable AI agents to interact with external platforms
- Maintain system state, accessible via getService()

## Architecture Abstractions

### Channel → Room Mapping
- Discord/Twitter/GUI channels become "rooms"
- IDs swizzled with agent UUID for consistency

### Server → World Mapping
- Servers become "worlds" in agent memory
- Agent perspective key for all abstractions

## Testing Commands

- `elizaos test component` - Component tests with Vitest
- `elizaos test e2e` - End-to-end runtime tests
- `elizaos test all` - Both component and e2e tests (default)

## Code Standards

- TypeScript for all code
- Comprehensive error handling required
- Descriptive variable and function names
- Comment complex logic only
- Never omit code or use "// ..." placeholders

## Claude Code Slash Commands

ElizaOS-specific slash commands are available in the `.claude/commands/` directory:

**Main Commands:**
- `/project:dev` - Full development workflow
- `/project:test` - Comprehensive testing  
- `/project:bugfix` - Bug fixing methodology
- `/project:validate` - Architecture validation
- `/project:review` - Code review standards
- `/project:component` - Generic component creation

**Specialized Commands:**
- `/project:elizaos:action` - Create Actions
- `/project:elizaos:provider` - Create Providers  
- `/project:elizaos:evaluator` - Create Evaluators

See `.claude/COMMANDS.md` for detailed usage examples.
