# Eliza CLI Shell Tests

This directory contains Bash test scripts that verify the functionality of the `elizaos` CLI commands. These tests ensure that CLI commands work correctly in realistic user scenarios.

## Test Coverage

| Test File            | Command(s) Tested                                  | Test Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test_agent.sh`      | `elizaos agent`                                    | • **Test 1**: `agent --help` - Verifies help command displays usage info<br>• **Test 2**: `agent list` - Checks agent list with empty/default agents<br>• **Test 3**: `agent list` - Verifies server API endpoint works<br>• **Test 4**: `agent start --path <character_file>` - Tests character loading from file<br>• **Test 5**: `agent stop <agent_name>` - Tests agent stopping functionality<br>• **Test 6**: Agent lifecycle management                                                                                                  |
| `test_create.sh`     | `elizaos create`                                   | • **Test 1**: `create --help` - Verifies help command displays usage info<br>• **Test 2**: `create <name> --yes` - Tests default project creation<br>• **Test 3**: `create <name> --yes --type plugin` - Tests plugin project creation<br>• **Test 4**: Tests handling duplicate project names<br>• **Test 5**: `create .` - Tests creation in current directory<br>• **Test 6**: Tests handling invalid project names with spaces<br>• **Test 7**: Tests handling non-existent project types<br>• **Test 8**: Verifies dependency installation |
| `test_dev.sh`        | `elizaos dev`                                      | • **Test 1**: `dev --help` - Verifies help command displays usage info<br>• **Test 2**: `dev --port <port>` - Tests running dev server as background process<br>• **Test 3**: Tests server accessibility on specified port<br>• **Test 4**: Tests interacting with server API endpoints<br>• **Test 5**: Tests agent commands against dev server<br>• **Test 6**: Tests server process cleanup                                                                                                                                                  |
| `test_env.sh`        | `elizaos env`                                      | • **Test 1**: `env --help` - Verifies help command displays usage info<br>• **Test 2**: `env list` - Tests listing environment variables from server API                                                                                                                                                                                                                                                                                                                                                                                        |
| `test_install.sh`    | `elizaos install`                                  | • **Test 1**: `install --help` - Verifies help command displays usage info<br>• **Test 2**: Tests package dependency installation in projects<br>• **Test 3**: Tests package manager integration                                                                                                                                                                                                                                                                                                                                                |
| `test_plugin.sh`     | `elizaos plugin` /<br>`elizaos project add-plugin` | • **Test 1**: `plugin --help` - Verifies help command displays usage info<br>• **Test 2**: `plugin publish --help` - Tests plugin publish help command<br>• **Test 3**: `project add-plugin <plugin-name> --no-env-prompt` - Tests adding official plugins<br>• **Test 4**: Tests adding multiple plugins at once<br>• **Test 5**: Tests plugin dependency detection in package.json<br>• **Test 6**: Tests custom plugin installation<br>• **Test 7**: Tests custom plugin via GitHub URL                                                      |
| `test_project.sh`    | `elizaos project`                                  | • **Test 1**: `project --help` - Verifies help command displays usage info<br>• **Test 2**: `project create` - Tests project creation<br>• **Test 3**: `project installed-plugins` - Verifies listing installed plugins<br>• **Test 4**: `project add-plugin` - Tests adding plugins to existing projects<br>• **Test 5**: `project remove-plugin` - Tests removing plugins<br>• **Test 6**: Tests package.json modifications                                                                                                                   |
| `test_publish.sh`    | `elizaos plugin publish`                           | • **Test 1**: `plugin publish --help` - Verifies help command displays usage info<br>• **Test 2**: Tests plugin validation logic<br>• **Test 3**: Tests plugin packaging<br>• **Test 4**: Tests publication workflow and authentication<br>• **Test 5**: Tests versioning logic                                                                                                                                                                                                                                                                 |
| `test_start.sh`      | `elizaos start`                                    | • **Test 1**: `start --help` - Verifies help command displays usage info<br>• **Test 2**: Tests various runtime modes<br>• **Test 3**: Tests custom port configuration<br>• **Test 4**: Tests configuration validation<br>• **Test 5**: Tests character loading                                                                                                                                                                                                                                                                                 |
| `test_test.sh`       | `elizaos test`                                     | • **Test 1**: `test --help` - Verifies help command displays usage info<br>• **Test 2**: Tests basic test suite execution<br>• **Test 3**: Tests test result validation<br>• **Test 4**: Tests different test filtering options<br>• **Test 5**: Tests error reporting                                                                                                                                                                                                                                                                          |
| `test_update.sh`     | `elizaos update`                                   | • **Test 1**: `update --help` - Verifies help command displays usage info<br>• **Test 2**: Tests plugin update functionality<br>• **Test 3**: Tests project dependency updates<br>• **Test 4**: Tests update failure handling<br>• **Test 5**: Tests selective updating                                                                                                                                                                                                                                                                         |
| `test_update-cli.sh` | `elizaos update-cli`                               | • **Test 1**: `update-cli --help` - Verifies help command displays usage info<br>• **Test 2**: Tests CLI self-update process<br>• **Test 3**: Tests version checking and comparison<br>• **Test 4**: Tests update cancellation                                                                                                                                                                                                                                                                                                                  |

## Running Tests

To run all tests, use the master test script:

```bash
./run_cli_tests.sh
```

To run a specific test:

```bash
./test_<command>.sh
```

## Test Environment and Architecture

The testing system consists of several key components:

### Main Runner Script (`run_cli_tests.sh`)

This script orchestrates the entire test suite:

1. **Server Management**:

   - Starts a test server instance on a configurable port (default: 3000)
   - Loads test character files from `test-characters/` directory
   - Monitors server startup and availability
   - Ensures server cleanup on test completion or failure

2. **Test Execution**:

   - Discovers and runs all `test_*.sh` scripts in sequence
   - Uses timeouts to prevent hanging test scripts (60s default timeout)
   - Captures exit codes and test results
   - Provides detailed logging of each test's execution

3. **Cleanup Operations**:
   - Stops the test server
   - Removes all temporary test directories
   - Manages cleanup of individual test environments

### Setup Script (`setup_test_env.sh`)

This shared utility script provides common functionality for all test scripts:

1. **Environment Preparation**:

   - Creates isolated temporary directories for each test run
   - Locates and validates the ElizaOS executable
   - Sets up environment variables needed by tests
   - Determines optimal command to run ElizaOS (`global` vs `local build`)

2. **Test Utilities**:

   - Logging functions (`log_info`, `log_error`, `log_warning`)
   - Test assertion functions (`assert_success`, `assert_failure`)
   - Output validation (`assert_stdout_contains`, `assert_stderr_contains`)
   - File and directory checks (`assert_file_exists`, `assert_dir_exists`)
   - Command execution wrapper (`run_elizaos`)

3. **Cleanup Functions**:
   - Trap-based cleanup to ensure test directories are removed
   - Project-specific cleanup for node_modules and other large artifacts

### Individual Test Scripts (`test_<command>.sh`)

Each test script follows a consistent structure:

1. **Setup Phase**:

   - Sources `setup_test_env.sh` for common utilities
   - Calls `prepare_test_environment` to create isolated test directory
   - Sets up test-specific variables and requirements

2. **Test Cases**:

   - Each test is clearly labeled with descriptive log messages
   - Commands are executed via `run_elizaos` wrapper
   - Results are validated with various assertion functions
   - Many tests track pass/fail counts for summary reporting

3. **Cleanup and Reporting**:
   - Cleans up test-specific artifacts
   - Reports test summary (total, passed, failed)
   - Returns appropriate exit code based on test results

## Test Workflow

When running the full test suite via `run_cli_tests.sh`:

1. **Dependencies** are verified (bun, node)
2. **Test server** is started in the background with isolated data directory
3. **Server availability** is confirmed via health check endpoint
4. **Test scripts** are executed sequentially with timeouts
5. **Results** are captured and summarized
6. **Cleanup** operations remove all temporary files and stop the server
7. **Exit code** indicates overall test suite success or failure

For individual test scripts:

1. **Test environment** is prepared via `prepare_test_environment`
2. **Test operations** are performed against either the global CLI or a local build
3. **Assertions** verify expected behavior and outputs
4. **Test-specific cleanup** removes artifacts before exit

## Test Character Assets

The `test-characters` directory contains JSON character definition files used by various tests:

- `ada.json`: Ada character configuration
- `max.json`: Max character configuration
- `shaw.json`: Shaw character configuration

These are loaded by the test server and used in agent-related tests.

## Adding New Tests

When adding new tests:

1. Create a new `test_<command>.sh` file based on an existing test
2. Include proper test tracking logic
3. Ensure idempotent execution (clean up after yourself)
4. Add comprehensive assertions
5. Update this README with details about the new tests
