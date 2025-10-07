# E2E Tests for Project Starter

This directory contains end-to-end tests for the ElizaOS project starter template.

## ElizaOS Testing Philosophy

ElizaOS employs a dual testing strategy:

1. **Component Tests** (`src/__tests__/*.test.ts`)

   - Run with Bun's native test runner
   - Fast, isolated tests using mocks
   - Perfect for TDD and component logic
   - Command: `bun test`

2. **E2E Tests** (`src/__tests__/e2e/*.e2e.ts`)
   - Run with ElizaOS custom test runner
   - Real runtime with actual database (PGLite)
   - Test complete user scenarios
   - Command: `elizaos test --type e2e`

## Overview

E2E tests run in a real ElizaOS runtime environment, allowing you to test your project's behavior as it would work in production. Unlike component tests, E2E tests provide access to a fully initialized runtime with all services, actions, and providers available.

## Test Structure

- **ProjectStarterTestSuite** - Main test suite containing comprehensive e2e tests:
  - **Core Project Tests**
    - `project_should_initialize_correctly` - Verifies project and runtime initialization
    - `character_should_be_loaded_correctly` - Validates all character configuration fields
  - **Natural Language Processing Tests**
    - `agent_should_respond_to_greeting` - Tests basic greeting interactions
    - `agent_should_respond_to_hello_world` - Validates specific hello world response
    - `agent_should_respond_to_casual_greetings` - Tests various casual greeting formats
    - `agent_should_maintain_conversation_context` - Validates context retention
  - **Action & Provider Tests**
    - `hello_world_action_direct_execution` - Tests direct action execution
    - `hello_world_provider_test` - Validates provider functionality
  - **Service & System Tests**
    - `starter_service_test` - Tests service lifecycle and configuration
    - `memory_system_should_store_and_retrieve_messages` - Tests memory persistence
    - `agent_should_handle_multiple_concurrent_messages` - Tests concurrent processing
    - `project_configuration_should_be_valid` - Validates project configuration
    - `plugin_initialization_test` - Tests plugin system integration

## Integration with Project

E2E tests are integrated directly into your project through the main index.ts file:

```typescript
// src/index.ts
import { ProjectStarterTestSuite } from './__tests__/e2e/project-starter.e2e';

export const project: Project = {
  agents: [projectAgent],
  tests: [ProjectStarterTestSuite], // Direct import!
};
```

## Running Tests

```bash
# Run all tests (component + e2e)
elizaos test

# Run only e2e tests (slower, full integration)
elizaos test --type e2e

# Run only component tests (fast, for TDD)
bun test
# or
elizaos test --type component
```

## Implementation Details

1. **Direct Import**: Tests are imported directly from the e2e test file - no intermediate export file needed
2. **Project Integration**: The test suite is added to the project's `tests` array
3. **Test Discovery**: The ElizaOS test runner automatically finds and executes tests from the project's `tests` array
4. **Runtime Access**: Each test receives a real runtime instance with full access to:
   - Agent character configuration
   - Database and model access
   - All registered plugins and services
   - Memory and conversation history

## Key Differences from Plugin Tests

- **Export Location**: Tests are exported from the `ProjectAgent` in `src/index.ts` (not directly from `Project`)
- **Test Focus**: Tests focus on agent behavior and character configuration rather than plugin functionality
- **Project Context**: Tests have access to the full project configuration including character settings

## Writing New Tests

See the comprehensive documentation at the top of `project-starter.e2e.ts` for detailed instructions on adding new tests.

## Best Practices

1. **Test User Journeys**: Focus on complete user interactions with the agent
2. **Character Validation**: Ensure character properties affect agent behavior as expected
3. **Context Testing**: Verify the agent maintains context across conversations
4. **Concurrent Operations**: Test how the agent handles multiple simultaneous requests
5. **Configuration Validation**: Ensure all required settings are properly loaded
