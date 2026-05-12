#!/bin/bash
# sync_skills.sh - Synchronizes skills from external libraries into .vibe/skills/

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$SCRIPT_DIR/.isolated_home/.vibe/skills"
SOURCES_DIR="$SCRIPT_DIR/references/skills-sources"

echo "=== Skill Synchronization Script ==="
echo ""

# Ensure skills directory exists
mkdir -p "$SKILLS_DIR"

# --- Anthropic Skills ---
ANTHROPIC_SKILLS="$SOURCES_DIR/anthropics-skills/skills"
if [ -d "$ANTHROPIC_SKILLS" ]; then
    echo "📦 Syncing Anthropic Skills..."
    for skill_dir in "$ANTHROPIC_SKILLS"/*/; do
        skill_name=$(basename "$skill_dir")
        target="$SKILLS_DIR/anthropic-$skill_name"
        
        # Skip if already exists
        if [ -d "$target" ]; then
            continue
        fi
        
        # Check if SKILL.md exists
        if [ -f "$skill_dir/SKILL.md" ]; then
            cp -r "$skill_dir" "$target"
            echo "  ✅ anthropic-$skill_name"
        fi
    done
    echo ""
fi

# --- wshobson Agents/Plugins (nested structure: plugins/*/skills/*/) ---
WSHOBSON_PLUGINS="$SOURCES_DIR/wshobson-agents/plugins"
if [ -d "$WSHOBSON_PLUGINS" ]; then
    echo "📦 Syncing wshobson Skills (nested)..."
    
    # Find all SKILL.md files recursively
    find "$WSHOBSON_PLUGINS" -name "SKILL.md" -type f | while read skill_file; do
        skill_dir=$(dirname "$skill_file")
        skill_name=$(basename "$skill_dir")
        target="$SKILLS_DIR/ws-$skill_name"
        
        # Skip if already exists
        if [ -d "$target" ]; then
            continue
        fi
        
        cp -r "$skill_dir" "$target"
        echo "  ✅ ws-$skill_name"
    done
    echo ""
fi

# Count total skills
total_skills=$(find "$SKILLS_DIR" -maxdepth 1 -type d | wc -l)
total_skills=$((total_skills - 1))  # Subtract 1 for the skills dir itself

echo "==================================="
echo "✨ Total skills available: $total_skills"
echo ""
echo "Skills are located in:"
echo "  $SKILLS_DIR"
echo ""
echo "To update skills from upstream, run:"
echo "  cd references/skills-sources/anthropics-skills && git pull"
echo "  cd references/skills-sources/wshobson-agents && git pull"
echo "  ./sync_skills.sh"
