# ElizaOS Testing Command

Run comprehensive ElizaOS testing workflow.

**Target:** $ARGUMENTS (default: all tests)

## Pre-Test Setup
1. **Environment Validation**
   - Verify Bun runtime installation
   - Check Vitest framework availability
   - Validate package dependencies
   - Ensure no conflicting vitest instances

2. **Code Validation**
   - Check TypeScript compilation
   - Validate no circular dependencies on @elizaos/core
   - Ensure correct import patterns (@elizaos/core vs packages/core)
   - Verify test file structure

## Test Execution
3. **Component Tests**
   - Run `elizaos test component`
   - Validate individual component isolation
   - Check test coverage
   - Report component test results

4. **E2E Tests**
   - Run `elizaos test e2e`
   - Test real runtime integrations
   - Validate agent workflows and service interactions
   - Report e2e test results

5. **Full Test Suite**
   - Run `elizaos test all` (default)
   - Comprehensive system validation

## Quality Checks
- All tests must pass
- No vitest state conflicts with elizaos runtime
- Test coverage meets requirements
- No stubs in tested code

## Commands to Execute
- For component tests: `elizaos test component`
- For e2e tests: `elizaos test e2e` 
- For all tests: `elizaos test all`
