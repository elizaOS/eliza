# ElizaOS Plugin Upgrade System

This directory contains the automated plugin upgrade system for migrating ElizaOS plugins from version 0.x to 1.x.

## Overview

The plugin upgrade system uses AI-powered code migration to automatically:

1. Analyze plugin codebases
2. Generate specific migration strategies
3. Apply migrations using Claude Code
4. Run tests in a self-healing loop
5. Validate production readiness
6. Push upgraded code to a new branch

## Usage

```bash
elizaos plugins upgrade <path> [options]
```

### Options

- `--api-key <key>`: Provide Anthropic API key (alternative to ANTHROPIC_API_KEY env var)
- `--skip-tests`: Skip the automated test validation loop
- `--skip-validation`: Skip the production readiness validation

### Examples

```bash
# Upgrade a GitHub repository
elizaos plugins upgrade https://github.com/user/plugin-name

# Upgrade a local plugin with API key
elizaos plugins upgrade ./my-plugin --api-key sk-ant-...

# Quick upgrade without tests or validation
elizaos plugins upgrade ./my-plugin --skip-tests --skip-validation
```

## How It Works

### 1. Repository Analysis

- Analyzes the plugin structure
- Reads package.json, README, and source files
- Identifies patterns that need migration

### 2. Migration Strategy Generation

- Uses Claude to generate a specific migration plan
- Identifies exact files and changes needed
- Creates comprehensive test requirements

### 3. Code Migration

- Runs Claude Code to apply the migration
- Creates new test files
- Updates dependencies and configuration

### 4. Test Loop (if not skipped)

- Runs `elizaos test` to validate the migration
- If tests fail, re-engages Claude Code with error context
- Continues up to 5 iterations until tests pass

### 5. Production Validation (if not skipped)

- Sends all changed files to Claude for review
- Evaluates against production readiness criteria
- If not ready, applies revision instructions and re-tests
- Continues up to 3 revision iterations

### 6. Branch Creation

- Creates or updates a `1.x-claude` branch
- Pushes the branch to origin
- Ready for manual review and PR creation

## Requirements

1. **Anthropic API Key**: Required for AI-powered migration

   - Set `ANTHROPIC_API_KEY` environment variable
   - Or use `--api-key` option

2. **Claude Code CLI**: Must be installed globally

   ```bash
   npm install -g @anthropic-ai/claude-code
   ```

3. **Git**: Repository must be a git repository
   - For GitHub URLs, will clone to `./cloned_repos/`
   - For local folders, must have git initialized

## Architecture

### Files

- `migrator.ts`: Main migration logic class
- `CLAUDE.md`: Base migration instructions for ElizaOS 0.x to 1.x

### Key Classes

- `PluginMigrator`: Orchestrates the entire migration process
  - `migrate()`: Main entry point
  - `runMigrationWithTestLoop()`: Handles test validation loop
  - `runProductionValidationLoop()`: Handles production readiness validation
  - `validateProductionReadiness()`: Evaluates migration quality

## Error Handling

The system handles various error scenarios:

- Missing API key
- Claude Code not installed
- Git operations failures
- Test failures (with retry)
- Validation failures (with revision)

## Development

To work on the upgrade system:

1. Make changes to `migrator.ts`
2. Run tests: `bun test plugin-migrator.test.ts`
3. Build the CLI: `bun run build`
4. Test the command: `./dist/index.js plugins upgrade --help`

## Best Practices

1. **Review the branch**: Always manually review the `1.x-claude` branch before merging
2. **Run full tests**: Consider running additional manual tests
3. **Check edge cases**: AI might miss specific edge cases
4. **Backup first**: For local folders, consider backing up before running

## Troubleshooting

### "Claude Code not found"

Install Claude Code globally:

```bash
npm install -g @anthropic-ai/claude-code
```

### "ANTHROPIC_API_KEY is required"

Set your API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### Tests keep failing

Try skipping tests and fixing manually:

```bash
elizaos plugins upgrade ./plugin --skip-tests
```

### Migration not production ready

Check the revision instructions in the output and apply manually if needed.
