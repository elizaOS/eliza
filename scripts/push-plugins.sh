#!/usr/bin/env bash
set -euo pipefail

# Script to initialize each plugin as its own git repo and push to
# https://github.com/elizaos-plugins/plugin-<name> on the 'next' branch.
#
# Idempotent: safe to re-run. Skips plugins already pushed.
#
# Prerequisites:
#   - gh CLI authenticated with access to elizaos-plugins org
#   - git configured with push credentials
#
# Usage:
#   ./scripts/push-plugins.sh          # process all plugins
#   ./scripts/push-plugins.sh discord   # process only plugin-discord

PLUGINS_DIR="$(cd "$(dirname "$0")/../plugins" && pwd)"
ORG="elizaos-plugins"

# Comprehensive gitignore entries that MUST be present
REQUIRED_GITIGNORE_ENTRIES=(
  "dist"
  "node_modules"
  ".env"
  ".elizadb"
  ".turbo"
  "target/"
  "__pycache__"
  "*.pyc"
  ".venv"
  "*.egg-info"
  ".DS_Store"
  "package-lock.json"
)

# If a specific plugin name is passed, only process that one
FILTER="${1:-}"

success_count=0
fail_count=0
skip_count=0
failed_plugins=()

ensure_gitignore() {
  local dir="$1"
  local gitignore="$dir/.gitignore"

  if [ ! -f "$gitignore" ]; then
    # Create from scratch
    printf '%s\n' "${REQUIRED_GITIGNORE_ENTRIES[@]}" > "$gitignore"
    echo "  -> Created .gitignore"
    return
  fi

  # Append any missing entries
  local added=0
  for entry in "${REQUIRED_GITIGNORE_ENTRIES[@]}"; do
    if ! grep -qxF "$entry" "$gitignore"; then
      echo "$entry" >> "$gitignore"
      added=$((added + 1))
    fi
  done
  if [ "$added" -gt 0 ]; then
    echo "  -> Updated .gitignore (+${added} entries)"
  fi
}

for plugin_path in "$PLUGINS_DIR"/plugin-*; do
  [ -d "$plugin_path" ] || continue

  dirname="$(basename "$plugin_path")"

  # If filter is set, skip non-matching plugins
  if [ -n "$FILTER" ] && [ "$dirname" != "plugin-$FILTER" ]; then
    continue
  fi

  echo "============================================"
  echo "Processing: $dirname"
  echo "============================================"

  cd "$plugin_path"

  # Ensure comprehensive .gitignore
  ensure_gitignore "$plugin_path"

  # Initialize git repo if needed
  if [ -d .git ]; then
    echo "  -> Already a git repo"
    # Check if already pushed to next successfully
    if git rev-parse --verify origin/next &>/dev/null 2>&1; then
      echo "  -> origin/next already exists, checking for changes..."
      git add -A
      if git diff --cached --quiet; then
        echo "  -> No changes, skipping"
        skip_count=$((skip_count + 1))
        echo ""
        continue
      else
        echo "  -> New changes detected, committing..."
      fi
    fi
  else
    git init -b next
    echo "  -> Initialized git repo"
  fi

  # Set remote origin (idempotent)
  remote_url="https://github.com/${ORG}/${dirname}.git"
  if git remote get-url origin &>/dev/null; then
    existing="$(git remote get-url origin)"
    if [ "$existing" != "$remote_url" ]; then
      git remote set-url origin "$remote_url"
    fi
  else
    git remote add origin "$remote_url"
  fi
  echo "  -> Remote: $remote_url"

  # Stage and commit
  git add -A
  if git diff --cached --quiet; then
    echo "  -> Nothing to commit"
  else
    git commit -m "initial commit"
    echo "  -> Committed"
  fi

  # Ensure branch is named 'next'
  current_branch="$(git branch --show-current 2>/dev/null || echo "")"
  if [ -n "$current_branch" ] && [ "$current_branch" != "next" ]; then
    git branch -M next
  fi

  # Create GitHub repo if it doesn't exist
  if ! gh repo view "${ORG}/${dirname}" &>/dev/null 2>&1; then
    echo "  -> Creating repo ${ORG}/${dirname} on GitHub..."
    if gh repo create "${ORG}/${dirname}" --public -y 2>&1; then
      echo "  -> Repo created"
      sleep 2  # Give GitHub a moment
    else
      echo "  -> FAILED to create repo"
      fail_count=$((fail_count + 1))
      failed_plugins+=("$dirname")
      echo ""
      continue
    fi
  else
    echo "  -> Repo exists on GitHub"
  fi

  # Push to next (force to handle any divergence on re-runs)
  echo "  -> Pushing to origin/next..."
  if git push -u origin next --force 2>&1; then
    echo "  -> SUCCESS"
    success_count=$((success_count + 1))
  else
    echo "  -> FAILED to push"
    fail_count=$((fail_count + 1))
    failed_plugins+=("$dirname")
  fi

  echo ""
done

echo "============================================"
echo "DONE"
echo "============================================"
echo "  Pushed:  $success_count"
echo "  Skipped: $skip_count"
echo "  Failed:  $fail_count"
if [ ${#failed_plugins[@]} -gt 0 ]; then
  echo ""
  echo "  Failed plugins:"
  for p in "${failed_plugins[@]}"; do
    echo "    - $p"
  done
fi
