# Milestone 5: Troubleshooting - Common Issues

This milestone validates that the troubleshooting documentation is accurate and that the CLI provides helpful error messages.

## 1. CLI Error Handling
- [ ] **Invalid Command**: Run an invalid command (e.g., `elizaos foobar`) and verify it suggests the correct command (`elizaos --help`).
- [ ] **Invalid Option**: Run a valid command with an invalid option (e.g., `elizaos start --invalid-option`) and check for a clear error message.
- [ ] **Missing Required Argument**: Run a command that requires an argument without it (e.g., `elizaos agent get`) and verify it enters interactive mode or provides a clear error.

## 2. Startup & Port Conflicts
- [ ] **Run `elizaos start`**: With a server already running on the default port, run `elizaos start` again and verify it reports a "Port in use" error.
- [ ] **Test with `--port`**: Verify that `elizaos start --port <new_port>` successfully avoids the conflict.

## 3. Build & Dependency Failures
- [ ] **Introduce a Syntax Error**: Add a syntax error to a `src/index.ts` file in a project.
- [ ] **Run `elizaos start --build`**: Verify that the build fails with a clear TypeScript error message.
- [ ] **Remove `node_modules`**: Delete the `node_modules` directory and `bun.lockb` file.
- [ ] **Run `elizaos start`**: Verify that it correctly identifies the missing dependencies and runs `bun install`.

## 4. Character & Config Loading Issues
- [ ] **Invalid JSON**: Introduce a JSON syntax error into a character file.
- [ ] **Run `elizaos start --character <bad_file>`**: Verify it fails with a clear "Invalid JSON" error.
- [ ] **Missing Character File**: Try to start an agent with a path to a non-existent character file and check for a "File not found" error.

## 5. Migration (`migration/` docs)
- [ ] **Review Migration Guides**: Read through the migration guides to check for clarity and completeness.
- [ ] **(Optional) Test a Migration**: If possible, check out an older version of the codebase and attempt to follow a migration guide to the current version. 