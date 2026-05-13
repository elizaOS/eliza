#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 NubsCarson and contributors
#
# AI-driven exploration tester. An LLM (cloud Claude via the `claude` CLI
# on the host) plays the role of a chaotic but reasonable user, throws
# inputs at the running VM, and watches for crashes, blank replies,
# stuck flows, or anything that looks "wrong." Way better at finding
# edge cases than a fixed regex probe set — the AI tries phrasings the
# human author didn't think of.
#
# Why this exists: deterministic smoke probes test what we already know
# to look for. Real users type things we never imagined ("yo whats my ip
# fr fr", "set up the wifi please thanks", "make me a wallpaper that
# screams 1995"). This harness routes a real LLM through /api/chat with
# the persona "you are a real user testing usbeliza for the first time;
# poke at edges, try weird phrasings, look for things that feel broken."
#
# Usage:
#   scripts/ai-monkey.sh                                 # 10 turns, port 2223
#   scripts/ai-monkey.sh --turns 30 --ssh-port 2233
#   scripts/ai-monkey.sh --model claude-sonnet-4-6       # cheaper model
#
# Prerequisites:
#   - A usbeliza VM running on the configured SSH port (scripts/run-vm.sh)
#   - `claude` CLI installed and signed in on the HOST (this script
#     uses the host's claude, not the VM's — we're driving the VM, not
#     using it for inference)
#   - jq for JSON munging
#
# Output goes to vm/snapshots/ai-monkey-<ts>/transcript.md — a markdown
# log of every turn (user input, agent reply, AI's reasoning for the
# next prompt). At the end the AI writes a "what I found" section
# summarizing issues observed.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

TURNS=10
SSH_PORT=2223
MODEL="claude-opus-4-7"

while (( $# )); do
    case "$1" in
        --turns) TURNS="$2"; shift 2 ;;
        --ssh-port) SSH_PORT="$2"; shift 2 ;;
        --model) MODEL="$2"; shift 2 ;;
        -h|--help) head -28 "$0" | tail -25; exit 0 ;;
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

SSH_KEY="vm/.ssh/usbeliza_dev_ed25519"
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -p "$SSH_PORT")

if ! ssh "${SSH_OPTS[@]}" -o ConnectTimeout=4 eliza@127.0.0.1 'true' 2>/dev/null; then
    echo "ERROR: VM not reachable on port $SSH_PORT. Run scripts/run-vm.sh first." >&2
    exit 1
fi
if ! command -v claude >/dev/null; then
    echo "ERROR: \`claude\` CLI not on PATH. Sign in with \`claude\` first." >&2
    exit 1
fi
if ! command -v jq >/dev/null; then
    echo "ERROR: jq required (apt install jq)." >&2
    exit 1
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
ART="vm/snapshots/ai-monkey-$TS"
mkdir -p "$ART"
TRANSCRIPT="$ART/transcript.md"

cat > "$TRANSCRIPT" <<EOF
# ai-monkey session $TS

VM SSH: 127.0.0.1:$SSH_PORT • Driver model: $MODEL • Turns: $TURNS

EOF

probe_vm() {
    local msg="$1"
    local body
    body="$(jq -nc --arg m "$msg" '{message:$m}')"
    ssh "${SSH_OPTS[@]}" eliza@127.0.0.1 \
        "curl -sf -X POST http://127.0.0.1:41337/api/chat -H 'Content-Type: application/json' --data-binary @- --max-time 60" \
        <<< "$body" 2>/dev/null \
        | jq -r '.reply // "<no reply / agent error>"'
}

ai_next_input() {
    # Ask claude to propose the next user input given the conversation
    # so far. We pin the persona + the goal in the system prompt so the
    # model stays focused on exploration vs writing essays.
    local history="$1"
    local prompt
    prompt="$(cat <<EOF
You are roleplaying as a real new user of "usbeliza" — a Debian live-USB
OS where the entire desktop is a chat box with an AI named Eliza. You
just booted it for the first time. The agent supports actions like:
help, list models, list/build/open/delete apps, set wallpaper, list
wifi, network status, login claude, login codex, open URLs, setup
persistence, and freeform chat.

YOUR JOB: poke at the system like a curious user. Try ONE input at a
time. Vary phrasing, throw in slang, attempt edge cases (empty input,
unicode, very long input, malformed requests), test multi-turn flows,
ask things the system might not know how to handle. Look for replies
that feel broken, repetitive, blank, or robotic.

After reading the conversation so far, output EXACTLY this:

NEXT: <one short user input — usually under 80 chars>
NOTE: <one short note about what you're probing for>

Don't quote, don't preface, just those two lines.

Conversation so far:
$history
EOF
)"
    claude --print --model "$MODEL" "$prompt" 2>/dev/null | head -10
}

ai_summary() {
    local history="$1"
    local prompt
    prompt="$(cat <<EOF
You just spent $TURNS turns exploration-testing usbeliza. Below is the
full transcript. Write a SHORT punch list (markdown, under 200 words)
of things you noticed: bugs, weird replies, paths that felt confused,
edge cases the agent didn't handle, anything a real user would call out.
If everything looked good, say so plainly.

Transcript:
$history
EOF
)"
    claude --print --model "$MODEL" "$prompt" 2>/dev/null
}

echo "==> AI monkey session, $TURNS turns. Transcript: $TRANSCRIPT"

history=""
for ((i=1; i<=TURNS; i++)); do
    next="$(ai_next_input "$history")"
    user_input="$(echo "$next" | grep -E '^NEXT:' | head -1 | sed 's/^NEXT:\s*//')"
    note="$(echo "$next" | grep -E '^NOTE:' | head -1 | sed 's/^NOTE:\s*//')"
    if [[ -z "$user_input" ]]; then
        user_input="hi there"
        note="(AI gave no NEXT — falling back)"
    fi

    printf '\n--- turn %d ---\n' "$i"
    printf 'user: %s\n' "$user_input"
    printf 'note: %s\n' "$note"

    reply="$(probe_vm "$user_input")"
    printf 'agent: %.200s\n' "$reply"

    {
        echo
        echo "## Turn $i"
        echo
        echo "**AI's note:** $note"
        echo
        echo "**user:** \`$user_input\`"
        echo
        echo "**agent:** $reply"
    } >> "$TRANSCRIPT"

    history+=$'\n'"User: $user_input"$'\n'"Eliza: $reply"
done

echo
echo "==> Asking AI for a summary of findings..."
summary="$(ai_summary "$history")"
{
    echo
    echo "---"
    echo
    echo "## Findings"
    echo
    echo "$summary"
} >> "$TRANSCRIPT"

echo "==> Summary written to $TRANSCRIPT"
echo
echo "--- Findings ---"
echo "$summary"
