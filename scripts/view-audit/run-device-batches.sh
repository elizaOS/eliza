#!/usr/bin/env bash
# Batched on-device deep crawl: restart the app between small batches so the
# resource-constrained webview never degrades (a fresh app reliably handles ~4
# deep-clicked views). Each batch deep-crawls its routes (tabs/modals/sub-pages)
# for red / errors / 404s and writes batch-<start>.json under the out dir.
set -u
SER="${1:-53081JEBF11586}"
OUT=/tmp/view-audit/device-deep-full
mkdir -p "$OUT"; : > "$OUT/progress.log"
TOTAL=57; BATCH=4
cd "$(dirname "$0")/../.."

wait_ready() {
  for _ in $(seq 1 18); do
    local sock listen
    sock=$(adb -s "$SER" shell cat /proc/net/unix 2>/dev/null | grep -oE "webview_devtools_remote_[0-9]+" | head -1)
    listen=$(adb -s "$SER" shell "cat /proc/net/tcp 2>/dev/null | grep -c ':7A69 .* 0A'" 2>/dev/null | tr -d '\r')
    [ -n "$sock" ] && [ "$listen" = "1" ] && return 0
    sleep 5
  done
  return 1
}

start=0
while [ "$start" -lt "$TOTAL" ]; do
  end=$((start + BATCH)); [ "$end" -gt "$TOTAL" ] && end="$TOTAL"
  echo "=== batch $start..$end : restarting app ==="
  adb -s "$SER" shell am force-stop ai.elizaos.app
  adb -s "$SER" shell am start -n ai.elizaos.app/.MainActivity >/dev/null 2>&1
  wait_ready
  SOCK=$(adb -s "$SER" shell cat /proc/net/unix 2>/dev/null | grep -oE "webview_devtools_remote_[0-9]+" | head -1)
  adb -s "$SER" forward --remove-all 2>/dev/null
  adb -s "$SER" forward tcp:9222 localabstract:"$SOCK" >/dev/null 2>&1
  sleep 5
  timeout 220 bun scripts/view-audit/device-gentle-crawler.mjs \
    --cdp http://127.0.0.1:9222 --out "$OUT" --from "$start" --to "$end" \
    --report "$OUT/batch-$start.json" 2>&1 | tail -6
  start="$end"
done
echo "ALL BATCHES DONE"
