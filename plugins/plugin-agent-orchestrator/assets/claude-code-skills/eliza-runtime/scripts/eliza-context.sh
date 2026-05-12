#!/usr/bin/env bash
# Print the orchestration context for the current Eliza sub-agent session.
#
# Usage: bash scripts/eliza-context.sh
#
# Output is `key=value` lines, grep/sed-friendly, parseable from prose.
#
# Detection covers all three Eliza spawn variants:
#   - swarm     (multi-agent CREATE_TASK; CLAUDE.md present, hooks installed)
#   - repo      (single-agent CREATE_TASK in a real repo; CLAUDE.md absent, hooks installed)
#   - scratch   (SPAWN_AGENT in a scratch workspace; CLAUDE.md absent, hooks NOT installed)
#
# The variant matters because hook-dependent features (e.g. structured DECISION
# events via the parent's HTTP endpoint) only work in `swarm` and `repo`.
# In `scratch`, your durable channel is stdout — emit `DECISION: ...` lines
# there and the orchestrator captures them from the PTY tail.

set -u

session_id="${PARALLAX_SESSION_ID:-}"
hook_port="${ELIZA_HOOK_PORT:-2138}"
workdir="$PWD"
agent_user="$USER"
model="${ANTHROPIC_MODEL:-unset}"
small_model="${ANTHROPIC_SMALL_FAST_MODEL:-unset}"
github_token_set="$([ -n "${GITHUB_TOKEN:-}" ] && echo yes || echo no)"

# Detect Eliza-injected files in this workspace.
claude_md_present="no"
claude_settings_present="no"
hook_url_in_settings="no"
allowed_dirs_in_settings="no"
[ -f "$workdir/CLAUDE.md" ] && claude_md_present="yes"
if [ -f "$workdir/.claude/settings.json" ]; then
    claude_settings_present="yes"
    grep -q "coding-agents/hooks" "$workdir/.claude/settings.json" 2>/dev/null && hook_url_in_settings="yes"
    grep -q "allowedDirectories" "$workdir/.claude/settings.json" 2>/dev/null && allowed_dirs_in_settings="yes"
fi

# Best-effort: extract task label from CLAUDE.md when present.
agent_label="unknown"
if [ "$claude_md_present" = "yes" ]; then
    label=$(grep -oE 'You are agent "[^"]+"' "$workdir/CLAUDE.md" 2>/dev/null | head -1 | sed -E 's/.*"([^"]+)".*/\1/')
    [ -n "$label" ] && agent_label="$label"
fi

# Variant detection from observed signals.
# Source-of-truth signals:
#   CLAUDE.md present + hooks in settings  → swarm
#   CLAUDE.md absent  + hooks in settings  → repo
#   CLAUDE.md absent  + no  hooks          → scratch
#   anything else                          → unknown
variant="unknown"
if [ "$claude_md_present" = "yes" ] && [ "$hook_url_in_settings" = "yes" ]; then
    variant="swarm"
elif [ "$claude_md_present" = "no" ] && [ "$hook_url_in_settings" = "yes" ]; then
    variant="repo"
elif [ "$claude_md_present" = "no" ] && [ "$hook_url_in_settings" = "no" ] && [ -n "$session_id" ]; then
    variant="scratch"
fi

# What features are available in this variant?
#   stdout DECISION pickup       → ALWAYS works (orchestrator tails PTY)
#   HTTP hook events             → works in swarm + repo
#   CLAUDE.md task brief         → exists only in swarm
hooks_available="no"
[ "$hook_url_in_settings" = "yes" ] && hooks_available="yes"

claude_md_brief="no"
[ "$claude_md_present" = "yes" ] && claude_md_brief="yes"

cat <<KV
session_id=$session_id
agent_user=$agent_user
agent_label=$agent_label
workdir=$workdir
variant=$variant
parent_hook_url=http://localhost:$hook_port/api/coding-agents/hooks
hooks_available=$hooks_available
claude_md_brief=$claude_md_brief
claude_settings_present=$claude_settings_present
allowed_dirs_in_settings=$allowed_dirs_in_settings
hook_url_in_settings=$hook_url_in_settings
model=$model
small_model=$small_model
github_token_set=$github_token_set
KV

if [ -z "$session_id" ]; then
    echo "advice=PARALLAX_SESSION_ID is unset — eliza-runtime skill does not apply to this session." >&2
    exit 1
fi

if [ "$variant" = "scratch" ]; then
    cat >&2 <<'ADVICE'
advice=variant=scratch — HTTP hooks are NOT installed for scratch tasks.
       Your durable channel back to the parent is stdout.
       Use plain `DECISION: ...` lines in your output (the orchestrator
       tails PTY output and captures them via grep). The
       `scripts/eliza-decision.sh` helper still works (echoes to stdout
       AND best-efforts the HTTP POST), but only the stdout half lands.
ADVICE
fi
