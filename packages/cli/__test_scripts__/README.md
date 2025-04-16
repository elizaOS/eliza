# Eliza CLI Shell Tests

**Test Coverage Status: Up-to-date as of 2025-04-17**

_All tests use isolated temporary environments and have descriptive names for clarity and maintainability._

This directory contains Bash test scripts that verify the functionality of the `elizaos` CLI commands. These tests ensure that CLI commands work correctly in realistic user scenarios.

## Test Coverage

| Test File          | Command(s) Tested | Test Cases Summary                                                                                                                  |
| ------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `test_agent.bats`  | `elizaos agent`   | Help, list (default/empty), list (API endpoint), start (character from file), stop, full agent lifecycle                            |
| `test_create.bats` | `elizaos create`  | Help, create (default project), create (plugin project), duplicate names, create in current dir, invalid names, invalid types, deps |
| `test_dev.bats`    | `elizaos dev`     | Help, dev server (port/background), server accessibility, API endpoints, agent commands, process cleanup                            |
| `test_env.bats`    | `elizaos env`     | Help, list environment variables from server API                                                                                    |

| `test_plugin.bats` | `elizaos plugin` | TBD (add summary when implemented) |
| `test_project.bats` | `elizaos project` | Help, create project, list projects, list installed plugins, add plugin |
| `test_publish.bats` | `elizaos plugin publish` | Help, validate, pack, publish with auth, bump-version in plugin projects |
| `test_start.bats` | `elizaos start` | Help, (add more tests as implemented) |
| `test_test.bats` | `elizaos test` | Help, run simple test file, fail on error |
| `test_update.bats` | `elizaos update` | TBD (add summary when implemented) |
| `test_update-cli.bats` | `elizaos update-cli` | TBD (add summary when implemented) |

_Note: Plugin installation is now tested via `test_project.bats` using the `elizaos project add-plugin` command. If any test file is present but not yet implemented, its test cases are marked as 'TBD'._

---

## Test Environment Setup Guidelines

To run the Eliza CLI test suite, follow these environment setup instructions:

### Prerequisites

- **Node.js** (v18 or newer recommended)
- **bun** (for running the CLI and installing dependencies)
- **bats-core** (Bash Automated Testing System)
  - Install via Homebrew: `brew install bats-core`
  - Or see: https://github.com/bats-core/bats-core
- **git** (for project and plugin creation tests)

### Installing Project Dependencies

1. From the repository root, install dependencies with bun:
   ```bash
   bun install
   ```
2. Ensure the CLI is built:
   ```bash
   bun run build
   ```

### Environment Variables

- No special environment variables are required by default. The test scripts will set up isolated temporary directories and required variables automatically.
- If you want to override the port for the test server, set `ELIZA_TEST_PORT` before running tests.

### Running Tests

- **Run all tests:**
  ```bash
  ./run_all_bats.sh
  ```
- **Run a specific test script:**
  ```bash
  bats test_agent.bats
  # or
  bats test_publish.bats
  ```

### Troubleshooting

- **bun or node not found:** Ensure both are installed and available in your `PATH`.
- **bats: command not found:** Install `bats-core` as described above.
- **Permission denied:** Make sure scripts are executable: `chmod +x *.bats *.sh`.
- **Test failures due to missing build:** Run `bun run build` before testing.
- **Port conflicts:** If the test server fails to start, another process may be using the port. Set `ELIZA_TEST_PORT` to a free port.
- **Test pollution:** All tests should run in isolated temp directories. If you see pollution, check for accidental use of the project root in tests.

---

## How the Test Suite Works

The Eliza CLI test suite is designed for reliability, reproducibility, and easy debugging. Here’s how the full flow works:

1. **Test Runner Script (`run_all_bats.sh`)**

   - This script is the entry point for running all CLI tests.
   - It sets up the environment, verifies dependencies, and ensures a clean start.
   - It starts a dedicated test server (in the background) on a configurable port and waits for it to become available via a health check.
   - It then discovers and runs each `*.bats` test file in sequence, reporting progress and results for each.

2. **Test Script Execution**

   - Each test script runs in its own isolated temporary directory, created at the start and cleaned up at the end.
   - The test scripts set up any required environment variables and use helper functions for assertions and logging.
   - Each test case is named and described for clear reporting.
   - All commands (e.g., `elizaos create`, `elizaos agent`, etc.) are run as if by a real user, simulating actual CLI usage.

3. **Server and Asset Management**

   - The test server loads character assets from the `test-characters` directory for agent-related tests.
   - Server health is checked before tests begin to avoid race conditions.
   - Server is stopped and cleaned up after all tests complete.

4. **Result Collection and Reporting**

   - The runner script collects the results from each test file, showing a summary (total, passed, failed) at the end.
   - If any test fails, it is clearly reported, and the script exits with a non-zero status code.
   - Debug output is included for failed commands to aid troubleshooting.

5. **Cleanup**
   - All temporary directories and files created during the tests are removed.
   - The test server and any background processes are stopped.

### Key Features

- **Isolation:** Every test runs in a fresh temp directory, preventing pollution and ensuring repeatability.
- **Descriptive Output:** Test names and comments make it easy to see what is being tested and why a failure occurred.
- **Extensibility:** New test scripts can be added easily by following the existing structure.
- **Troubleshooting:** Failures are reported with context, and setup issues (like missing dependencies or port conflicts) are caught early.

---

### Improvements Summary

- All test scripts now use isolated temporary directories for each test, ensuring clean environments and no cross-test pollution.
- Test names and descriptions are explicit and descriptive, making test output easy to interpret.
- The suite is easier to maintain and extend, with a consistent structure across all .bats files.
- This README is kept up to date with the current state of the test suite. If you add a new test file, please update this table accordingly.
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
