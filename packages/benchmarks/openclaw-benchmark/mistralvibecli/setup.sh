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
# Mistral Vibe Configuration

[core]
# Enable auto-updates
enable_auto_update = true

[ui]
# Theme configuration can go here
theme = "default"

[tools]
# Tool configurations

patterns.safe = ["grep", "read_file", "ls"]
patterns.dangerous = ["bash", "write_file", "replace_symbol"]

[skills]
# Enable all skills by default for now
enabled_skills = ["*"]
EOF
else
    echo "    Config file already exists."
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
echo "══════════════════════════════════════════════"
echo "  ✅ SETUP COMPLETE"
echo "══════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Ensure you have MISTRAL_API_KEY set in $HOME/.vibe/.env or environment"
echo "  2. Run 'vibe' to start the CLI"
echo ""
