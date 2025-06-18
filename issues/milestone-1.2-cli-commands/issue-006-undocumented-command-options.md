# Command Options and Flags Are Undocumented

## 📝 Priority: Medium

## 📋 Issue Summary

Most CLI commands have extensive options and flags that provide powerful functionality, but these are completely undocumented, forcing users to discover features through trial and error or help text.

## 🐛 Problem Description

### Current Documentation State
- Basic command usage is shown: `elizaos create`, `elizaos start`
- No mention of command options, flags, or advanced usage
- Users unaware of powerful features like `--configure`, `--port`, `--character`, etc.

### Undocumented Command Options

#### **elizaos create**
*Source: `/packages/cli/src/commands/create/index.ts`*

```bash
elizaos create [project-name] [options]

Options:
  -t, --type <type>          Project type: project, plugin, agent, tee
  -y, --yes                  Skip interactive prompts
  --template <template>      Use specific template
  --no-install              Skip dependency installation
  --no-git                  Skip git initialization
```

#### **elizaos start**
*Source: `/packages/cli/src/commands/start/index.ts`*

```bash
elizaos start [options]

Options:
  -c, --configure           Interactive configuration before start
  -p, --port <port>         Specify port number (default: 3000)
  --character <path>        Load specific character file
  --no-build               Skip build step
  --quiet                  Suppress output
```

#### **elizaos agent**
*Source: `/packages/cli/src/commands/agent/`*

```bash
elizaos agent <command> [options]

Commands:
  list                      List all agents
  get --name <name>         Get agent details
  start --path <path>       Start agent with character file
  start --remote-character <url>  Start agent with remote character
  stop --name <name>        Stop running agent
  set --name <name> --file <config>  Update agent configuration

Options:
  --output <file>           Save output to file
  --format <format>         Output format: json, yaml, table
```

#### **elizaos test**
*Source: `/packages/cli/src/commands/test/index.ts`*

```bash
elizaos test [options]

Options:
  -t, --type <type>         Test type: component, e2e, all (default: all)
  -p, --port <port>         Port for test server
  --name <pattern>          Run specific test by name pattern
  --skip-build             Skip build before testing
  --skip-type-check        Skip TypeScript type checking
  --watch                  Watch mode for continuous testing
  --coverage               Generate coverage report
```

#### **elizaos dev**
*Source: `/packages/cli/src/commands/dev/index.ts`*

```bash
elizaos dev [options]

Options:
  -c, --configure          Interactive configuration
  -char, --character <path> Specify character file
  -b, --build              Force rebuild before starting
  -p, --port <port>        Development server port
  --no-open               Don't open browser automatically
```

#### **elizaos env**
*Source: `/packages/cli/src/commands/env/`*

```bash
elizaos env <command> [options]

Commands:
  list                     List environment variables
  edit-local              Edit local .env file
  reset                   Reset to .env.example
  interactive             Interactive environment setup

Options:
  --show-values           Show actual values (security warning)
  --filter <pattern>      Filter variables by pattern
  --output <file>         Export to file
```

#### **elizaos plugins**
*Source: `/packages/cli/src/commands/plugins/`*

```bash
elizaos plugins <command> [options]

Commands:
  list                    List available plugins
  add <plugin>            Add plugin to project
  remove <plugin>         Remove plugin from project
  installed-plugins       List installed plugins
  upgrade                 Upgrade plugins from v0.x to v1.x
  generate                AI-powered plugin generation

Options:
  --all                   Show all available plugins
  --v0                    Show v0.x compatible plugins
  --dev                   Install as development dependency
  --force                 Force installation/removal
```

#### **Global Options**
*Source: `/packages/cli/src/index.ts`*

```bash
Global Options:
  --no-emoji              Disable emoji output
  --no-auto-install       Disable automatic Bun installation
  --verbose               Enable verbose logging
  --config <path>         Use custom config file
  -v, --version          Output version number
  -h, --help             Display help information
```

## ✅ Acceptance Criteria

- [ ] All command options are documented with explanations
- [ ] Usage examples show common flag combinations
- [ ] Global options are explained
- [ ] Advanced use cases are covered
- [ ] Help text matches documentation
- [ ] Options are organized by functionality

## 🔧 Implementation Steps

### 1. Create Comprehensive Command Documentation

Update existing CLI docs with complete option coverage:

#### **Update `/packages/docs/docs/cli/create.md`**

```markdown
# elizaos create

Create new ElizaOS projects, plugins, agents, or TEE deployments.

## Usage

```bash
elizaos create [project-name] [options]
```

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `-t, --type <type>` | Project type: `project`, `plugin`, `agent`, `tee` | `project` |
| `-y, --yes` | Skip interactive prompts and use defaults | `false` |
| `--template <template>` | Use specific template instead of default | - |
| `--no-install` | Skip automatic dependency installation | `false` |
| `--no-git` | Skip git repository initialization | `false` |

## Examples

```bash
# Interactive project creation
elizaos create

# Create specific project type
elizaos create my-plugin --type plugin

# Skip prompts and use defaults
elizaos create my-agent --type agent --yes

# Create without installing dependencies
elizaos create my-project --no-install
```
```

### 2. Add Option Examples to Quickstart

Update `/packages/docs/docs/quickstart.md` with practical option usage:

```markdown
### Advanced Creation Options

```bash
# Create different project types
elizaos create my-plugin --type plugin
elizaos create my-agent --type agent
elizaos create my-tee --type tee

# Skip interactive setup
elizaos create my-project --yes

# Custom configuration during creation
elizaos create my-agent --type agent --configure
```

### Starting with Configuration

```bash
# Configure before starting
elizaos start --configure

# Use custom port
elizaos start --port 8080

# Load specific character
elizaos start --character ./my-character.json
```

### Development Workflow

```bash
# Development mode with custom character
elizaos dev --character ./test-character.json

# Force rebuild in development
elizaos dev --build

# Development on custom port
elizaos dev --port 8080
```
```

### 3. Document Testing Options

Create `/packages/docs/docs/cli/test.md`:

```markdown
# Testing Commands

## Basic Testing

```bash
# Run all tests
elizaos test

# Run specific test type
elizaos test --type component
elizaos test --type e2e
```

## Advanced Testing Options

```bash
# Run specific tests by name
elizaos test --name "action"
elizaos test --name "*.test.ts"

# Skip build for faster testing
elizaos test --skip-build

# Generate coverage report
elizaos test --coverage

# Watch mode for development
elizaos test --watch

# Custom port for test server
elizaos test --port 8080 --type e2e
```
```

### 4. Add Global Options Documentation

Create `/packages/docs/docs/cli/global-options.md`:

```markdown
# Global Options

These options work with any elizaos command:

## Output Control
- `--no-emoji` - Disable emoji in output (useful for CI/CD)
- `--verbose` - Enable detailed logging for debugging
- `--quiet` - Suppress non-essential output

## Configuration  
- `--config <path>` - Use custom configuration file
- `--no-auto-install` - Disable automatic Bun installation prompts

## Help & Information
- `-v, --version` - Show ElizaOS CLI version
- `-h, --help` - Show help for any command

## Examples

```bash
# Verbose output for debugging
elizaos start --verbose

# Clean output for CI/CD
elizaos test --no-emoji --quiet

# Custom configuration
elizaos start --config ./custom-config.json
```
```

## 📝 Files to Update

### New Files to Create
1. `/packages/docs/docs/cli/global-options.md` - Global options reference
2. `/packages/docs/docs/cli/advanced-usage.md` - Advanced use cases

### Files to Update
1. `/packages/docs/docs/cli/create.md` - Add all create options
2. `/packages/docs/docs/cli/start.md` - Add start options  
3. `/packages/docs/docs/cli/test.md` - Complete testing documentation
4. `/packages/docs/docs/quickstart.md` - Add option examples
5. `/packages/docs/sidebars.ts` - Add new CLI documentation pages

## 🧪 Testing

- [ ] Verify all documented options exist in actual commands
- [ ] Test all example command combinations
- [ ] Confirm help text matches documentation
- [ ] Validate option descriptions and defaults
- [ ] Test edge cases and error conditions

## 📚 Related Issues

- Issue #004: Missing CLI commands (this extends that work)
- Issue #005: Incorrect publish command syntax
- Issue #017: Need consistency validation between docs and implementation

## 💡 Additional Context

### Option Documentation Principles

1. **Practical Examples**: Show real-world usage patterns
2. **Defaults**: Always specify default values
3. **Combinations**: Show how options work together
4. **Troubleshooting**: Include common option-related issues

### Common Use Cases by Role

**Developers:**
- `--watch`, `--verbose`, `--skip-build` for fast iteration
- `--port` for avoiding conflicts
- `--character` for testing different configurations

**CI/CD:**
- `--no-emoji`, `--quiet` for clean output
- `--yes`, `--no-install` for automation
- `--skip-build` when build is handled separately

**Advanced Users:**
- `--config` for custom setups
- `--type` for specific project types
- `--filter`, `--format` for specific outputs

## 📎 Source Code References

- Command implementations: `/packages/cli/src/commands/*/index.ts`
- Option definitions: Command-specific option parsing
- Global options: `/packages/cli/src/index.ts`
- Help text generation: `/packages/cli/src/utils/`