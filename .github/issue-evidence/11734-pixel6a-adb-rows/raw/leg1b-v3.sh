#!/bin/bash
# leg1b-v3.sh — #11734 prefill sweep, per-rung app-relaunch methodology.
#
# Attempts 1-2 (raw/prefill-runs-attempt1.jsonl, raw/leg1b-prefill2.out) were
# poisoned by an autonomous ~5-min background agent job whose own runtime
# (11k-char prompt at device prefill speed) exceeds its period, so it
# self-queues and holds the resident-model lock indefinitely once it starts —
# no idle window ever opens. v3 therefore force-stops + relaunches the app
# before every rung and fires the turn inside the fresh-boot window. Every
# rung pays the same relaunch/reload cost -> constant intercept term; the
# regression slope (prefill) is unaffected.
set -u
SER=27051JEGR10034
RAW="$(cd "$(dirname "$0")" && pwd)"
OUT="$RAW/prefill-runs.jsonl"
TAIL="Reply in one short sentence: what is 40 plus 25?"

relaunch() {
  adb -s "$SER" shell am force-stop ai.elizaos.app
  sleep 3
  adb -s "$SER" shell monkey -p ai.elizaos.app -c android.intent.category.LAUNCHER 1 > /dev/null 2>&1
  local i=0
  until curl -sf -m 3 http://127.0.0.1:31337/api/status 2>/dev/null | grep -q '"state":"running"'; do
    i=$((i + 1))
    if [ "$i" -gt 60 ]; then echo "BOOT TIMEOUT"; return 1; fi
    sleep 3
  done
  sleep 10
}

# same filler pool + word-boundary cut as leg1-runner.mjs
build_q() {
  bun -e '
const fillerPool = [
  "A calm river flows past green hills beneath a pale sky.",
  "Tall trees sway gently while soft clouds drift far above the quiet valley.",
  "Small birds sing near the old stone bridge as warm light falls on the meadow.",
  "The narrow path winds between mossy rocks toward a silent mountain lake.",
];
const target = Number(process.argv[1]);
let s = ""; let i = 0;
while (s.length < target) { s += (s ? " " : "") + fillerPool[i % fillerPool.length]; i += 1; }
s = s.slice(0, target).replace(/\s+\S*$/, "");
const tail = "Reply in one short sentence: what is 40 plus 25?";
console.log(s ? `${s} ${tail}` : tail);' "$1"
}

for target in 0 90 180 270 360 450 540 630; do
  q=$(build_q "$target")
  label="v3-prefill-len${#q}"
  echo "=== rung $label ($(date '+%H:%M:%S')) ==="
  relaunch || { echo "{\"label\":\"$label\",\"error\":\"boot timeout\"}" >> "$OUT"; continue; }
  adb -s "$SER" shell log -t Bench11734 "TURN $label start qChars=${#q}"
  bun "$RAW/turn-driver.mjs" "$q" "" "$label" >> "$OUT" 2>> "$RAW/leg1b-v3.err"
  adb -s "$SER" shell log -t Bench11734 "TURN $label done"
  tail -1 "$OUT"
done
echo "V3 SWEEP COMPLETE $(date '+%H:%M:%S')"
