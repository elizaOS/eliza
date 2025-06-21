# ElizaOS CLI Comprehensive Test Coverage

This document outlines the comprehensive test coverage for the ElizaOS CLI, addressing all identified gaps in testing.

## Test Coverage Overview

### 1. Template Tests ✅

- **Project Starter Template**: Test creation and execution of project-starter
- **Plugin Starter Template**: Test creation and execution of plugin-starter
- **End-to-End Validation**: Full lifecycle testing of templates

### 2. Migration Tests 🚧

- **Plugin with Schema**: Create plugins with database schemas
- **Migration Success**: Test successful migration execution
- **Migration Failure**: Handle migration failures gracefully
- **Status**: Pending - requires schema generation feature in CLI

### 3. Context Tests ✅

- **Inside Monorepo**: Test CLI behavior within monorepo structure
- **Outside Monorepo**: Test standalone project creation
- **Global Installation**: Test npm link and global usage scenarios

### 4. Lifecycle Tests ✅

- **Process Start**: Start agents with proper initialization
- **Timeout Management**: Kill processes after specified timeout (20s default)
- **Cleanup Verification**: Ensure all resources are cleaned up
- **Multiple Processes**: Handle multiple agent processes simultaneously

### 5. Failure Tests ✅

- **Modified index.ts**: Test with top 5 lines removed from entry files
- **Missing Dependencies**: Handle missing package dependencies
- **Test Failures**: Ensure proper exit codes on test failures
- **Build Errors**: Handle TypeScript compilation errors

## Test Files Created

### 1. `comprehensive-coverage.bats`

Main comprehensive test suite covering all scenarios:

- 12 test cases covering all identified gaps
- Process management with timeouts
- Failure scenario testing
- Context-aware testing (monorepo vs standalone)

### 2. `quick-verify.bats`

Quick verification test to ensure test infrastructure works:

- CLI binary existence check
- Simple project creation
- Plugin creation

### 3. `run-comprehensive-coverage.sh`

Shell script to run the comprehensive test suite:

- Builds CLI before testing
- Runs with detailed output
- 30-minute timeout for entire suite
- Clear success/failure reporting

## Known Issues and Limitations

### 1. BATS Helper Loading

- BATS helpers require specific loading patterns
- Symlinks created for helper files without `.bash` extension
- Assert functions from bats-assert may not be available in all environments

### 2. Package Installation

- Tests must disable auto-installation to avoid npm registry issues
- Use `ELIZA_NO_AUTO_INSTALL=true` environment variable
- Manual installation testing requires published packages

### 3. Schema/Migration Testing

- CLI doesn't currently support `--with-schema` flag
- Migration testing postponed until feature implementation
- Plugin templates need schema generation capabilities

## Running the Tests

### Prerequisites

```bash
# Install BATS
brew install bats-core  # macOS
# or
npm install -g bats     # Cross-platform

# Install BATS helpers (if not already installed)
cd ../.. # to monorepo root
bun add -d bats-support bats-assert bats-file
```

### Run All Comprehensive Tests

```bash
cd packages/cli
./tests/run-comprehensive-coverage.sh
```

### Run Specific Test Categories

```bash
# Template tests only
bats tests/bats/comprehensive-coverage.bats --filter "template:"

# Context tests only
bats tests/bats/comprehensive-coverage.bats --filter "context:"

# Failure tests only
bats tests/bats/comprehensive-coverage.bats --filter "failure:"
```

### Run Quick Verification

```bash
bats tests/bats/quick-verify.bats
```

## Future Enhancements

1. **Schema Generation**: Add `--with-schema` flag to create command
2. **Migration Runner**: Implement migration execution in CLI
3. **Global Install Testing**: Automated npm link testing
4. **Coverage Reporting**: Integration with code coverage tools
5. **Performance Testing**: Add benchmarks for CLI operations
6. **Cross-Platform Testing**: Ensure tests work on Windows, macOS, and Linux

## Test Maintenance

- Update tests when new CLI features are added
- Run comprehensive tests before major releases
- Add new test cases for bug fixes
- Keep test timeouts reasonable (default 20s for processes)
- Clean up test artifacts properly

## Contributing

When adding new CLI features:

1. Add corresponding test cases to `comprehensive-coverage.bats`
2. Update this documentation
3. Ensure all tests pass before submitting PR
4. Add failure scenarios for new features
