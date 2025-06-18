# Main README.md Contains Multiple Outdated Requirements

## ⚠️ Priority: High

## 📋 Issue Summary

The main repository README.md contains several outdated requirements and instructions that conflict with current implementation, causing setup failures for new users.

## 🐛 Problem Description

### Identified Outdated Information

**1. Node.js Version Requirement**
```markdown
# Current (incorrect):
- [Node.js](https://nodejs.org/) (v18 or higher recommended)

# Should be:
- [Node.js 23.3.0](https://nodejs.org/) (exact version required)
```
*File: `/README.md` lines 33, 200*

**2. Bun Installation Instructions**
```markdown
# Current:
Important! We now use Bun. If you are using npm, you will need to install Bun:
https://bun.sh/docs/installation

# Issue: No verification steps provided
```
*File: `/README.md` line 229*

**3. Manual Installation Section**
```markdown
# Current title:
### Manually Start Eliza (Only recommended if you know what you are doing)

# Issue: This section seems to contradict the CLI-first approach
```
*File: `/README.md` line 196*

**4. Missing CLI-First Approach**
- README prioritizes manual installation over recommended CLI approach
- CLI installation instructions are less prominent than manual method
- No mention of `elizaos` command capabilities

**5. Environment Configuration**
```markdown
# Current:
Copy .env.example to .env and fill in the appropriate values.

# Issue: Doesn't mention elizaos env commands or modern config approach
```
*File: `/README.md` line 217*

## ✅ Acceptance Criteria

- [ ] Node.js version requirement matches actual configuration (23.3.0)
- [ ] CLI installation is prominently featured as recommended approach
- [ ] Manual installation is de-emphasized or moved to advanced section
- [ ] Bun installation includes verification steps
- [ ] Environment setup mentions modern CLI tools
- [ ] All commands and examples are tested and verified
- [ ] Outdated sections are removed or updated

## 🔧 Implementation Steps

### 1. Fix Node.js Version Requirement

```markdown
# Replace all instances:
- [Node.js](https://nodejs.org/) (v18 or higher recommended)

# With:
- [Node.js 23.3.0](https://nodejs.org/) (exact version required - verify with `node --version`)
```

### 2. Restructure Installation Sections

**Move CLI installation to the top:**
```markdown
## 🚀 Quick Start (Recommended)

### Prerequisites
- [Node.js 23.3.0](https://nodejs.org/) (exact version required)
- [Bun](https://bun.sh/docs/installation) (verify with `bun --version`)

### Install CLI Tool
```bash
# Install the ElizaOS CLI globally
bun install -g @elizaos/cli

# Verify installation
elizaos --version

# Create and start your first agent
elizaos create my-agent
cd my-agent
elizaos start
```

Visit http://localhost:3000 to interact with your agent.
```

### 3. Move Manual Installation to Advanced Section

```markdown
## 🔧 Advanced: Manual Installation

> **Note**: Only recommended for contributors or advanced users who need to modify core ElizaOS code. For most users, the CLI installation above is recommended.

### Development Setup
```bash
# Clone the repository
git clone https://github.com/elizaos/eliza.git
cd eliza

# Verify Node.js version
node --version  # Should output v23.3.0

# Install dependencies and build
bun install
bun run build

# Start ElizaOS
bun start
```
```

### 4. Add Verification Steps

```markdown
### Verify Your Setup

```bash
# Check Node.js version
node --version    # Should output: v23.3.0

# Check Bun installation  
bun --version     # Should output: 1.2.15 or higher

# Check ElizaOS CLI
elizaos --version # Should output current version
```
```

### 5. Update Environment Configuration

```markdown
### Configuration

ElizaOS offers multiple ways to configure your agent:

```bash
# Interactive configuration (recommended)
elizaos env interactive

# Edit environment variables
elizaos env edit-local

# Or manually copy template
cp .env.example .env
```
```

### 6. Add Troubleshooting Section

```markdown
### Common Issues

**Wrong Node.js Version**
```bash
# Use nvm to install correct version
nvm install 23.3.0
nvm use 23.3.0
```

**Bun Not Found**
```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc  # or restart terminal
```
```

## 📝 Files to Update

1. `/README.md` - Complete restructure of installation sections
2. Verify all commands actually work as documented
3. Update any other references to old installation methods

## 🧪 Testing

- [ ] Test CLI installation path from scratch
- [ ] Test manual installation path from scratch  
- [ ] Verify all documented commands execute successfully
- [ ] Test with fresh Node.js 23.3.0 installation
- [ ] Confirm environment configuration methods work

## 📚 Related Issues

- Issue #001: Node.js version conflicts (addresses same version issue)
- Issue #004: Missing CLI commands need documentation
- Issue #006: Command options need comprehensive coverage

## 💡 Additional Context

The current README.md appears to be written for an earlier version of ElizaOS before the CLI was the primary interface. The manual installation method should be de-emphasized in favor of the more user-friendly CLI approach.

**Key principles for the update:**
1. **CLI-first**: Make CLI installation the primary path
2. **Verification**: Include steps to verify each requirement
3. **Troubleshooting**: Anticipate common setup issues
4. **Clarity**: Remove contradictory or confusing instructions

## 📎 Source Code References

- Current README: `/README.md`
- CLI implementation: `/packages/cli/src/commands/`
- Package requirements: `/package.json:6-8`
- Bun configuration: `/bunfig.toml`