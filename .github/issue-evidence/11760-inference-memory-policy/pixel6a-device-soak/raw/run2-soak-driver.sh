#!/bin/bash
# run2-soak-driver.sh — acceptance-soak driver for #11734 (refs #11760).
# Legs: cold warmup turn -> >=10 min foregrounded soak (real local-inference
# turns via POST /v1/chat/completions through adb forward tcp:31337) ->
# idle-unload leg (7 min, past the 300000 ms constrained idle timeout) ->
# one reload turn (transparent reload after release).
set -u
RAW="/home/shaw/eliza-worktrees/device-11760/.github/issue-evidence/11760-inference-memory-policy/pixel6a-device-soak/raw"
LOG="$RAW/run2-soak-turns.log"
PORT=31337
ts() { date '+%H:%M:%S'; }

turn() {
  local n="$1" q="$2"
  echo "=== TURN $n start $(ts) epoch=$(date +%s) q=\"$q\" ===" >> "$LOG"
  local t0=$(date +%s)
  curl -sS -m 420 -X POST "http://127.0.0.1:$PORT/v1/chat/completions" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"eliza\",\"messages\":[{\"role\":\"user\",\"content\":\"$q\"}],\"max_tokens\":20}" >> "$LOG" 2>&1
  echo "" >> "$LOG"
  local t1=$(date +%s)
  echo "=== TURN $n done $(ts) wall=$((t1 - t0))s ===" >> "$LOG"
  echo "TURN_MARKER $n done wall=$((t1 - t0))s"
}

echo "RUN2_WARMUP_START $(ts) epoch=$(date +%s)" >> "$LOG"
echo "RUN2_WARMUP_START $(ts)"
turn WARMUP "Reply in one short sentence: what is the capital of Japan?"

echo "RUN2_SOAK_TURNS_START $(ts) epoch=$(date +%s)" >> "$LOG"
echo "RUN2_SOAK_TURNS_START $(ts)"
SOAK_T0=$(date +%s)
qs=(
  "what is 12 plus 34"
  "what is 45 plus 27"
  "name one primary color"
  "what is 88 minus 19"
  "what is 7 times 8"
  "name one ocean"
  "what is 100 minus 42"
  "what is 15 plus 60"
  "name one planet"
  "what is 9 times 9"
)
n=1
for q in "${qs[@]}"; do
  turn "$n" "Reply in one short sentence: ${q}?"
  elapsed=$(( $(date +%s) - SOAK_T0 ))
  if [ "$elapsed" -ge 660 ]; then break; fi
  sleep 20
  n=$((n + 1))
done
SOAK_WALL=$(( $(date +%s) - SOAK_T0 ))
echo "RUN2_SOAK_TURNS_END $(ts) epoch=$(date +%s) soak_wall=${SOAK_WALL}s" >> "$LOG"
echo "RUN2_SOAK_TURNS_END $(ts) soak_wall=${SOAK_WALL}s"

echo "RUN2_IDLE_LEG_START $(ts) epoch=$(date +%s) (waiting 420s, past the 300000ms constrained idle-unload timeout)" >> "$LOG"
echo "RUN2_IDLE_LEG_START $(ts)"
sleep 420
echo "RUN2_IDLE_LEG_END $(ts) epoch=$(date +%s)" >> "$LOG"
echo "RUN2_IDLE_LEG_END $(ts)"

echo "RUN2_RELOAD_TURN_START $(ts) epoch=$(date +%s)" >> "$LOG"
echo "RUN2_RELOAD_TURN_START $(ts)"
turn RELOAD "Reply in one short sentence: what is the capital of Italy?"
echo "RUN2_DONE $(ts) epoch=$(date +%s)" >> "$LOG"
echo "RUN2_DONE $(ts)"
