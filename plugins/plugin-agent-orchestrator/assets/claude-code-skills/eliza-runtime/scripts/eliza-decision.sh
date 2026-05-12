#!/usr/bin/env bash
# Emit an explicit DECISION event to the Eliza orchestrator's hook channel.
#
# Usage: bash scripts/eliza-decision.sh "your decision text"
#
# Writes the same structured shape Eliza's swarm-decision-loop captures
# from your stdout. Use this when you want the decision recorded by the
# orchestrator regardless of whether the orchestrator is currently
# scanning your stdout (e.g. you've moved to a new turn but want the
# decision attributed to the prior step).
#
# Best-effort. Failures are logged to stderr but never fatal — the
# orchestrator's primary capture path is your stdout, and this is just
# a complementary out-of-band channel.

set -u

if [ -z "${1:-}" ]; then
    echo "usage: eliza-decision.sh \"your decision text\"" >&2
    exit 1
fi

decision_text="$1"
session_id="${PARALLAX_SESSION_ID:-}"
hook_port="${ELIZA_HOOK_PORT:-2138}"

if [ -z "$session_id" ]; then
    echo "eliza-decision: PARALLAX_SESSION_ID unset — not a Eliza session, skipping." >&2
    exit 1
fi

# Echo it to stdout so the primary capture path also picks it up.
# Eliza's swarm-decision-loop greps for "DECISION:" prefix in raw output.
printf 'DECISION: %s\n' "$decision_text"

# Best-effort hook POST — if curl is missing or the parent is unreachable,
# the stdout echo above is the durable record.
if command -v curl >/dev/null 2>&1; then
    curl --silent --max-time 3 \
        -X POST "http://localhost:$hook_port/api/coding-agents/hooks" \
        -H "content-type: application/json" \
        -d "$(printf '{"event":"decision","sessionId":"%s","data":{"text":%s}}' \
            "$session_id" \
            "$(printf '%s' "$decision_text" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))' 2>/dev/null \
               || printf '"%s"' "$decision_text")")" \
        >/dev/null 2>&1 \
        || echo "eliza-decision: hook POST failed (stdout echo above is the record)" >&2
fi
