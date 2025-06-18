# CLI Command Documentation Consolidation

## ⚠️ Priority: High

## 📋 Issue Summary

Create a unified CLI command reference that consolidates all ElizaOS CLI commands into a single authoritative page, organized by user journey rather than technical implementation, following the "One Concept, One Page" documentation philosophy.

## 🐛 Problem Description

### Current CLI Documentation Issues

#### **1. Fragmented Command Documentation**
- **Partial coverage**: Only `test` command fully documented
- **Scattered locations**: Command info spread across intro.md, quickstart.md, and incomplete CLI files
- **Missing commands**: `agent`, `env`, `dev`, `update`, `monorepo`, `tee` completely undocumented
- **Inconsistent examples**: Different files show different command syntax

#### **2. User Journey Confusion**
- **No clear progression**: Users don't know which commands to use when
- **Technical organization**: Commands grouped by implementation rather than user goals
- **Missing workflows**: No examples of command sequences for common tasks

#### **3. Documentation Philosophy Violations**
- **Violates "One Concept, One Page"**: CLI commands spread across multiple pages
- **Breaks user journey**: No clear signposts for command discovery and progression
- **Incomplete source verification**: Command options not verified against actual implementation

### Current State Assessment

| Command Category | Documentation Status | User Impact |
|-----------------|---------------------|-------------|
| Basic (`create`, `start`) | ✅ Documented | Users can get started |
| Testing (`test`) | ✅ Complete | Users can test projects |
| Agent Management (`agent *`) | ❌ Missing | Users miss powerful features |
| Environment (`env *`) | ❌ Missing | Configuration struggles |
| Development (`dev`, `update`) | ❌ Missing | Poor developer experience |
| Advanced (`monorepo`, `tee`) | ❌ Missing | Expert features hidden |

## ✅ Acceptance Criteria

- [ ] Single CLI reference page containing all commands
- [ ] Commands organized by user journey and intent
- [ ] All command options verified against source implementation
- [ ] Clear workflow examples for common use cases
- [ ] Progressive disclosure from basic to advanced commands
- [ ] Cross-references to related documentation
- [ ] Migration path for users discovering new commands
- [ ] Help text consistency with actual CLI implementation

## 🔧 Implementation Steps

### 1. Create Unified CLI Reference

**Create `/packages/docs/docs/cli/reference.md`** following documentation philosophy:

```markdown
---
sidebar_position: 1
title: CLI Command Reference
description: Complete guide to all ElizaOS CLI commands, organized by user journey
keywords: [cli, commands, elizaos, reference, workflow]
---

# CLI Command Reference

The `elizaos` CLI is your primary interface for creating, managing, and developing with ElizaOS agents. This guide organizes all commands by when you'll need them in your journey.

> **Quick Discovery**: Use `elizaos --help` to see all available commands, or `elizaos <command> --help` for specific command details.

## Getting Started Commands

These commands get you from zero to a running agent:

### `elizaos create`
Create new ElizaOS projects, plugins, or agents.

```bash
# Interactive project creation (recommended for beginners)
elizaos create

# Create specific project types
elizaos create my-project --type project
elizaos create my-plugin --type plugin  
elizaos create my-agent --type agent
elizaos create my-tee --type tee
```

**Options:**
| Option | Description | Default |
|--------|-------------|---------|
| `-t, --type <type>` | Project type: `project`, `plugin`, `agent`, `tee` | `project` |
| `-y, --yes` | Skip interactive prompts | `false` |
| `--no-install` | Skip dependency installation | `false` |
| `--no-git` | Skip git initialization | `false` |

### `elizaos start`
Start your agent with the web interface.

```bash
# Start with default configuration
elizaos start

# Configure before starting
elizaos start --configure

# Use custom port
elizaos start --port 8080

# Load specific character file
elizaos start --character ./my-character.json
```

**Options:**
| Option | Description | Default |
|--------|-------------|---------|
| `-c, --configure` | Interactive configuration before start | `false` |
| `-p, --port <port>` | Server port | `3000` |
| `--character <path>` | Character file to load | default character |

### `elizaos env`
Manage environment variables and configuration.

```bash
# Interactive environment setup (recommended)
elizaos env interactive

# Edit local .env file
elizaos env edit-local

# List current environment variables
elizaos env list

# Reset to default configuration
elizaos env reset
```

**Subcommands:**
- `interactive` - Guided environment setup
- `edit-local` - Open .env file in editor
- `list` - Show current environment variables
- `reset` - Reset to .env.example

## Development Commands

Once you're comfortable with basics, these commands enhance your workflow:

### `elizaos dev`
Start development mode with hot reloading and enhanced logging.

```bash
# Basic development mode
elizaos dev

# Configure before starting dev mode
elizaos dev --configure

# Use custom character in development
elizaos dev --character ./test-character.json

# Force rebuild before starting
elizaos dev --build
```

**Options:**
| Option | Description | Default |
|--------|-------------|---------|
| `-c, --configure` | Interactive configuration | `false` |
| `--character <path>` | Character file for development | default |
| `-b, --build` | Force rebuild before starting | `false` |
| `-p, --port <port>` | Development server port | `3000` |

### `elizaos test`
Run your project's test suite.

> **Complete Reference**: See [Testing Documentation](./test.md) for comprehensive testing guide.

```bash
# Run all tests (default)
elizaos test

# Run specific test types
elizaos test component  # Unit tests only
elizaos test e2e        # End-to-end tests only

# Run tests by name pattern
elizaos test --name "action"

# Development testing workflow
elizaos test --watch --skip-build
```

## Agent Management Commands

Manage multiple agents and character configurations:

### `elizaos agent`
Complete agent lifecycle management.

```bash
# List all available agents
elizaos agent list

# Start agent with character file
elizaos agent start --path ./character.json

# Start agent with remote character
elizaos agent start --remote-character https://example.com/character.json

# Get agent details
elizaos agent get --name "MyAgent"

# Stop running agent
elizaos agent stop --name "MyAgent"

# Update agent configuration
elizaos agent set --name "MyAgent" --file updated-config.json
```

**Subcommands:**
- `list` - Show all agents and their status
- `start` - Start agent with character configuration
- `stop` - Stop running agent
- `get` - Retrieve agent details
- `set` - Update agent configuration
- `remove` - Remove agent

**Common Options:**
| Option | Description |
|--------|-------------|
| `--name <name>` | Agent name for operations |
| `--path <file>` | Local character file path |
| `--remote-character <url>` | Remote character file URL |
| `--output <file>` | Save output to file |

## Plugin Ecosystem Commands

Discover, install, and publish plugins:

### `elizaos plugins`
Manage the plugin ecosystem.

```bash
# Discover available plugins
elizaos plugins list

# Show all plugins (including v0.x)
elizaos plugins list --all

# Add plugin to your project
elizaos plugins add @elizaos/plugin-discord

# Remove plugin
elizaos plugins remove @elizaos/plugin-discord

# List installed plugins
elizaos plugins installed-plugins

# Upgrade from v0.x plugins
elizaos plugins upgrade

# Generate new plugin with AI assistance
elizaos plugins generate
```

### `elizaos publish`
Publish your plugin to the ecosystem.

```bash
# Test publishing process (dry run)
elizaos publish --test

# Publish to GitHub (default)
elizaos publish

# Publish to npm registry
elizaos publish --npm

# Generate files locally for review
elizaos publish --dry-run
```

## Maintenance Commands

Keep your development environment current:

### `elizaos update`
Update CLI and project dependencies.

```bash
# Update CLI to latest version
elizaos update --cli

# Update project dependencies
elizaos update --packages

# Check for available updates
elizaos update --check

# Skip build after updates
elizaos update --skip-build
```

### `elizaos stop`
Stop all running ElizaOS agents and services.

```bash
# Stop all agents
elizaos stop
```

## Advanced Commands

Expert-level commands for specialized use cases:

<details>
<summary>Click to show advanced commands</summary>

### `elizaos monorepo`
Clone and set up the ElizaOS source code for core development.

```bash
# Clone ElizaOS repository
elizaos monorepo

# Clone specific branch
elizaos monorepo --branch develop

# Clone to custom directory
elizaos monorepo --dir ./my-eliza-fork
```

### `elizaos tee`
Trusted Execution Environment deployment and management.

```bash
# TEE-specific operations (requires TEE setup)
elizaos tee [tee-specific-commands]
```

</details>

## Common Workflows

### Complete Agent Development Cycle
```bash
# 1. Create new project
elizaos create my-agent --type project

# 2. Configure environment
cd my-agent
elizaos env interactive

# 3. Start development
elizaos dev

# 4. Test changes
elizaos test --watch

# 5. Start production agent
elizaos start
```

### Plugin Development Workflow
```bash
# 1. Create plugin project
elizaos create my-plugin --type plugin

# 2. Develop and test
elizaos dev
elizaos test

# 3. Validate for publishing
elizaos publish --test

# 4. Publish to ecosystem
elizaos publish
```

### Agent Character Management
```bash
# 1. Create character file
elizaos create my-character --type agent

# 2. Start agent with character
elizaos agent start --path ./my-character.json

# 3. Monitor running agents
elizaos agent list

# 4. Update agent configuration
elizaos agent set --name "MyAgent" --file updated-character.json
```

### Multi-Agent Setup
```bash
# 1. Start multiple agents
elizaos agent start --path ./agent1.json
elizaos agent start --path ./agent2.json

# 2. Monitor all agents
elizaos agent list

# 3. Stop specific agent
elizaos agent stop --name "Agent1"

# 4. Stop all agents
elizaos stop
```

## Global Options

These options work with any `elizaos` command:

| Option | Description |
|--------|-------------|
| `--no-emoji` | Disable emoji in output (useful for CI/CD) |
| `--no-auto-install` | Disable automatic Bun installation |
| `--verbose` | Enable detailed logging |
| `--config <path>` | Use custom configuration file |
| `-v, --version` | Show CLI version |
| `-h, --help` | Show help for command |

## Command Discovery

### Get Help
```bash
# Show all available commands
elizaos --help

# Get help for specific command
elizaos create --help
elizaos agent --help
elizaos test --help

# Get help for subcommands
elizaos agent start --help
elizaos plugins list --help
```

### Version Information
```bash
# Check CLI version
elizaos --version

# Verify installation
elizaos env list
```

## What's Next?

Now that you know the CLI commands:

- **[Character Files](../core/characters.md)**: Customize your agent's personality and behavior
- **[Plugin Development](../core/plugins.md)**: Create and publish your own plugins
- **[Testing Guide](./test.md)**: Comprehensive testing with the CLI
- **[Project Structure](../core/project.md)**: Understand your project organization

## Troubleshooting

### Command Not Found
```bash
# Verify CLI installation
elizaos --version

# Reinstall if needed
bun install -g @elizaos/cli
```

### Permission Issues
```bash
# On Unix systems, you may need to fix permissions
sudo chown -R $(whoami) ~/.bun
```

### Environment Problems
```bash
# Check environment configuration
elizaos env list

# Reset environment to defaults
elizaos env reset
```
```

### 2. Update Navigation and Integration

**Update `/packages/docs/sidebars.ts`:**

```typescript
{
  type: 'category', 
  label: 'CLI Reference',
  items: [
    'cli/reference',    // New unified reference (primary)
    'cli/test',         // Detailed testing guide
    // Remove or consolidate other CLI files
  ],
}
```

**Update `/packages/docs/docs/intro.md`:**

```markdown
## Available Commands Reference

The `elizaos` CLI provides comprehensive agent and project management capabilities.

> **Complete Reference**: See the [CLI Command Reference](./cli/reference.md) for all commands organized by user journey.

### Quick Command Categories
| Category | Primary Commands | Purpose |
|----------|-----------------|---------|
| **Getting Started** | `create`, `start`, `env` | Set up and run your first agent |
| **Development** | `dev`, `test`, `update` | Build and iterate on your projects |
| **Agent Management** | `agent list`, `agent start`, `agent stop` | Manage multiple agents |
| **Plugin Ecosystem** | `plugins list`, `plugins add`, `publish` | Extend and share capabilities |

### Command Discovery
```bash
# Explore available commands
elizaos --help

# Get detailed help for any command
elizaos agent --help
elizaos test --help
```
```

### 3. Cross-Reference Integration

**Add CLI references throughout documentation:**

```markdown
// In quickstart.md
## Command Reference
All commands used in this guide are part of the ElizaOS CLI. For complete command documentation, see the [CLI Reference](./cli/reference.md).

// In character documentation
## Testing Your Character
Use the CLI to test your character file:
```bash
elizaos agent start --path ./my-character.json
```
See [CLI Reference - Agent Commands](./cli/reference.md#agent-management-commands) for all agent management options.

// In plugin documentation  
## Plugin Development Workflow
The CLI provides a complete plugin development cycle:
```bash
elizaos create my-plugin --type plugin
elizaos dev
elizaos test
elizaos publish
```
See [CLI Reference - Plugin Commands](./cli/reference.md#plugin-ecosystem-commands) for detailed options.
```

### 4. Cleanup Existing CLI Documentation

**Consolidate existing CLI files:**

```markdown
// Update /packages/docs/docs/cli/overview.md
> **Note**: This overview has been consolidated into the comprehensive [CLI Reference](./reference.md). This page is maintained for backwards compatibility.

// Update other CLI command files
> **Complete Documentation**: This command is part of the unified [CLI Reference](./reference.md#command-name). See that page for complete options and examples.
```

## 📝 Files to Update

### Primary Deliverable
1. `/packages/docs/docs/cli/reference.md` - Complete unified CLI reference

### Navigation and Integration  
1. `/packages/docs/sidebars.ts` - Update CLI section structure
2. `/packages/docs/docs/intro.md` - Update command overview section
3. `/packages/docs/docs/quickstart.md` - Add CLI reference cross-links

### Cross-Reference Updates
1. `/packages/docs/docs/core/characters.md` - Add CLI usage examples
2. `/packages/docs/docs/core/plugins.md` - Add plugin CLI workflows
3. `/packages/docs/docs/core/project.md` - Add project management commands

### Cleanup
1. `/packages/docs/docs/cli/overview.md` - Add consolidation notice
2. Other existing CLI files - Add reference to unified guide

## 🧪 Testing

### Documentation Philosophy Testing
- [ ] **One Concept Test**: All CLI information accessible from single reference page
- [ ] **User Journey Test**: Commands organized by when users need them
- [ ] **Source Truth Test**: All options verified against actual CLI implementation

### Practical Testing
- [ ] Test every documented command and option combination
- [ ] Verify all workflow examples work end-to-end
- [ ] Confirm help text matches documentation
- [ ] Test command discovery patterns with new users

### Cross-Reference Testing
- [ ] Verify all links to CLI reference work correctly
- [ ] Test navigation flow from other docs to CLI reference
- [ ] Confirm workflow examples integrate with other documentation

## 📚 Related Issues

- Issue #024: Documentation philosophy alignment (parent issue)
- Issue #004: Missing CLI commands (addresses this gap)
- Issue #005: Incorrect publish command (fixed in reference)
- Issue #006: Undocumented command options (comprehensive coverage)

## 💡 Additional Context

### Why CLI Consolidation Is Essential

1. **User Journey Focus**: Users need commands organized by goals, not technical structure
2. **Discovery Problem**: 70% of CLI functionality is currently undiscovered
3. **Philosophy Alignment**: Currently violates "One Concept, One Page" principle
4. **Support Reduction**: Single reference reduces fragmentation confusion

### Documentation Philosophy Application

**Feynman Technique:**
- Start with essential getting-started commands
- Progress through development workflow
- Hide advanced commands in collapsible sections

**User Journey Narrative:**
- Commands organized by when users need them
- Clear workflow examples for common tasks
- Progressive disclosure from basic to expert

**Source of Truth:**
- Every command option verified against implementation
- Help text consistency ensured
- Examples tested in actual CLI

### Organization Strategy

**By User Intent, Not Technical Structure:**
- Getting Started (new users)
- Development (active development)  
- Agent Management (multi-agent scenarios)
- Plugin Ecosystem (extending capabilities)
- Maintenance (keeping things current)
- Advanced (expert features)

### Success Metrics

1. **Completeness**: All CLI commands documented in unified location
2. **Accuracy**: 100% of options match actual implementation
3. **Usability**: Users can accomplish workflows following documentation alone
4. **Discovery**: Clear path for users to find commands they need
5. **Philosophy**: Follows all three documentation principles

## 📎 Source Code References

- CLI command implementations: `/packages/cli/src/commands/`
- Command registration: `/packages/cli/src/index.ts`
- Help text definitions: Command-specific files
- Option parsing: Individual command files