# 50%+ of CLI Commands Are Undocumented

## 🔥 Priority: Critical

## 📋 Issue Summary

More than half of the implemented CLI commands are completely missing from documentation, leaving users unaware of powerful features like agent management, testing, environment configuration, and development tools.

## 🐛 Problem Description

### Documented Commands (Current)
*Files: `/packages/docs/docs/intro.md`, `/packages/docs/docs/quickstart.md`*

- `elizaos create`
- `elizaos start` 
- `elizaos plugins list`
- `elizaos plugins add`
- `elizaos plugins publish` (incorrect - should be `elizaos publish`)

### Undocumented Commands (Implemented)
*Based on: `/packages/cli/src/commands/`*

#### **Agent Management System**
- `elizaos agent list` - List all available agents
- `elizaos agent get --name <name>` - Get agent details
- `elizaos agent start --path <file>` - Start agent with character file
- `elizaos agent stop --name <name>` - Stop running agent
- `elizaos agent remove --name <name>` - Remove agent
- `elizaos agent set --name <name> --file <config>` - Update agent configuration

#### **Development Tools**
- `elizaos dev` - Development mode with auto-rebuild
- `elizaos test` - Comprehensive testing system
  - `elizaos test component` - Run unit tests
  - `elizaos test e2e` - Run end-to-end tests
  - `elizaos test --name <pattern>` - Run specific tests
- `elizaos update` - Update CLI and dependencies

#### **Environment Management**
- `elizaos env list` - List environment variables
- `elizaos env edit-local` - Edit local environment
- `elizaos env reset` - Reset environment variables
- `elizaos env interactive` - Interactive environment setup

#### **Additional Commands**
- `elizaos stop` - Stop all running agents
- `elizaos monorepo` - Clone ElizaOS monorepo for development
- `elizaos tee` - TEE deployment management
- `elizaos plugins installed-plugins` - List installed plugins
- `elizaos plugins remove` - Remove plugins
- `elizaos plugins upgrade` - Upgrade plugins from v0.x to v1.x
- `elizaos plugins generate` - AI-powered plugin generation

### Impact
- Users miss 70%+ of available functionality
- Support requests for "missing" features that actually exist
- Poor user experience and reduced adoption
- Documentation appears incomplete and unprofessional

## ✅ Acceptance Criteria

- [ ] All implemented CLI commands are documented
- [ ] Each command includes usage examples
- [ ] Command options and flags are explained
- [ ] Commands are organized by functionality
- [ ] Examples show realistic use cases
- [ ] Cross-references between related commands

## 🔧 Implementation Steps

### 1. Create Comprehensive CLI Reference

Create `/packages/docs/docs/cli/reference.md`:

```markdown
# CLI Command Reference

## Agent Management

### elizaos agent list
List all available agents and their status.

```bash
elizaos agent list
```

### elizaos agent start
Start an agent with a character file.

```bash
# Start with character file
elizaos agent start --path ./my-character.json

# Start with remote character
elizaos agent start --remote-character https://example.com/character.json

# Start with specific name
elizaos agent start --name "MyAgent"
```

[Continue for all commands...]
```

### 2. Update Introduction Documentation

Add to `/packages/docs/docs/intro.md`:

```markdown
## Available Commands Reference

ElizaOS provides a comprehensive CLI with these command categories:

- **Agent Management**: `agent list`, `agent start`, `agent stop`
- **Development**: `dev`, `test`, `update`
- **Environment**: `env list`, `env edit-local`, `env interactive`
- **Plugins**: `plugins list`, `plugins add`, `plugins generate`
- **Project**: `create`, `start`, `stop`

See the [CLI Reference](./cli/reference.md) for complete documentation.
```

### 3. Update Quickstart Examples

Add practical command examples to `/packages/docs/docs/quickstart.md`:

```markdown
### Working with Character Files

```bash
# Create a new character
elizaos create --type agent my-character

# Start agent with character file
elizaos agent start --path ./my-character.json

# List running agents
elizaos agent list

# Stop an agent
elizaos agent stop --name "my-character"
```

### Development Workflow

```bash
# Start development mode with auto-rebuild
elizaos dev

# Run tests
elizaos test

# Update CLI to latest version
elizaos update
```

### Environment Management

```bash
# Interactive environment setup
elizaos env interactive

# List current environment variables
elizaos env list

# Edit local environment
elizaos env edit-local
```
```

### 4. Create Individual Command Documentation

Create detailed docs in `/packages/docs/docs/cli/` for each major command:

- `agent.md` - Agent management commands
- `dev.md` - Development tools
- `env.md` - Environment configuration  
- `test.md` - Testing commands
- `plugins.md` - Plugin management (update existing)

### 5. Add Command Discovery

Add to quickstart:

```markdown
### Discover Available Commands

```bash
# List all commands
elizaos --help

# Get help for specific command
elizaos agent --help
elizaos test --help
elizaos env --help
```
```

## 📝 Files to Update

### New Files to Create
1. `/packages/docs/docs/cli/reference.md` - Comprehensive command reference
2. `/packages/docs/docs/cli/agent.md` - Agent management documentation
3. `/packages/docs/docs/cli/dev.md` - Development tools documentation
4. `/packages/docs/docs/cli/env.md` - Environment management documentation

### Files to Update
1. `/packages/docs/docs/intro.md` - Add command overview
2. `/packages/docs/docs/quickstart.md` - Add practical examples
3. `/packages/docs/docs/cli/overview.md` - Update if exists
4. `/packages/docs/sidebars.ts` - Add new CLI documentation pages

## 🧪 Testing

- [ ] Verify all documented commands exist and work
- [ ] Test all command examples
- [ ] Confirm help text matches documentation
- [ ] Validate command options and flags
- [ ] Test error cases and edge conditions

## 📚 Related Issues

- Issue #005: Incorrect publish command needs fixing
- Issue #006: Command options need comprehensive documentation
- Issue #016: Need implementation links for all commands

## 💡 Additional Context

### Command Categories by Functionality

**Core Workflow:**
- `create`, `start`, `stop` - Basic project management
- `dev` - Development mode

**Agent Management:**
- `agent *` - Complete agent lifecycle management
- Character file support for v1 migration users

**Development Tools:**
- `test` - Comprehensive testing with multiple modes
- `update` - Keep CLI and dependencies current
- `monorepo` - Access to source for contributors

**Environment & Configuration:**
- `env *` - Modern environment management
- Better than manual `.env` file editing

**Plugin Ecosystem:**
- `plugins *` - Full plugin lifecycle
- Including AI-powered generation

### Implementation Priority

1. **High-usage commands**: `agent`, `dev`, `test`, `env`
2. **Discovery features**: `--help`, command listing
3. **Advanced features**: `tee`, `monorepo`, `plugins generate`

## 📎 Source Code References

- CLI commands implementation: `/packages/cli/src/commands/`
- Command definitions: `/packages/cli/src/index.ts`
- Help text generation: `/packages/cli/src/utils/`
- Current documentation: `/packages/docs/docs/cli/`