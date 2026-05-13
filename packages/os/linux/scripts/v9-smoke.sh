#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 NubsCarson and contributors
#
# Autonomous smoke harness for usbeliza live ISOs.
#
# Boots the latest ISO headless under QEMU/KVM (no GTK window), waits for
# SSH on :2223, then runs a battery of chat probes against the booted
# eliza-agent via curl-over-SSH. Captures screenshots via QMP screendump
# at each step. Tear-down via QMP "quit".
#
# Usage:
#   scripts/v9-smoke.sh                                # default: out/usbeliza-v*-final-amd64.iso, newest first
#   scripts/v9-smoke.sh out/usbeliza-v9-final-amd64.iso  # explicit
#
# Exit codes:
#   0   all probes passed
#   1   boot timed out (no SSH after 5 min)
#   2   one or more probes asserted FAIL
#   3   setup error (QEMU not installed, no ISO found, etc)
#
# Artifacts written to vm/snapshots/v9-smoke-<TS>/:
#   screen-<step>.png         — screenshot at each probe step
#   chat-<step>.json          — captured /api/chat response
#   journal-<unit>.log        — systemctl status + journal for each agent service
#   summary.md                — markdown table of probe → expected → got → PASS/FAIL

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

ISO="${1:-}"
if [[ -z "$ISO" ]]; then
    ISO="$(ls -t out/usbeliza-v*-final-amd64.iso 2>/dev/null | head -1)" || true
fi
if [[ -z "$ISO" || ! -f "$ISO" ]]; then
    echo "ERROR: no ISO found. Pass a path or run \`just iso-build\` first." >&2
    exit 3
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
ARTIFACTS="vm/snapshots/v9-smoke-$TS"
mkdir -p "$ARTIFACTS"

QMP_SOCK="vm/snapshots/v9-smoke-qmp.sock"
SERIAL_SOCK="vm/snapshots/v9-smoke-serial.sock"
SSH_PORT=2223
SSH_KEY="vm/.ssh/usbeliza_dev_ed25519"

echo "==> ISO:        $ISO"
echo "==> Artifacts:  $ARTIFACTS"

cleanup() {
    local rc=$?
    if [[ -S "$QMP_SOCK" ]]; then
        printf '{"execute":"qmp_capabilities"}\n{"execute":"quit"}\n' \
            | timeout 5 socat - "UNIX-CONNECT:$QMP_SOCK" >/dev/null 2>&1 || true
    fi
    sudo pkill -9 -f "qemu-system-x86_64.*v9-smoke" 2>/dev/null || true
    rm -f "$QMP_SOCK" "$SERIAL_SOCK"
    exit "$rc"
}
trap cleanup EXIT INT TERM

echo "==> Launching QEMU headless"
nohup sudo -n qemu-system-x86_64 \
    -enable-kvm -cpu host -m 4G -smp 4 \
    -cdrom "$ISO" -boot d \
    -netdev "user,id=net0,hostfwd=tcp::${SSH_PORT}-:22" \
    -device virtio-net-pci,netdev=net0 \
    -nographic \
    -vga none -device virtio-vga,xres=1920,yres=1080 \
    -display none \
    -qmp "unix:${QMP_SOCK},server,nowait" \
    -serial "unix:${SERIAL_SOCK},server,nowait" \
    -name v9-smoke \
    > "$ARTIFACTS/qemu.log" 2>&1 &
QEMU_PID=$!
echo "==> QEMU pid: $QEMU_PID"

# Permission-fix the sockets so non-root socat / ssh can hit them.
for s in "$QMP_SOCK" "$SERIAL_SOCK"; do
    for _ in $(seq 1 30); do
        [[ -S "$s" ]] && break
        sleep 0.5
    done
    sudo chmod 660 "$s" 2>/dev/null || true
done

echo "==> Waiting for SSH on :$SSH_PORT (up to 5 min)..."
DEADLINE=$(( SECONDS + 300 ))
while (( SECONDS < DEADLINE )); do
    if ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o LogLevel=ERROR -o ConnectTimeout=4 -p "$SSH_PORT" eliza@127.0.0.1 \
        'true' 2>/dev/null; then
        echo "==> SSH ready after $SECONDS seconds"
        break
    fi
    sleep 4
done
if ! ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR -o ConnectTimeout=4 -p "$SSH_PORT" eliza@127.0.0.1 'true' 2>/dev/null; then
    echo "ERROR: SSH never came up. See $ARTIFACTS/qemu.log + serial-socket dump." >&2
    timeout 5 socat - "UNIX-CONNECT:$SERIAL_SOCK" > "$ARTIFACTS/serial.log" 2>&1 || true
    exit 1
fi

# SSH ready doesn't mean eliza-agent is listening yet. The agent boots in
# parallel (After=network-online.target live-config.service) but its
# `bun run src/main.ts` takes 5-15s to bind 127.0.0.1:41337. Wait for
# /api/status to actually respond OK before any chat probes fire.
echo "==> Waiting for eliza-agent /api/status (up to 2 min)..."
AGENT_DEADLINE=$(( SECONDS + 120 ))
while (( SECONDS < AGENT_DEADLINE )); do
    if ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o LogLevel=ERROR -p "$SSH_PORT" eliza@127.0.0.1 \
        'curl -sf --max-time 3 http://127.0.0.1:41337/api/status' \
        2>/dev/null | grep -q '"state":"ready"'; then
        echo "==> eliza-agent ready after $SECONDS seconds"
        break
    fi
    sleep 3
done

ssh_cmd() {
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o LogLevel=ERROR -p "$SSH_PORT" eliza@127.0.0.1 "$@"
}

# Pre-seed `~/.eliza/calibration.toml` so /api/chat probes hit the action
# surface directly instead of going through the onboarding state machine
# (which only fires when `USBELIZA_SERVER_ONBOARDING=1`, off by default
# on the live ISO where elizad's Tauri UI owns onboarding). This makes
# the smoke probes test the same chat surface a real user sees AFTER
# they finish onboarding through the UI.
echo "==> Pre-seeding ~/.eliza/calibration.toml on guest"
# Always clear any leftover flow state — a previous run that exited
# mid-flow would otherwise capture every probe's reply with the flow's
# "still waiting on you" prompt.
ssh_cmd 'rm -f ~/.eliza/flow.toml ~/.eliza/onboarding.toml'
ssh_cmd 'mkdir -p ~/.eliza && cat > ~/.eliza/calibration.toml <<TOML
schema_version = 1
created_at = "2026-05-11T00:00:00Z"
name = "Sam"
work_focus = "writing code"
multitasking = "multi-task"
chronotype = "morning"
error_communication = "transparent"
keyboard_layout = "us"
language = "en_US.UTF-8"
timezone = "UTC"
wifi_offer_accepted = false
claude_offer_accepted = false
TOML
'

screenshot() {
    local name="$1"
    local out="$ARTIFACTS/screen-${name}.ppm"
    printf '{"execute":"qmp_capabilities"}\n{"execute":"screendump","arguments":{"filename":"%s"}}\n' "$out" \
        | timeout 5 socat - "UNIX-CONNECT:$QMP_SOCK" > /dev/null 2>&1 || true
    # qemu writes a PPM; convert to PNG via ImageMagick for easier viewing
    if [[ -f "$out" ]] && command -v convert >/dev/null 2>&1; then
        convert "$out" "$ARTIFACTS/screen-${name}.png" 2>/dev/null && rm -f "$out"
    fi
}

probe() {
    local name="$1"
    local message="$2"
    local expect_re="$3"
    local timeout="${4:-30}"
    local response
    # JSON-encode the message via jq so apostrophes (e.g. "what's my battery")
    # don't break the curl -d single-quote wrapper. Then pipe it to curl
    # over stdin instead of embedding in argv, which sidesteps the
    # double-shell-escape (local bash → remote bash → curl).
    local json_body
    json_body="$(jq -nc --arg m "$message" '{message:$m}')"
    response="$(ssh_cmd "curl -sf -X POST http://127.0.0.1:41337/api/chat \
        -H 'Content-Type: application/json' --data-binary @- --max-time $timeout" \
        <<< "$json_body" || true)"
    printf '%s\n' "$response" > "$ARTIFACTS/chat-${name}.json"
    local reply
    reply="$(printf '%s' "$response" | jq -r '.reply // "<no reply>"' 2>/dev/null || printf '%s' "$response")"
    screenshot "$name"
    # Case-insensitive (-i) so "Hello, I'm Eliza" matches /hello/. Probes
    # use the lowercase form by convention; -i lets a probe pass when the
    # reply opens with a capital letter (which most do).
    if printf '%s' "$reply" | grep -qEi "$expect_re"; then
        printf '  PASS  %-22s  "%s..."\n' "$name" "$(printf '%s' "$reply" | head -c 60)"
        return 0
    fi
    printf '  FAIL  %-22s  "%s..."  (expected /%s/)\n' "$name" "$(printf '%s' "$reply" | head -c 60)" "$expect_re"
    return 1
}

PASS=0; FAIL=0
{
    echo "# v9 smoke results — $(date -u +%FT%TZ)"
    echo
    echo "ISO: \`$ISO\`"
    echo
    echo "| probe | result | reply |"
    echo "|---|---|---|"
} > "$ARTIFACTS/summary.md"

run_probe() {
    local name="$1" message="$2" expect_re="$3" timeout="${4:-30}"
    if probe "$name" "$message" "$expect_re" "$timeout"; then
        PASS=$((PASS+1))
        local reply
        reply="$(jq -r '.reply // "<no reply>"' "$ARTIFACTS/chat-${name}.json" 2>/dev/null | head -c 80 | tr '\n' ' ')"
        echo "| $name | ✓ | $reply... |" >> "$ARTIFACTS/summary.md"
    else
        FAIL=$((FAIL+1))
        local reply
        reply="$(jq -r '.reply // "<no reply>"' "$ARTIFACTS/chat-${name}.json" 2>/dev/null | head -c 80 | tr '\n' ' ')"
        echo "| $name | ✗ | $reply... |" >> "$ARTIFACTS/summary.md"
    fi
}

echo
echo "==> Probe battery — post-onboarding action surface (calibration.toml pre-seeded)"

# Onboarding state was pre-seeded above so /api/chat probes hit the
# action surface immediately. Each probe asserts a regex against the
# returned `reply` string. Tight regexes for deterministic actions;
# looser for paths that touch the local llama (chat fallthrough).

# Help catalog
run_probe "01-help"                "help"                            "build|small apps|talk to me"
# Network status (NetworkManager + nmcli ship on the ISO)
run_probe "02-am-i-online"         "am i online"                     "Online|IP|10\\.|offline"
# Local-inference catalog read
run_probe "03-list-models"         "list models"                     "Llama|GB|model"
# Apps list (empty on first boot)
run_probe "04-list-apps-empty"     "list my apps"                    "build me|haven't built|none yet|nothing"
# Battery from /sys/class/power_supply
run_probe "05-battery"             "what's my battery"               "battery|AC power|%|don't see"
# Current time honoring calibrated timezone (UTC for the seeded calibration).
# Use [0-9] not \d — grep -E (POSIX ERE) doesn't expand the PCRE escape.
run_probe "06-current-time"        "what time is it"                 ":[0-9]"
# Build path — codegen stub writes a manifest (USBELIZA_CODEGEN_STUB=1)
run_probe "07-build-clock"         "build me a clock"                "clock|Built|Building|Opening"   60
# Open path — clock was just built so should cache-hit
run_probe "08-open-clock"          "open my clock"                   "clock|Opening"
# Plain chat — local llama fallback
run_probe "09-chat-hello"          "hi there"                        "hello|hi|hey|sure|here"        90
# Slug regression — "build me an ide" was the v6 bug
run_probe "10-build-ide-slug"      "build me an ide"                 "ide|Built|Building|Opening"    60
# Setup persistence — STARTS a multi-turn flow ("Just yes or no — ready?")
# that captures every subsequent /api/chat call. Run LAST so it doesn't
# eat earlier probes. The bail-out word "cancel" clears the flow.
run_probe "11-setup-persistence"   "set up persistence"              "encrypted|persistence|passphrase"
# Cancel the persistence flow so a follow-up probe routes to action surface again
run_probe "12-cancel-flow"         "cancel"                          "OK|leaving|alright"

echo
{
    echo
    echo "**Total:** $((PASS+FAIL)) probes — $PASS pass, $FAIL fail"
} >> "$ARTIFACTS/summary.md"

echo "==> Capture systemd journals"
for u in eliza-agent.service elizad-session-interactive.service ssh.service; do
    ssh_cmd "sudo journalctl -u $u -b --no-pager 2>/dev/null | tail -100" > "$ARTIFACTS/journal-$u.log" 2>&1 || true
done

echo
echo "==> Done. PASS=$PASS  FAIL=$FAIL"
echo "==> Artifacts:  $ARTIFACTS"
echo "==> Summary:    $ARTIFACTS/summary.md"

if (( FAIL > 0 )); then
    exit 2
fi
exit 0
