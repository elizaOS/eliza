#!/bin/bash
set -e

echo "══════════════════════════════════════════════"
echo "  🌊 SETUP: Mistral Vibe CLI"
echo "══════════════════════════════════════════════"
echo ""

# Ensure we are in the Nix environment
if [ -z "$ISOLATED_HOME" ]; then
    echo "❌ Error: Please run 'nix develop' or 'direnv allow' first!"
    echo "   Then: './setup.sh'"
    exit 1
fi

echo "📁 Installing to: $HOME"
echo ""

# 1. Install Mistral Vibe
echo ">>> Installing Mistral Vibe..."
uv tool install mistral-vibe

# 2. Initialize Vibe Configuration
echo ""
echo ">>> Initializing Vibe Configuration..."

VIBE_HOME="$HOME/.vibe"
mkdir -p "$VIBE_HOME"

CONFIG_FILE="$VIBE_HOME/config.toml"
if [ ! -f "$CONFIG_FILE" ]; then
    echo "Creating default config.toml..."
    cat <<EOF > "$CONFIG_FILE"
# =============================================================================
# Mistral Vibe CLI Configuration
# =============================================================================

# Active model (alias from models list below)
active_model = "devstral-2"

# UI settings
textual_theme = "terminal"
vim_keybindings = false

# Auto-approve dangerous operations (false = ask before file edits, commands)
auto_approve = false

# Context and session settings
auto_compact_threshold = 200_000
context_warnings = false

# =============================================================================
# Skill Paths
# =============================================================================
# Additional directories to search for skills
skill_paths = []

# Enable/disable specific skills (supports glob patterns)
# enabled_skills = ["anthropic-*", "ws-python-*"]
# disabled_skills = ["experimental-*"]

# =============================================================================
# MCP Servers (External Tool Integrations)
# =============================================================================
# Uncomment and configure servers you want to use.
# API keys are read from environment variables (set in .env)

# --- Web Fetch Server ---
[[mcp_servers]]
name = "fetch"
transport = "stdio"
command = "uvx"
args = ["mcp-server-fetch"]

# --- Filesystem Server (example for specific directories) ---
# [[mcp_servers]]
# name = "filesystem"
# transport = "stdio"
# command = "npx"
# args = ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]

# --- GitHub Server ---
# [[mcp_servers]]
# name = "github"
# transport = "stdio"
# command = "npx"
# args = ["-y", "@modelcontextprotocol/server-github"]
# env = { "GITHUB_PERSONAL_ACCESS_TOKEN" = "\${GITHUB_TOKEN}" }

# --- Brave Search Server ---
# [[mcp_servers]]
# name = "brave_search"
# transport = "stdio"
# command = "npx"
# args = ["-y", "@modelcontextprotocol/server-brave-search"]
# env = { "BRAVE_API_KEY" = "\${BRAVE_API_KEY}" }

# --- Puppeteer Browser Server ---
# [[mcp_servers]]
# name = "puppeteer"
# transport = "stdio"
# command = "npx"
# args = ["-y", "@modelcontextprotocol/server-puppeteer"]

# =============================================================================
# Tool Permissions
# =============================================================================
[tools.bash]
# permission = "always"
# permission = "ask"

[tools.write_file]
# permission = "always"

# =============================================================================
# Session Logging
# =============================================================================
[session_logging]
enabled = true
EOF
else
    echo "    Config file already exists."
fi

ENV_EXAMPLE_FILE="$VIBE_HOME/.env.example"
if [ ! -f "$ENV_EXAMPLE_FILE" ]; then
    echo "Creating default .env.example..."
    cat <<EOF > "$ENV_EXAMPLE_FILE"
# Required
MISTRAL_API_KEY=your_key_here

# Optional LLM providers
ANTHROPIC_API_KEY=
OPENAI_API_KEY=

# Optional MCP and search integrations
GITHUB_TOKEN=
BRAVE_API_KEY=
SERPER_API_KEY=
TAVILY_API_KEY=
EOF
else
    echo "    .env.example already exists."
fi

# 3. Create Hello World Skill
echo ""
echo ">>> Creating Hello World Skill..."
SKILL_DIR="$VIBE_HOME/skills/hello-world"
mkdir -p "$SKILL_DIR"

cat <<EOF > "$SKILL_DIR/SKILL.md"
---
name: hello-world
description: A simple hello world skill for Mistral Vibe
user-invocable: true
---

# Hello World Skill

This skill provides a simple hello world command.

## Tools

### \`hello_world\`

Prints a hello world message.

\`\`\`python
def hello_world(name: str = "World") -> str:
    """
    Prints a hello world message.
    
    Args:
        name: The name to greet. Defaults to "World".
    """
    return f"Hello, {name}! Welcome to Mistral Vibe."
\`\`\`
EOF

echo "    Skill created at $SKILL_DIR"

echo ""
echo ">>> Syncing Optional Skill Libraries..."
if [ -d "$SCRIPT_DIR/references/skills-sources" ]; then
    "$SCRIPT_DIR/sync_skills.sh"
else
    echo "    No references/skills-sources directory found."
    echo "    Clone upstream skill repos there, then run ./sync_skills.sh."
fi


echo ""
echo "══════════════════════════════════════════════"
echo "  ✅ SETUP COMPLETE"
echo "══════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Ensure you have MISTRAL_API_KEY set in $HOME/.vibe/.env or environment"
echo "  2. Run 'vibe' to start the CLI"
echo ""
