# E2E Tests for Project TEE Starter

This directory contains end-to-end tests for the ElizaOS project TEE (Trusted Execution Environment) starter template.

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

E2E tests run in a real ElizaOS runtime environment, allowing you to test your TEE-enabled project's behavior as it would work in production. These tests include validation of TEE-specific functionality such as attestation, secure operations, and cryptographic features.

## Test Structure

- **ProjectTeeStarterTestSuite** - Main test suite containing all e2e tests
  - `tee_project_should_initialize_correctly` - Verifies TEE project and runtime initialization
  - `tee_character_should_be_loaded_correctly` - Checks character configuration including TEE settings
  - `tee_service_should_be_available` - Tests TEE service registration and availability
  - `tee_attestation_action_should_be_registered` - Validates TEE-specific actions
  - `agent_should_respond_with_tee_awareness` - Tests agent's understanding of TEE capabilities
  - `secure_memory_operations_should_work` - Validates secure data handling
  - `tee_plugin_integration_should_work` - Tests TEE plugin integration
  - `concurrent_secure_operations_should_be_handled` - Tests concurrent secure operations
  - `tee_configuration_should_be_valid` - Validates TEE-specific configuration

## Integration with Project

E2E tests are integrated directly into your project through the main index.ts file:

```typescript
// src/index.ts
import { ProjectTeeStarterTestSuite } from './__tests__/e2e/project-tee-starter.e2e';

export const project: Project = {
  agents: [projectAgent],
  tests: [ProjectTeeStarterTestSuite], // Direct import!
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

## TEE-Specific Testing Considerations

### Development Environment

- TEE hardware features may not be available in development
- Tests gracefully handle missing TEE services with warnings
- Mock TEE services can be used for development testing

### Production Environment

- Full TEE capabilities should be available
- Attestation endpoints should be configured
- Secure key storage should be operational

### Configuration

TEE-specific environment variables:

- `TEE_MODE`: Enable/disable TEE mode
- `TEE_ATTESTATION_ENDPOINT`: Attestation service endpoint
- `TEE_PROVIDER`: TEE provider (e.g., 'phala', 'sgx')

## Implementation Details

1. **Direct Import**: Tests are imported directly from the e2e test file
2. **Project Integration**: The test suite is added to the project's `tests` array
3. **TEE Detection**: Tests detect and adapt to TEE availability
4. **Secure Operations**: Tests validate secure data handling and cryptographic operations
5. **Runtime Access**: Each test receives a real runtime instance with full access to:
   - TEE services and attestation
   - Secure memory operations
   - Cryptographic functions
   - All standard ElizaOS features

## Key Differences from Standard Project Tests

- **Export Location**: Tests are exported from the `ProjectAgent` in `src/index.ts` (not directly from `Project`)
- **TEE Service Testing**: Additional tests for TEE service availability
- **Attestation Validation**: Tests for attestation generation and verification
- **Secure Operations**: Validation of secure data handling
- **Hardware Adaptation**: Tests adapt to TEE hardware availability
- **Cryptographic Features**: Testing of signing and verification operations

## Writing New Tests

See the comprehensive documentation at the top of `project-tee-starter.e2e.ts` for detailed instructions on adding new tests.

## Best Practices

1. **Hardware Independence**: Write tests that work with or without TEE hardware
2. **Security Validation**: Test security features without exposing sensitive data
3. **Attestation Mocking**: Use mock attestation in development environments
4. **Error Handling**: Test both successful and failed secure operations
5. **Configuration Testing**: Validate all TEE-specific configuration options

## Known Considerations

- TEE features may require specific hardware or cloud environments
- Some cryptographic operations may be simulated in development
- Attestation verification requires connection to attestation services
- Performance characteristics may differ between TEE and non-TEE environments
