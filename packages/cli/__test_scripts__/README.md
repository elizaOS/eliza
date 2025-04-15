# Eliza CLI Shell Tests

This directory contains Bash test scripts that verify the functionality of the `elizaos` CLI commands. These tests ensure that CLI commands work correctly in realistic user scenarios.

## Test Coverage

| Test File            | Command(s) Tested                                  | Functionality Covered                                                                    |
| -------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `test_agent.sh`      | `elizaos agent`                                    | Creating agents, configuring agent settings, and verifying agent behavior                |
| `test_create.sh`     | `elizaos create`                                   | Creating new projects and plugins with various options and templates                     |
| `test_dev.sh`        | `elizaos dev`                                      | Starting development servers, watching for changes, testing hot reload                   |
| `test_env.sh`        | `elizaos env`                                      | Setting, getting, listing, and removing environment variables at different scopes        |
| `test_install.sh`    | `elizaos install`                                  | Installing dependencies and verifying installation                                       |
| `test_plugin.sh`     | `elizaos plugin` /<br>`elizaos project add-plugin` | Plugin command help, plugin project creation, adding single/multiple plugins to projects |
| `test_project.sh`    | `elizaos project`                                  | Project commands (installed-plugins, add-plugin, remove-plugin, etc.)                    |
| `test_publish.sh`    | `elizaos plugin publish`                           | Plugin publication validation, testing publication workflow                              |
| `test_start.sh`      | `elizaos start`                                    | Starting Eliza apps in various modes                                                     |
| `test_test.sh`       | `elizaos test`                                     | Running test suites, verifying test results                                              |
| `test_update.sh`     | `elizaos update`                                   | Updating plugins and projects                                                            |
| `test_update-cli.sh` | `elizaos update-cli`                               | Updating the Eliza CLI itself                                                            |

## Running Tests

To run all tests, use the master test script:

```bash
./run_cli_tests.sh
```

To run a specific test:

```bash
./test_<command>.sh
```

## Test Environment

The `setup_test_env.sh` script provides common test utilities:

- Test environment preparation
- Temporary directory management
- Command execution and validation
- Success/failure assertions
- File content verification
- Test result tracking

## Test Structure

Each test script follows a common structure:

1. Source the `setup_test_env.sh` script
2. Set up test tracking counters
3. Prepare the test environment
4. Execute individual test cases
5. Report test results
6. Return appropriate exit code

## Adding New Tests

When adding new tests:

1. Create a new `test_<command>.sh` file based on an existing test
2. Include proper test tracking logic
3. Ensure idempotent execution (clean up after yourself)
4. Add comprehensive assertions
5. Update this README

## Test Character Assets

The `test-characters` directory contains assets used by certain tests for character/agent creation and configuration.
