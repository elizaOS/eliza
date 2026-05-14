#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
source_script="$script_dir/eliza-assistant-handoff.sh"
target_dir="${ELIZA_SHORTCUT_INSTALL_DIR:-$HOME/Library/Application Support/elizaOS/Shortcuts}"
target_script="$target_dir/eliza-assistant-handoff.sh"

if [ ! -f "$source_script" ]; then
  echo "install-eliza-shortcuts: missing handoff script: $source_script" >&2
  exit 1
fi

mkdir -p "$target_dir"
cp "$source_script" "$target_script"
chmod 755 "$target_script"

dry_run_url="$("$target_script" --dry-run "remind me to test Eliza Shortcuts")"

cat <<EOF
Installed Eliza macOS Shortcuts handoff helper:
  $target_script

Dry-run URL:
  $dry_run_url

Create the user-facing Shortcut in the macOS Shortcuts app:
  1. New Shortcut named "Ask Eliza".
  2. Add "Ask for Input" with Text input.
  3. Add "Run Shell Script".
  4. Set "Pass Input" to stdin.
  5. Use this shell body:
       "$target_script"

Optional LifeOps-focused shortcut:
  Use the same shell body with an action override:
       ELIZA_SHORTCUT_ACTION=lifeops.create "$target_script"

Verification:
  printf 'remind me to stand up in 20 minutes' | "$target_script" --dry-run
  printf 'remind me to stand up in 20 minutes' | "$target_script"
  shortcuts run "Ask Eliza" --input-path -

The Shortcut creation itself remains a macOS UI step because shortcuts(1) can
run, list, view, and sign shortcuts, but creation/editing is owned by the
Shortcuts app.
EOF
