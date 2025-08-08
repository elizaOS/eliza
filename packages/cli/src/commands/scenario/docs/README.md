# ElizaOS Scenario Testing Guide

This guide covers the scenario testing functionality implemented through tickets [#5573-#5579](https://github.com/elizaOS/eliza/issues?q=is%3Aissue%20%20label%3A%22Reality%20Spiral%22).

## Overview

Scenarios allow you to test ElizaOS agents in both local and sandboxed environments. Each scenario is defined in YAML and can include:
- Environment setup
- Mock service responses
- Action tracking
- Evaluation criteria
- Final judgment rules

## Work in Progress

The scenario system is currently being expanded with several improvements:

1. **ElizaOS-Specific Scenarios**
   - Adding specialized scenarios for ElizaOS plugin-specific functionality and more complex projects
2. **New Evaluators**
   - Implementing `TrajectoryContainsActionEvaluator` for testing action sequences
   - Verify specific actions occur in expected order
   - Track complex multi-step agent behaviors
   - Support for action parameter validation

3. **Infrastructure Improvements**
   - Optimizing database initialization
   - Implementing dynamic plugin loading with better error handling
   - Enhancing test isolation and cleanup
   - Improved error reporting for failed evaluations
   - Removing hardcoded initial plugins for better flexibility
   - Generalizing sandbox environment support beyond E2B

## Demo Videos

- https://drive.google.com/file/d/19oo2V_NfKZCJHuAdcRN3c2l2iTiXiWzd/view?usp=sharing
- https://drive.google.com/file/d/1fkKx8zphsDZpB8QrHy1F7oKnntqs6-0b/view?usp=sharing
- https://drive.google.com/file/d/1uUhCCqjCdcCv9mQS5CQrkj-mXOO4nC3z/view?usp=sharing
- https://drive.google.com/file/d/1OquQX7rn77iOH-njjU68k7KzjxsOtvWx/view?usp=sharing

## Available Scenario Types

### 1. Local Environment Tests
```bash
# Run a simple local test
bun run src/index.ts scenario run src/commands/scenario/examples/simple-test.scenario.yaml

# Run action tracking test
bun run src/index.ts scenario run src/commands/scenario/examples/action-tracking-test.scenario.yaml

# Run evaluation test
bun run src/index.ts scenario run src/commands/scenario/examples/evaluation-test.scenario.yaml
```

### 2. E2B Sandboxed Tests
```bash
# Run E2B environment test
bun run src/index.ts scenario run src/commands/scenario/examples/e2b-test.scenario.yaml

# Run E2B fallback test
bun run src/index.ts scenario run src/commands/scenario/examples/e2b-fallback.scenario.yaml

# Run mock E2B test
bun run src/index.ts scenario run src/commands/scenario/examples/mock-e2b-test.scenario.yaml
```

### 3. Mock Service Tests
```bash
# Run simple mock test
bun run src/index.ts scenario run src/commands/scenario/examples/simple-mock-test.scenario.yaml

# Run full mock test
bun run src/index.ts scenario run src/commands/scenario/examples/mock-test.scenario.yaml
```

### 4. LLM Judge Tests
```bash
# Run LLM judgment test
bun run src/index.ts scenario run src/commands/scenario/examples/llm-judge-test.scenario.yaml

# Run LLM judgment failure test
bun run src/index.ts scenario run src/commands/scenario/examples/llm-judge-failure-test.scenario.yaml
```

### 5. Other Test Types
```bash
# Run multi-step scenario
bun run src/index.ts scenario run src/commands/scenario/examples/multi-step.scenario.yaml

# Run mixed results test
bun run src/index.ts scenario run src/commands/scenario/examples/mixed-results.scenario.yaml

# Run trajectory test
bun run src/index.ts scenario run src/commands/scenario/examples/trajectory-test.scenario.yaml
```

> Note: Once this is merged into develop the CLI command will be installed globally, so you can use `elizaos scenario run` instead of `bun run src/index.ts scenario run`

> **Future**: Once the ElizaOS CLI is published, you'll be able to use `elizaos scenario run <file>` directly without the `bun run src/index.ts` prefix.

## Running All Scenarios

To run all scenarios in sequence:
```bash
cd packages/cli
bun run test:scenarios
```

## Environment Setup

1. Required environment variables:
```env
E2B_API_KEY=your_key_here  # Required for E2B tests
OPENAI_API_KEY=your_key_here  # Required for LLM judge tests
```

2. Local development setup:
```bash
cd packages/cli
bun install
bun x tsup  # Build the CLI
```

3. Verify setup:
```bash
# Test that the CLI builds correctly
bun run src/index.ts --help

# Test a simple scenario
bun run src/index.ts scenario run src/commands/scenario/examples/simple-test.scenario.yaml
```

## Scenario File Structure

```yaml
name: "Test Name"
description: "Test Description"
environment:
  type: "local" # or "e2b"
  setup:
    # Environment-specific setup
mocks:
  - service: "ServiceName"
    method: "methodName"
    response: { }
evaluators:
  - type: "action-tracking"
    config: { }
  - type: "llm-judge"
    config: { }
steps:
  - input: "User input"
    expected: "Expected response"
```

### Example Scenario

```yaml
name: "Simple File Creation Test"
description: "Tests basic file creation in local environment"
environment:
  type: "e2b"
  setup:
    workingDirectory: "/tmp/test"
mocks:
  - service: "FileService"
    method: "createFile"
    response:
      success: true
      path: "/tmp/test/example.txt"
evaluators:
  - type: "action-tracking"
    config:
      requiredActions: ["createFile"]
steps:
  - input: "Create a file called example.txt"
    expected: "I'll create that file for you"
```

## Implementation Details

The scenario system is built on several key components:

1. **YAML Parser** ([#5574](https://github.com/elizaOS/eliza/issues/5574))
   - Validates scenario file structure
   - Provides type-safe scenario configuration

2. **Environment Providers**
   - Local ([#5575](https://github.com/elizaOS/eliza/issues/5575))
   - E2B Sandbox ([#5576](https://github.com/elizaOS/eliza/issues/5576))

3. **Mock Engine** ([#5577](https://github.com/elizaOS/eliza/issues/5577))
   - Service call interception
   - Response mocking

4. **Evaluation Engine** ([#5578](https://github.com/elizaOS/eliza/issues/5578))
   - Action tracking
   - Response validation
   - Trajectory analysis

5. **Final Judgment** ([#5579](https://github.com/elizaOS/eliza/issues/5579))
   - LLM-based judgment
   - User-facing reports

## Common Issues

1. **E2B Hanging**: If E2B tests hang, check:
   - E2B_API_KEY is set correctly
   - Network connectivity
   - E2B service status
   - Plugin loading issues (check logs for plugin loading steps)
   - Database initialization problems

2. **Mock Failures**: For mock test failures:
   - Verify mock service name matches exactly
   - Check response format matches service expectations
   - Ensure all required methods are mocked

3. **Evaluation Failures**: For evaluation issues:
   - Check evaluator configuration
   - Verify expected responses match format
   - Review action tracking configuration

## Contributing

When adding new scenarios:
1. Place YAML files in `src/commands/scenario/examples/`
2. Follow existing naming conventions
3. Include comprehensive descriptions
4. Add to this documentation

## References

- [CLI Command Implementation](https://github.com/elizaOS/eliza/issues/5573)
- [YAML Parser](https://github.com/elizaOS/eliza/issues/5574)
- [Local Environment](https://github.com/elizaOS/eliza/issues/5575)
- [E2B Integration](https://github.com/elizaOS/eliza/issues/5576)
- [Mock Engine](https://github.com/elizaOS/eliza/issues/5577)
- [Evaluation Engine](https://github.com/elizaOS/eliza/issues/5578)
- [Final Judgment](https://github.com/elizaOS/eliza/issues/5579)