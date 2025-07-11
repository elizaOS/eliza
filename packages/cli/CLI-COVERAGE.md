# CLI Documentation Coverage

This document explains the CLI documentation coverage system that addresses **issue #5325: TESTING: test all CLI commands against the CLI Docs**.

## Overview

The CLI documentation coverage system ensures that:

1. ✅ All implemented CLI commands have corresponding documentation
2. ✅ All documented commands have working implementations  
3. ✅ All documented commands have comprehensive test coverage
4. ✅ Command help output matches documentation standards

## Tools & Files

### Coverage Test Suite

**File**: `tests/commands/cli-docs-coverage.test.ts`

Comprehensive test suite that validates:
- Command implementation vs documentation alignment
- Documentation completeness for all commands
- Test coverage for all documented commands  
- Help output validation and consistency
- Command option validation against documentation

### Coverage Analysis Script

**File**: `scripts/check-cli-coverage.ts`

Interactive script that:
- Analyzes current CLI command coverage
- Validates command help output
- Generates detailed coverage reports
- Provides actionable recommendations

**Usage:**
```bash
cd packages/cli
bun run check:cli-coverage
```

### GitHub Actions Workflow

**File**: `.github/workflows/cli-docs-coverage.yml`

CI workflow that:
- Runs on CLI and documentation changes
- Validates coverage on pull requests
- Comments on PRs with coverage issues  
- Uploads coverage reports as artifacts

## Command Requirements

### For New CLI Commands

When adding a new CLI command, you must:

1. **Implementation**: Add command to `src/commands/`
2. **Documentation**: Create `docs/cli/command-name.md` 
3. **Tests**: Create `tests/commands/command-name.test.ts`
4. **Registration**: Add to `src/index.ts`

### Documentation Structure

Each command documentation file must include:

```markdown
---
sidebar_position: N
title: Command Name
description: Brief description
---

# Command Name

Brief description of what the command does.

## Usage

```bash
elizaos command-name [options]
```

## Options

| Option | Description |
|--------|-------------|
| `--help` | Show help |

## Examples

### Basic Usage

```bash
elizaos command-name
```
```

### Test Structure

Each command test file should validate:

- Command help output
- Option parsing
- Error handling
- Command execution (where possible)
- Integration with other commands

Example:
```typescript
describe('Command Name Tests', () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await setupTestEnvironment();
  });

  afterEach(async () => {
    await cleanupTestEnvironment(context);
  });

  it('should show help output', () => {
    const result = runCliCommand(context.elizaosCmd, 'command-name --help');
    expect(result).toContain('Usage: elizaos command-name');
  });
});
```

## Current Command Status

Run the coverage check to see current status:

```bash
cd packages/cli
bun run check:cli-coverage
```

### Implemented Commands

- ✅ `create` - Create projects, plugins, agents
- ✅ `start` - Start agent server  
- ✅ `agent` - Manage agents
- ✅ `plugins` - Manage plugins
- ✅ `test` - Run tests
- ✅ `env` - Environment management
- ✅ `dev` - Development mode
- ✅ `update` - Update CLI and dependencies
- ✅ `publish` - Publish plugins
- ✅ `monorepo` - Clone monorepo
- ✅ `tee` - TEE deployments

### Subcommands

#### Agent Commands
- `agent list` - List agents
- `agent get` - Get agent details  
- `agent start` - Start agent
- `agent stop` - Stop agent
- `agent remove` - Remove agent
- `agent set` - Update agent config
- `agent clear-memories` - Clear memories

#### Plugin Commands  
- `plugins list` - List available plugins
- `plugins add` - Add plugin
- `plugins remove` - Remove plugin
- `plugins upgrade` - Upgrade plugin
- `plugins generate` - Generate plugin

#### Environment Commands
- `env list` - List environment variables
- `env edit-local` - Edit local environment
- `env reset` - Reset environment
- `env interactive` - Interactive management

#### TEE Commands
- `tee phala` - Phala Cloud CLI wrapper

## Validation Rules

### Documentation Rules

1. Every command must have a markdown file in `docs/cli/`
2. Documentation must include usage, options, and examples
3. Options must match actual command options
4. Examples must use correct `elizaos` command syntax

### Test Rules

1. Every command must have a test file in `tests/commands/`
2. Tests must validate help output format
3. Tests must check option parsing
4. Tests should cover error scenarios
5. Subcommands can be tested in parent command test file

### Implementation Rules

1. Commands must be registered in `src/index.ts`
2. Commands must support `--help` option
3. Help output must follow standard format:
   - `Usage: elizaos command-name [options]`
   - `Options:` section
   - Help option (`-h, --help`)

## Running Coverage Checks

### Local Development

```bash
# Quick coverage check
cd packages/cli
bun run check:cli-coverage

# Run coverage tests
bun run test:cli-docs-coverage

# Run all CLI tests
bun run test:cli
```

### Continuous Integration

The coverage check runs automatically on:
- Pull requests affecting CLI or docs
- Pushes to main/develop branches

Failed checks will:
- Block PR merging
- Comment with specific issues
- Upload detailed reports

## Troubleshooting

### Common Issues

**Missing Documentation**
```
❌ Missing Documentation:
   • new-command - Create docs/cli/new-command.md
```
*Solution*: Create the missing documentation file

**Missing Tests**  
```
❌ Missing Tests:
   • new-command - Create tests/commands/new-command.test.ts
```
*Solution*: Create the missing test file

**Failed Help Validation**
```
❌ Failed Help Validation:
   • new-command: Missing usage information
```
*Solution*: Fix command help output format

**Missing Implementation**
```
❌ Missing Implementation:
   • documented-command - Implement command in CLI
```
*Solution*: Implement the command or remove documentation

### Getting Help

1. Review existing command implementations in `src/commands/`
2. Check test examples in `tests/commands/`
3. Look at documentation examples in `docs/cli/`
4. Run `bun run check:cli-coverage` for specific guidance

## Related Issues

- **#5325**: TESTING: test all CLI commands against the CLI Docs
- See `tests/commands/README.md` for general test suite information
- See `docs/cli/overview.md` for CLI documentation overview
