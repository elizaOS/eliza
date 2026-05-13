# Installation Guide

Detailed installation instructions for Lean 4 Skills.

## Quick Start

**Via Marketplace (Recommended):**
```bash
/plugin marketplace add cameronfreer/lean4-skills
/plugin install lean4-theorem-proving    # Core skill + 6 slash commands (REQUIRED)
/plugin install lean4-memories           # Optional: persistent memory (requires lean4-theorem-proving)
/plugin install lean4-subagents          # Optional: specialized agents (requires lean4-theorem-proving)
```

**What Each Plugin Provides:**
- **lean4-theorem-proving:** Skill (auto-activates) + 6 slash commands (`/lean4-theorem-proving:build-lean`, etc.)
  - **Foundation for the other plugins** - install this first
- **lean4-memories:** Skill (auto-activates, requires lean4-theorem-proving + MCP memory server) - **EXPERIMENTAL**
  - Extends lean4-theorem-proving with persistent learning
- **lean4-subagents:** 3 agents (lean4-proof-golfer, lean4-sorry-filler, lean4-axiom-eliminator) - **EXPERIMENTAL**
  - Extends lean4-theorem-proving with specialized automation

**Manual Installation:**
```bash
git clone https://github.com/cameronfreer/lean4-skills.git
cd lean4-skills

# Install core skill + commands (REQUIRED - foundation for other plugins)
cp -r plugins/lean4-theorem-proving ~/.claude/skills/

# Install memory skill (optional, requires lean4-theorem-proving + MCP memory server)
cp -r plugins/lean4-memories ~/.claude/skills/

# Install specialized agents (optional, requires lean4-theorem-proving)
cp -r plugins/lean4-subagents ~/.claude/skills/
```

**Important:** Install lean4-theorem-proving first. The other plugins extend its functionality.

## Platform-Specific Setup

### Windows 11 Users

**The Claude Code CLI requires Bash**, which isn't installed by default on Windows 11. However, you have options that don't require installing Bash:

**Option 1: VSCode Extension (recommended for Windows)**
- Install [Claude Code for VS Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code)
- **No Bash required** - works natively on Windows
- Full documentation: https://docs.claude.com/en/docs/claude-code/vs-code

**Option 2: Git Bash (if you want the CLI)**
1. Install [Git for Windows](https://git-scm.com/download/win) (includes Git Bash)
2. Open Git Bash
3. Start Claude Code CLI: `claude`
4. Run installation commands above

**Option 3: Codeium-based IDEs**
- Use Claude Code in Cursor, Windsurf, or other Codeium-based editors
- **No Bash required**

### macOS Users

No special setup required. Use Terminal with the installation commands above.

### Linux Users

No special setup required. Use your preferred shell with the installation commands above.

## Optional CLI Helpers: ripgrep & timeout

The skills work without these tools, but installing them makes searches **much faster** (`ripgrep`) and keeps long tasks **well-behaved** (`timeout`).

- **`ripgrep` (`rg`)**: Fast recursive search used by scripts and local searches
  - Core skills: optional (faster searches)
  - Lean LSP workflow: **required** (for `lean_local_search` tool)
- **GNU `timeout`**: Cleanly aborts subprocesses after a time limit
  - If missing, a portable fallback is used (less reliable with deep process trees)

### Installation

**macOS:**
```bash
brew install ripgrep coreutils
# GNU timeout installed as `gtimeout`. Optionally alias:
echo 'alias timeout="gtimeout"' >> ~/.zshrc && exec $SHELL -l
```

Alternative (no `gtimeout` prefix):
```bash
brew install aisk/homebrew-tap/timeout
```

**Linux:**
```bash
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y ripgrep coreutils

# Fedora/RHEL/CentOS
sudo dnf install -y ripgrep coreutils

# Arch/Manjaro
sudo pacman -S --noconfirm ripgrep coreutils
```

**Windows:**

Choose one path:

- **winget + MSYS2 (recommended)**
  ```powershell
  winget install BurntSushi.ripgrep.MSVC
  winget install MSYS2.MSYS2
  # In MSYS2 shell:
  pacman -S --noconfirm coreutils
  # Add to PATH: C:\msys64\usr\bin
  ```

- **Scoop**
  ```powershell
  scoop install ripgrep msys2
  # then in MSYS2: pacman -S --noconfirm coreutils
  ```

- **Chocolatey**
  ```powershell
  choco install ripgrep msys2
  # then in MSYS2: pacman -S --noconfirm coreutils
  ```

⚠️ Windows' built-in `timeout.exe` only *waits*; it does **not** kill processes. Use MSYS2/coreutils `timeout.exe`.

### Verification

```bash
rg --version
timeout --version   # macOS may be `gtimeout --version`
```

Windows (PowerShell):
```powershell
Get-Command rg
Get-Command timeout   # should resolve to MSYS2\usr\bin\timeout.exe
```

### PATH Notes

- **macOS with coreutils:** Either call `gtimeout` explicitly or alias `timeout="gtimeout"`
- **Windows:** Ensure `C:\msys64\usr\bin` is **before** `C:\Windows\System32` in PATH

### If Missing

- Search falls back to `grep` (slower)
- A portable timer is used (may not reliably kill deep process trees on all shells)

## Lean LSP Server

**The LSP server provides 30x faster feedback than build-only workflows.**

If you're using Claude Code or Claude Desktop, you can install the Lean LSP MCP server for instant proof state inspection, integrated search, and parallel tactic testing.

### Installation

**Full instructions:** https://github.com/oOo0oOo/lean-lsp-mcp

**Quick summary:**
1. Install the Lean LSP MCP server (follow repo instructions)
2. Install ripgrep: `brew install ripgrep` (macOS) or see https://github.com/BurntSushi/ripgrep#installation
3. Configure Claude Code/Desktop to use the server
4. **Before first use:** Run `lake build` in your Lean project to avoid timeouts
5. Restart Claude

**One-time setup:** ~5 minutes

**Important prerequisites:**
- **ripgrep (rg):** Required for `lean_local_search` tool. Install and ensure it's in your PATH.
- **lake build:** Run this in your project before starting the LSP server to avoid client timeouts during initial setup.

### What You Get

- **Instant feedback:** < 1 second vs 30+ seconds building
- **Goal visibility:** See exactly what needs proving at each step
- **Parallel testing:** Test multiple tactics at once with `lean_multi_attempt`
- **Integrated search:** Find lemmas without leaving your workflow
- **No guessing:** Verify before editing, not after slow builds

### Verification

After installation, test with:
```bash
# In Claude Code, test these commands:
mcp__lean-lsp__lean_goal(file_path, line)
mcp__lean-lsp__lean_local_search("add_comm")
```

If they work, you're ready! See `plugins/lean4-theorem-proving/references/lean-lsp-server.md` for complete workflows.

## Requirements

**For lean4-theorem-proving (foundation - install first):**
- Claude Code 2.0.13+ (marketplace) OR
- Claude.ai Pro/Max/Team/Enterprise OR
- Any Claude (CLAUDE.md method)

**For lean4-memories (optional extension):**
- lean4-theorem-proving plugin (required - provides the workflows this extends)
- MCP memory server (simple config file edit - [setup guide](plugins/lean4-memories/README.md#installation))
- Claude Desktop or Claude Code with MCP support

**For lean4-subagents (optional extension):**
- lean4-theorem-proving plugin (required - agents use its workflows and patterns)
- Same Claude requirements as lean4-theorem-proving

**For Lean LSP server (optional but highly recommended):**
- Claude Code or Claude Desktop with MCP support
- Lean LSP MCP server installed (see above)

## Troubleshooting

### Skill Not Activating

**Check:**
1. Files are in `~/.claude/skills/` directory
2. Skill is enabled: `/plugin list` should show it
3. You're working with `.lean` files

### LSP Server Not Working

**Check:**
1. Lean LSP MCP server is installed and configured
2. Claude Code/Desktop is restarted
3. Test basic commands (see Verification above)
4. Check server logs for errors

**Full troubleshooting:** https://github.com/oOo0oOo/lean-lsp-mcp/issues

### Windows Issues

**Git Bash not found:**
- Install Git for Windows from https://git-scm.com/download/win
- Restart terminal after installation

**Permission errors:**
- Run Git Bash as Administrator
- Or use VSCode extension (no Bash required)

## Getting Help

- **Lean 4 Skills issues:** https://github.com/cameronfreer/lean4-skills/issues
- **Lean LSP server issues:** https://github.com/oOo0oOo/lean-lsp-mcp/issues
- **Claude Code help:** `/help` or https://docs.claude.com/en/docs/claude-code
