# ElizaOS Development Workflow

Implement "Flow - Always Plan First" methodology for: $ARGUMENTS

## Analysis Phase
1. **Understand Requirements**
   - Analyze task requirements completely
   - Identify affected packages (core, cli, client, app, plugins)
   - Check existing similar implementations
   - Validate Bun runtime and TypeScript compatibility

2. **Research Codebase**
   - Search for related implementations
   - Identify existing patterns to follow
   - Check for circular dependency risks with @elizaos/core
   - Review architecture constraints

3. **Create Implementation Plan**
   - Document thorough approach
   - Identify risks and multiple approaches
   - Plan test strategy (component + e2e)

## Implementation Phase
4. **Validate Architecture**
   - No circular dependencies on @elizaos/core
   - Validate abstractions (Channel→Room, Server→World)
   - Check service architecture compatibility
   - Verify agent perspective consistency

5. **Implement Solution**
   - Write tests FIRST when possible
   - NO stubs or incomplete code
   - Use TypeScript with error handling
   - Follow ElizaOS patterns

6. **Test & Validate**
   - Run `elizaos test component`, `elizaos test e2e`, `elizaos test all`
   - Fix all failing tests immediately
   - Verify no stubs remain

## Quality Gates
- All tests pass, no circular dependencies, TypeScript compiles
- Comprehensive error handling, agent perspective maintained
