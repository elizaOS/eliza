#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 NubsCarson and contributors
#
# v18 low-RAM / low-core smoke harness.
#
# Same 47-probe suite as scripts/v11-e2e.sh, but boots the guest with the
# genuinely-tight target spec (2 GB RAM, 2 vCPUs) — older Chromebook / Atom
# netbook / 4 GB Thinkpad with desktop overhead. We assume v18 is the
# release candidate and verify the floor (Llama 1B ~1.5 GB + sway ~100 MB +
# agent ~500 MB + room for chromium when spawned) actually fits.
#
# Two additional probes ride at the tail:
#   MEM-001  available memory after the agent reports ready (warn if <200 MB)
#   MEM-002  available memory after the BUILD_APP probes run (catches agent
#            leaks under memory pressure)
#
# CODEGEN STUB CHOICE
# -------------------
# v18 ships with USBELIZA_CODEGEN_STUB=0 baked into the agent unit. Real
# claude codegen would spawn the claude CLI (200-500 MB resident) — way
# too fat for a 2 GB box even if the auth marker isn't written. We write
# a systemd drop-in *before* the agent comes up that forces the stub back
# on for this run, so BUILD_APP probes stay fast + deterministic and the
# memory measurement isn't polluted by claude CLI residency.
#
# Usage:
#   scripts/v18-lowram-smoke.sh                                # default: newest out/usbeliza-v*-final-amd64.iso
#   scripts/v18-lowram-smoke.sh out/usbeliza-v18-final-amd64.iso
#
# Exit codes:
#   0   all probes passed
#   1   boot timed out (no SSH after 5 min)
#   2   one or more probes asserted FAIL
#   3   setup error
#
# Artifacts: vm/snapshots/v18-lowram-<TS>/{screen-<n>.png, chat-<n>.json,
#                                          mem-*.txt, dmesg.log, summary.md}

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
ARTIFACTS="vm/snapshots/v18-lowram-$TS"
mkdir -p "$ARTIFACTS"

QMP_SOCK="vm/snapshots/v18-lowram-qmp.sock"
SERIAL_SOCK="vm/snapshots/v18-lowram-serial.sock"
SSH_PORT=2231
SSH_KEY="vm/.ssh/usbeliza_dev_ed25519"

echo "==> ISO:        $ISO"
echo "==> Artifacts:  $ARTIFACTS"
echo "==> Spec:       2 GB RAM, 2 vCPUs (low-end target)"

cleanup() {
    local rc=$?
    if [[ -S "$QMP_SOCK" ]]; then
        printf '{"execute":"qmp_capabilities"}\n{"execute":"quit"}\n' \
            | timeout 5 socat - "UNIX-CONNECT:$QMP_SOCK" >/dev/null 2>&1 || true
    fi
    sudo pkill -9 -f "qemu-system-x86_64.*v18-lowram" 2>/dev/null || true
    rm -f "$QMP_SOCK" "$SERIAL_SOCK"
    exit "$rc"
}
trap cleanup EXIT INT TERM

echo "==> Launching QEMU headless (2G / 2 cores)"
nohup sudo -n qemu-system-x86_64 \
    -enable-kvm -cpu host -m 2G -smp 2 \
    -cdrom "$ISO" -boot d \
    -netdev "user,id=net0,hostfwd=tcp::${SSH_PORT}-:22" \
    -device virtio-net-pci,netdev=net0 \
    -nographic \
    -vga none -device virtio-vga,xres=1920,yres=1080 \
    -display none \
    -qmp "unix:${QMP_SOCK},server,nowait" \
    -serial "unix:${SERIAL_SOCK},server,nowait" \
    -name v18-lowram \
    > "$ARTIFACTS/qemu.log" 2>&1 &
QEMU_PID=$!
echo "==> QEMU pid: $QEMU_PID"

for s in "$QMP_SOCK" "$SERIAL_SOCK"; do
    for _ in $(seq 1 30); do
        [[ -S "$s" ]] && break
        sleep 0.5
    done
    sudo chmod 660 "$s" 2>/dev/null || true
done

echo "==> Waiting for SSH on :$SSH_PORT (up to 5 min)..."
BOOT_START=$SECONDS
DEADLINE=$(( SECONDS + 300 ))
while (( SECONDS < DEADLINE )); do
    if ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o LogLevel=ERROR -o ConnectTimeout=4 -p "$SSH_PORT" eliza@127.0.0.1 \
        'true' 2>/dev/null; then
        BOOT_TIME=$(( SECONDS - BOOT_START ))
        echo "==> SSH ready after $BOOT_TIME seconds"
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

ssh_cmd() {
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o LogLevel=ERROR -p "$SSH_PORT" eliza@127.0.0.1 "$@"
}

# Force codegen stub back on for this run BEFORE the agent settles into a
# claude-spawning state. v18 ships USBELIZA_CODEGEN_STUB=0. We drop in a
# unit override and restart the agent so BUILD_APP probes hit the fast
# stub path. This is done as early as possible — right after SSH comes up,
# before the agent first responds, so we don't accidentally fork claude.
echo "==> Forcing USBELIZA_CODEGEN_STUB=1 via systemd drop-in (low-RAM safety)"
ssh_cmd 'sudo mkdir -p /etc/systemd/system/eliza-agent.service.d && \
    sudo tee /etc/systemd/system/eliza-agent.service.d/lowram-stub.conf > /dev/null <<CONF
[Service]
Environment=USBELIZA_CODEGEN_STUB=1
CONF
sudo systemctl daemon-reload && sudo systemctl restart eliza-agent.service'

echo "==> Waiting for eliza-agent /api/status (up to 3 min — 2-core warmup is slower)..."
AGENT_DEADLINE=$(( SECONDS + 180 ))
while (( SECONDS < AGENT_DEADLINE )); do
    if ssh_cmd 'curl -sf --max-time 3 http://127.0.0.1:41337/api/status' \
        2>/dev/null | grep -q '"state":"ready"'; then
        echo "==> eliza-agent ready after $SECONDS seconds"
        break
    fi
    sleep 3
done

echo "==> Resetting guest state for fresh onboarding"
ssh_cmd 'rm -f ~/.eliza/flow.toml ~/.eliza/onboarding.toml ~/.eliza/calibration.toml'
ssh_cmd 'rm -rf ~/.eliza/apps ~/.eliza/wallpapers ~/.eliza/auth'

seed_calibration() {
    ssh_cmd 'rm -f ~/.eliza/flow.toml ~/.eliza/onboarding.toml'
    ssh_cmd 'mkdir -p ~/.eliza/models && touch ~/.eliza/models/Llama-3.2-1B-Instruct-Q4_K_M.gguf'
    ssh_cmd 'cat > ~/.eliza/calibration.toml <<TOML
schema_version = 1
created_at = "2026-05-12T00:00:00Z"
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
}

screenshot() {
    local name="$1"
    local out="$ARTIFACTS/screen-${name}.ppm"
    printf '{"execute":"qmp_capabilities"}\n{"execute":"screendump","arguments":{"filename":"%s"}}\n' "$out" \
        | timeout 5 socat - "UNIX-CONNECT:$QMP_SOCK" > /dev/null 2>&1 || true
    if [[ -f "$out" ]] && command -v convert >/dev/null 2>&1; then
        convert "$out" "$ARTIFACTS/screen-${name}.png" 2>/dev/null && rm -f "$out"
    fi
}

probe() {
    local name="$1"
    local message="$2"
    local expect_re="$3"
    local timeout="${4:-30}"
    local response json_body reply
    json_body="$(jq -nc --arg m "$message" '{message:$m}')"
    response="$(ssh_cmd "curl -sf -X POST http://127.0.0.1:41337/api/chat \
        -H 'Content-Type: application/json' --data-binary @- --max-time $timeout" \
        <<< "$json_body" || true)"
    printf '%s\n' "$response" > "$ARTIFACTS/chat-${name}.json"
    reply="$(printf '%s' "$response" | jq -r '.reply // "<no reply>"' 2>/dev/null || printf '%s' "$response")"
    screenshot "$name"
    if printf '%s' "$reply" | grep -qEi "$expect_re"; then
        printf '  PASS  %-26s  "%s..."\n' "$name" "$(printf '%s' "$reply" | head -c 60)"
        return 0
    fi
    printf '  FAIL  %-26s  "%s..."  (expected /%s/)\n' "$name" "$(printf '%s' "$reply" | head -c 60)" "$expect_re"
    return 1
}

guest_file_check() {
    local name="$1" path="$2"
    if ssh_cmd "test -e '$path'" 2>/dev/null; then
        printf '  PASS  %-26s  "guest path %s exists"\n' "$name" "$path"
        return 0
    fi
    printf '  FAIL  %-26s  "guest path %s missing"\n' "$name" "$path"
    return 1
}

PASS=0; FAIL=0
{
    echo "# v18 LOW-RAM SMOKE results — $(date -u +%FT%TZ)"
    echo
    echo "ISO: \`$ISO\`"
    echo
    echo "Spec: 2 GB RAM, 2 vCPUs"
    echo
    echo "Boot to SSH: ${BOOT_TIME}s"
    echo
    echo "| probe | result | reply / detail |"
    echo "|---|---|---|"
} > "$ARTIFACTS/summary.md"

run_probe() {
    local name="$1" message="$2" expect_re="$3" timeout="${4:-30}"
    if probe "$name" "$message" "$expect_re" "$timeout"; then
        PASS=$((PASS+1))
        local reply
        reply="$(jq -r '.reply // "<no reply>"' "$ARTIFACTS/chat-${name}.json" 2>/dev/null | head -c 80 | tr '\n' ' ')"
        echo "| $name | PASS | $reply... |" >> "$ARTIFACTS/summary.md"
    else
        FAIL=$((FAIL+1))
        local reply
        reply="$(jq -r '.reply // "<no reply>"' "$ARTIFACTS/chat-${name}.json" 2>/dev/null | head -c 80 | tr '\n' ' ')"
        echo "| $name | FAIL | $reply... |" >> "$ARTIFACTS/summary.md"
    fi
}

run_file_check() {
    local name="$1" path="$2"
    if guest_file_check "$name" "$path"; then
        PASS=$((PASS+1))
        echo "| $name | PASS | guest path \`$path\` exists |" >> "$ARTIFACTS/summary.md"
    else
        FAIL=$((FAIL+1))
        echo "| $name | FAIL | guest path \`$path\` MISSING |" >> "$ARTIFACTS/summary.md"
    fi
}

# MEM-001 and MEM-002 don't go through /api/chat — they sample `free -m`
# on the guest. Available memory column is field 7 of the Mem: row.
# Warn (not fail) below 200 MB — that's the "thrashing soon" zone.
sample_memory() {
    local label="$1"
    ssh_cmd 'free -m' > "$ARTIFACTS/mem-${label}.txt" 2>/dev/null || true
    ssh_cmd "free -m | awk '/^Mem:/ {print \$7}'" 2>/dev/null | tr -d '\r' || echo 0
}

run_mem_probe() {
    local name="$1" label="$2"
    local avail
    avail="$(sample_memory "$label")"
    if [[ -z "$avail" || "$avail" == "0" ]]; then
        printf '  FAIL  %-26s  "could not read free -m"\n' "$name"
        FAIL=$((FAIL+1))
        echo "| $name | FAIL | could not read \`free -m\` |" >> "$ARTIFACTS/summary.md"
        return
    fi
    if (( avail < 200 )); then
        printf '  WARN  %-26s  "%s MB available — below 200 MB warn threshold"\n' "$name" "$avail"
        # Still count as PASS — the probe is meant to surface the number,
        # not gate the run. The warning lands in summary.md.
        PASS=$((PASS+1))
        echo "| $name | WARN | ${avail} MB available — UNDER 200 MB threshold |" >> "$ARTIFACTS/summary.md"
    else
        printf '  PASS  %-26s  "%s MB available"\n' "$name" "$avail"
        PASS=$((PASS+1))
        echo "| $name | PASS | ${avail} MB available |" >> "$ARTIFACTS/summary.md"
    fi
}

echo
echo "==> Phase 0: onboarding state machine (calibration.toml absent → 10 questions)"

run_probe "P00-greeting"            ""                                  "Eliza|hi|hello|call you|name"          30
run_probe "P01-answer-name"         "Sam"                               "wi-?fi|local|stick"                    30
run_probe "P02-answer-wifi-offer"   "no"                                "Claude|Codex|sign|skip"                30
run_probe "P03-answer-claude-offer" "no"                                "computer time|work|spend"              30
run_probe "P04-answer-workfocus"    "writing code"                      "tools|workspace|multi|focused"         30
run_probe "P05-answer-multitask"    "many"                              "morning|evening|depends"               30
run_probe "P06-answer-chronotype"   "morning"                           "fix|tell|quietly|something I build"    30
run_probe "P07-answer-errorcomm"    "tell me"                           "keyboard layout|us|dvorak"             30
run_probe "P08-answer-keyboard"     "us"                                "language|speak"                        30
run_probe "P09-answer-language"     "english"                           "timezone|last one|UTC"                 30
run_probe "P10-answer-timezone"     "UTC"                               "Sam|start|begin|set up|I have"         40
run_file_check "P11-calibration-written" "/home/eliza/.eliza/calibration.toml"

echo
echo "==> Re-seeding calibration.toml for action-surface probes"
seed_calibration

echo
echo "==> Phase A: status & system actions"

run_probe "A01-help"                "help"                              "build|small apps|talk to me"
run_probe "A02-am-i-online"         "am i online"                       "Online|IP|offline"
run_probe "A03-network-status"      "what's my network"                 "Online|offline|IP|connected"
run_probe "A04-list-models"         "list models"                       "Llama|GB|model"
run_probe "A05-battery"             "what's my battery"                 "battery|AC power|%|don't see"
run_probe "A06-current-time"        "what time is it"                   ":[0-9]"
run_probe "A07-list-apps-empty"     "list my apps"                      "build me|haven't built|none yet|nothing"

# MEM-001: sample free memory once the agent has fully replied to the
# system-action surface. This is roughly the steady state after warmup
# but BEFORE we ask the agent to do anything heavy (build apps, paint
# wallpapers, spawn chromium for OAuth).
echo
echo "==> MEM-001: free memory after boot + warmup"
run_mem_probe "MEM-001-after-boot" "after-boot"

echo
echo "==> Phase B: dream-world surface"

run_probe "B01-set-wallpaper-space" "make me a space wallpaper with stars"   "wallpaper|space|stars|couldn't switch"  60
run_file_check "B02-wallpaper-png-disk"  "/home/eliza/.eliza/wallpapers/space-stars.png"
run_probe "B03-set-wallpaper-sunset"     "change my background to a sunset gradient"  "wallpaper|sunset|gradient|couldn't switch"  60
run_file_check "B04-sunset-png-disk"     "/home/eliza/.eliza/wallpapers/change-a-sunset-gradient.png"

echo
echo "==> Phase C: app lifecycle"

run_probe "C01-build-clock"         "build me a clock"                  "clock|Built|Building|Opening"   90
run_file_check "C02-clock-manifest"  "/home/eliza/.eliza/apps/clock/manifest.json"
run_probe "C03-open-clock"          "open my clock"                     "clock|Opening"
run_probe "C04-list-apps-one"       "list my apps"                      "clock|app"
run_probe "C05-build-ide"           "build me an ide"                   "ide|Built|Building|Opening"     90
run_probe "C06-list-apps-two"       "list my apps"                      "clock|ide|app"
run_probe "C07-delete-clock"        "delete my clock"                   "Removed|removed|deleted|gone"
run_probe "C08-list-apps-after"     "list my apps"                      "ide|app"
run_probe "C09-open-missing"        "open my notepad"                   "haven't|don't|no app|not found|build"

# MEM-002: sample free memory after BUILD_APP probes have run. If the
# stub codegen leaks, we'll see available memory drop noticeably.
# Re-checked here BEFORE phase D (which queries nmcli — cheap) so we
# isolate the build-app memory profile.
echo
echo "==> MEM-002: free memory after BUILD_APP probes"
run_mem_probe "MEM-002-after-build" "after-build"

echo
echo "==> Phase D: network actions + model picker"

run_probe "D01-list-wifi"           "list wifi networks"                "wifi|network|none|no networks|couldn't|nmcli"
run_probe "D02-network-status-2"    "are we online"                     "Online|offline|IP"
run_probe "D03-network-paraphrase"  "what is my network"                "Online|offline|IP|connected|nmcli"
run_probe "D04-download-model-already" "download Llama 3.2 1B"          "already|on disk|pinned|model"  30

echo
echo "==> Phase E: auth surface (OPEN_URL not the full OAuth)"

run_probe "E01-login-claude"        "login to claude"                   "sign-in|sign in|OAuth|claude|opened|drive the.*login"  60
run_probe "E02-login-codex"         "login to codex"                    "sign-in|sign in|OAuth|codex|opened|drive the.*login"  60
run_probe "E03-open-url"            "open https://example.com"          "Opening|browser|chromium|example.com|couldn't find"

echo
echo "==> Phase F: multi-turn flows"

run_probe "F01-start-wifi-flow"     "connect to wifi"                   "which|network|SSID|scan|nearby|pick|don't see|no wifi"  30
run_probe "F02-network-status-followup" "are we online"                  "Online|offline|IP"
run_probe "F03-start-persistence"   "set up persistence"                "encrypted|persistence|passphrase|ready"
run_probe "F04-yes-continue"        "yes"                               "passphrase|password|encrypt|secret"
run_probe "F05-bail-persistence"    "never mind"                        "OK|leaving|alright"

echo
echo "==> Phase G: chat fallthrough to local llama"

# On 2 GB / 2-core the local 1B is the slowest single op. Lift timeout
# from 90s → 180s — the model is still ~1.5 GB resident, but inference
# wall-time roughly doubles vs. 4 cores. We're not measuring llama
# latency here, just that it completes within sanity.
run_probe "G01-chat-hello"          "hi there"                          ".{5,}"   180

echo
echo "==> Phase H: LLM-rephrase ON path (fake claude auth marker)"

ssh_cmd 'mkdir -p ~/.eliza/auth && cat > ~/.eliza/auth/claude.json <<JSON
{"provider":"claude","status":"signed-in","detectedAt":"2026-05-12T00:00:00Z"}
JSON
'

run_probe "H01-rephrase-on-help"    "help"                              "build|small apps|talk to me|here|sure|can"  180
run_probe "H02-rephrase-on-time"    "what time is it"                   "[0-9]|UTC|morning|evening|noon|now"          180

echo
{
    echo
    echo "**Total:** $((PASS+FAIL)) probes — $PASS pass, $FAIL fail"
} >> "$ARTIFACTS/summary.md"

echo "==> Capture systemd journals"
for u in eliza-agent.service elizad-session-interactive.service ssh.service; do
    ssh_cmd "sudo journalctl -u $u -b --no-pager 2>/dev/null | tail -200" > "$ARTIFACTS/journal-$u.log" 2>&1 || true
done

# OOM events + memory-pressure dmesg. These are the "did the kernel kill
# something" signals — if anything appears here the 2 GB target is not viable.
echo "==> Capture dmesg OOM + memory-pressure events"
ssh_cmd 'sudo dmesg 2>/dev/null' > "$ARTIFACTS/dmesg.log" 2>&1 || true
{
    echo "## dmesg OOM grep"
    grep -iE 'oom|killed process|out of memory|memory cgroup' "$ARTIFACTS/dmesg.log" 2>/dev/null || echo "(no OOM events)"
} > "$ARTIFACTS/oom-grep.txt"

# Agent restart count — Restart=on-failure in the unit, so any crash
# under memory pressure shows up here.
echo "==> Count agent restarts"
AGENT_RESTARTS="$(ssh_cmd 'systemctl show eliza-agent.service -p NRestarts --value' 2>/dev/null | tr -d '\r' || echo unknown)"
echo "==> eliza-agent NRestarts=$AGENT_RESTARTS"
{
    echo
    echo "## Agent runtime stats"
    echo
    echo "- eliza-agent NRestarts: \`$AGENT_RESTARTS\`"
    echo "- Boot to SSH: ${BOOT_TIME}s"
    echo
    echo "## OOM grep"
    echo
    echo '```'
    cat "$ARTIFACTS/oom-grep.txt"
    echo '```'
    echo
    echo "## free -m at MEM-001 (after-boot)"
    echo
    echo '```'
    cat "$ARTIFACTS/mem-after-boot.txt" 2>/dev/null || echo "(missing)"
    echo '```'
    echo
    echo "## free -m at MEM-002 (after-build)"
    echo
    echo '```'
    cat "$ARTIFACTS/mem-after-build.txt" 2>/dev/null || echo "(missing)"
    echo '```'
} >> "$ARTIFACTS/summary.md"

echo
echo "==> Done. PASS=$PASS  FAIL=$FAIL"
echo "==> Boot:       ${BOOT_TIME}s"
echo "==> Restarts:   $AGENT_RESTARTS"
echo "==> Artifacts:  $ARTIFACTS"
echo "==> Summary:    $ARTIFACTS/summary.md"

if (( FAIL > 0 )); then
    exit 2
fi
exit 0
