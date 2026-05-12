#!/bin/bash
# scripts/init_env.sh
# Initializes the Autonomous Coding Environment

set -e

# 1. Setup Shared Memory (Symlinks)
echo "🔗 Linking Memory..."
# We want memory to be shared across all branches/worktrees.
# Strategy: Keep memory in .git/memory (safe from branch switches) and symlink it.
mkdir -p .git/global_memory
if [ ! -f .git/global_memory/RULES.md ]; then
    cp memory/RULES.md .git/global_memory/
fi
# Force symlink
ln -sf $(pwd)/.git/global_memory/RULES.md memory/RULES.md

# 2. Setup Worktree Directory
echo "🌳 Setting up Worktrees..."
mkdir -p .worktrees
echo ".worktrees" >> .gitignore

# 3. Create Standard Slots
# Planner (Main) - we are here.
# Builder Slot 1
if [ ! -d ".worktrees/builder-1" ]; then
    git worktree add -b feat/builder-1 .worktrees/builder-1 main
    echo "✅ Created Builder-1 Worktree"
fi

echo "🚀 Environment Ready. Use './scripts/dispatch_task.sh <task_id>' to start."
