# Eliza CLI Shell Tests

This directory contains Bash test scripts that verify the functionality of the `elizaos` CLI commands. These tests ensure that CLI commands work correctly in realistic user scenarios.

## Test Coverage

| Test File            | Command(s) Tested                                  | Test Conditions & Options                                                                                                                                                                                                      |
| -------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test_agent.sh`      | `elizaos agent`                                    | • `agent --help`<br>• `agent list`<br>• `agent start --path <character_file>`<br>• `agent stop <agent_name>`<br>• Character file loading & lifecycle management                                                                |
| `test_create.sh`     | `elizaos create`                                   | • `create --help`<br>• `create <name> --yes` (default project)<br>• `create <name> --yes --type plugin`<br>• `create .` (create in current directory)<br>• Edge cases: existing directories, invalid names, non-existent types |
| `test_dev.sh`        | `elizaos dev`                                      | • `dev --help`<br>• `dev --port <port>` (background process)<br>• Server accessibility & API responsiveness<br>• Integration with agent commands against dev server                                                            |
| `test_env.sh`        | `elizaos env`                                      | • `env --help`<br>• `env list`<br>• Environment variable operations against server API                                                                                                                                         |
| `test_install.sh`    | `elizaos install`                                  | • Package dependency installation<br>• Various package manager integration                                                                                                                                                     |
| `test_plugin.sh`     | `elizaos plugin` /<br>`elizaos project add-plugin` | • `plugin --help`<br>• `plugin publish --help`<br>• `project add-plugin <plugin-name> --no-env-prompt`<br>• Multiple plugin installation<br>• Plugin detection in package.json                                                 |
| `test_project.sh`    | `elizaos project`                                  | • `project --help`<br>• `project create`<br>• `project installed-plugins`<br>• `project add-plugin`<br>• `project remove-plugin`<br>• Package.json modifications                                                               |
| `test_publish.sh`    | `elizaos plugin publish`                           | • Plugin validation<br>• Plugin packaging<br>• Publication workflow verification                                                                                                                                               |
| `test_start.sh`      | `elizaos start`                                    | • `start --help`<br>• Various runtime modes<br>• Configuration validation                                                                                                                                                      |
| `test_test.sh`       | `elizaos test`                                     | • `test --help`<br>• Test suite execution<br>• Test result validation                                                                                                                                                          |
| `test_update.sh`     | `elizaos update`                                   | • `update --help`<br>• Plugin updates<br>• Project dependency updates                                                                                                                                                          |
| `test_update-cli.sh` | `elizaos update-cli`                               | • `update-cli --help`<br>• CLI self-update process<br>• Version checking                                                                                                                                                       |

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
