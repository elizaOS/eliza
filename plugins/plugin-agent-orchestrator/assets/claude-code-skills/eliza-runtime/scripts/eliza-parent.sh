#!/usr/bin/env bash
# Read parent Eliza runtime state via the bridge endpoints.
#
# Usage:
#   bash scripts/eliza-parent.sh context          # GET parent-context
#   bash scripts/eliza-parent.sh memory [query]   # GET memory?q=<query>
#   bash scripts/eliza-parent.sh peers            # GET active-workspaces
#
# All endpoints are read-only. The sub-agent cannot mutate parent state
# through this helper — only inspect.
#
# Endpoints come from the @elizaos/plugin-agent-orchestrator bridge routes
# (see references/hooks.md for the API contract). They require:
#   - PARALLAX_SESSION_ID set (this script's session is registered with the parent)
#   - The parent's API server reachable at localhost:$ELIZA_HOOK_PORT (default 2138)
#   - The session in non-terminal state (active or tool_running) — terminated
#     sessions return 410.
#
# Best-effort. If the bridge isn't available (older orchestrator without bridge
# routes, or network issue), the script reports the failure on stderr and
# exits non-zero so the caller can fall back to "no parent context".

set -u

CMD="${1:-help}"
ARG="${2:-}"

session_id="${PARALLAX_SESSION_ID:-}"
hook_port="${ELIZA_HOOK_PORT:-2138}"
base="http://localhost:$hook_port/api/coding-agents/$session_id"

# Help is always free; everything else needs an active session + curl.
if [ "$CMD" != "help" ] && [ "$CMD" != "--help" ] && [ "$CMD" != "-h" ]; then
    if [ -z "$session_id" ]; then
        echo "eliza-parent: PARALLAX_SESSION_ID is not set — not a Eliza session." >&2
        exit 1
    fi
    if ! command -v curl >/dev/null 2>&1; then
        echo "eliza-parent: curl not found in PATH — bridge endpoints unreachable." >&2
        exit 1
    fi
fi

call() {
    # call <path> — GET against $base/<path>, fail loudly on non-2xx.
    local path="$1"
    local url="$base/$path"
    local response status
    response=$(curl -s -w "%{http_code}" --max-time 5 "$url")
    status="${response: -3}"
    response="${response%???}"
    if [ "$status" = "200" ]; then
        printf '%s' "$response"
        return 0
    fi
    case "$status" in
        404) echo "eliza-parent: session $session_id is unknown to the parent (404). Is the bridge installed?" >&2 ;;
        410) echo "eliza-parent: session $session_id is in terminal state (410). Parent context no longer available." >&2 ;;
        000) echo "eliza-parent: parent unreachable at $url. Bridge may not be exposed on port $hook_port." >&2 ;;
        *)   echo "eliza-parent: unexpected HTTP $status from $url. Body: $response" >&2 ;;
    esac
    return 1
}

case "$CMD" in
    context|parent-context)
        # Pretty-print the parent context as key=value lines for easy parsing.
        body=$(call "parent-context") || exit 1
        printf '%s' "$body" | python3 -c "
import sys, json
d = json.load(sys.stdin)
character = d.get('character', {}) or {}
room = d.get('room')
print(f\"agent_label={d.get('agent_label')}\")
print(f\"workdir={d.get('workdir')}\")
print(f\"agent_type={d.get('agent_type')}\")
print(f\"repo={d.get('repo') or 'none'}\")
print(f\"character_name={character.get('name')}\")
bio = character.get('bio') or []
if isinstance(bio, list):
    print(f\"character_bio={' | '.join(bio[:3])[:300]}\" if bio else 'character_bio=')
else:
    print(f'character_bio={str(bio)[:300]}')
topics = character.get('topics') or []
print(f\"character_topics={','.join(topics[:8])}\" if topics else 'character_topics=')
if room:
    print(f\"room_id={room.get('id')}\")
    print(f\"thread_id={room.get('thread_id')}\")
else:
    print('room_id=')
    print('thread_id=')
print(f\"original_task={(d.get('original_task') or '')[:300]}\")
" 2>/dev/null || printf '%s\n' "$body"
        ;;
    memory)
        # Search memory in the originating room. Optional query string narrows results.
        if [ -n "$ARG" ]; then
            body=$(call "memory?q=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$ARG")&limit=10") || exit 1
        else
            body=$(call "memory?limit=10") || exit 1
        fi
        printf '%s' "$body" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f\"room_id={d.get('room_id')}\")
print(f\"count={d.get('count')}\")
print(f\"query={d.get('query') or '(none)'}\")
print('---')
for m in d.get('messages', []):
    print(f\"[{m.get('speaker','?')}] {m.get('text','')}\")
" 2>/dev/null || printf '%s\n' "$body"
        ;;
    peers|active-workspaces)
        body=$(call "active-workspaces") || exit 1
        printf '%s' "$body" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f\"peer_count={d.get('count')}\")
for w in d.get('workspaces', []):
    print(f\"- {w.get('label')} ({w.get('agent_type')}) workdir={w.get('workdir')} repo={w.get('repo') or 'none'}\")
" 2>/dev/null || printf '%s\n' "$body"
        ;;
    help|--help|-h|"")
        cat <<'HELP'
eliza-parent — read parent Eliza runtime state via bridge endpoints

  context     dump the agent's character, current room, workdir, original task
  memory [q]  read recent messages from the originating room (optional substring filter)
  peers       list active sibling sub-agents (sessions other than this one)

Notes:
  - Read-only. There is no write API.
  - Returns key=value lines on success; non-zero exit + stderr on failure.
  - Requires the parent's bridge routes (in @elizaos/plugin-agent-orchestrator).
    On older orchestrators without the bridge, calls return 404 — fall back
    to no-parent-context mode.
HELP
        ;;
    *)
        echo "eliza-parent: unknown command '$CMD' (try: context | memory | peers | help)" >&2
        exit 1
        ;;
esac
