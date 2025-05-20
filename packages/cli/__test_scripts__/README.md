# Eliza CLI Shell Tests

**Test Coverage Status: Up-to-date as of 2025-04-17**

_All tests use isolated temporary environments and have descriptive names for clarity._

This directory contains Bash test scripts that verify the functionality of the `elizaos` CLI commands in realistic user scenarios.

## Test Coverage

| Test File              | Command(s) Tested         | Test Cases Summary                                                                |
| ---------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| `test_agent.bats`      | `elizaos agent`           | Help, list (default/API), start/stop agent, full agent lifecycle                  |
| `test_create.bats`     | `elizaos create`          | Help, create (project/plugin), duplicate/invalid names/types, deps                |
| `test_dev.bats`        | `elizaos dev`             | Help, dev server (port/background), server/API endpoints, agent commands, cleanup |
| `test_env.bats`        | `elizaos env`             | Help, list environment variables from server API                                  |
| `test_plugin.bats`     | `elizaos plugins`         | TBD (add summary when implemented)                                                |
| `test_project.bats`    | `elizaos project`         | Help, create/list projects, plugins, add plugin                                   |
| `test_publish.bats`    | `elizaos plugins publish` | Help, validate, pack, publish with auth, bump-version in plugin projects          |
| `test_start.bats`      | `elizaos start`           | Help, (add more tests as implemented)                                             |
| `test_test.bats`       | `elizaos test`            | Help, run simple test file, fail on error                                         |
| `test_update.bats`     | `elizaos update`          | TBD (add summary when implemented)                                                |
| `test_update-cli.bats` | `elizaos update-cli`      | TBD (add summary when implemented)                                                |

_Note: Plugin installation is now tested via `test_project.bats` using `elizaos project add-plugin`. If any test file is present but not yet implemented, its test cases are marked as 'TBD.'_.\_

---

## Setup & Running Tests

### Prerequisites

- **Node.js** (v18+ recommended)
- **bun** (for CLI and dependencies)
- **bats-core** ([Install](https://github.com/bats-core/bats-core) or `brew install bats-core`)
- **git** (for project/plugin tests)

### Install & Build

```bash
bun install
bun run build
```

### Running

- **All tests:**
  ```bash
  ./run_all_bats.sh
  ```
- **Single test:**
  ```bash
  bats test_agent.bats
  # or
  bats test_publish.bats
  ```

### Env Variables

- No special env vars needed. To override test server port, set `ELIZA_TEST_PORT`.

### Troubleshooting

- Ensure `bun`, `node`, and `bats-core` are installed and in `PATH`.
- Make scripts executable: `chmod +x *.bats *.sh`.
- If tests fail due to missing build, run `bun run build`.
- For port conflicts, set `ELIZA_TEST_PORT` to a free port.
- All tests run in isolated temp directories; avoid polluting the project root.

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

## Adding New Tests

1. Copy an existing `test_<command>.bats`.
2. Use proper test tracking and cleanup logic.
3. Add comprehensive assertions.
4. Update the test coverage table above.
