#!/bin/bash
# leg4-mem-monitor.sh — Pixel 6a memory timeline for the #11734 4b-tier attempt.
# Samples pid + MemAvailable every 5s; every 30s also captures dumpsys meminfo
# (TOTAL PSS / TOTAL RSS / GL mtrack / EGL mtrack / TOTAL SWAP PSS).
# Stops when the stop-file appears.
set -u
SER=27051JEGR10034
PKG=ai.elizaos.app
RAW="/home/shaw/eliza-worktrees/bench-11734/.github/issue-evidence/11734-pixel6a-adb-rows/raw"
TSV="$RAW/leg4-meminfo-timeline.tsv"
STOP="$RAW/.leg4-stop"

printf 'epoch\thost_time\tpid\tmemavail_kb\ttotal_pss_kb\ttotal_rss_kb\tgl_mtrack_kb\tegl_mtrack_kb\tswap_pss_kb\n' > "$TSV"
i=0
while [ ! -f "$STOP" ]; do
  epoch=$(date +%s); t=$(date '+%H:%M:%S')
  pid=$(adb -s "$SER" shell pidof -s "$PKG" 2>/dev/null | tr -d '\r\n ')
  memavail=$(adb -s "$SER" shell grep MemAvailable /proc/meminfo 2>/dev/null | awk '{print $2}')
  if [ $((i % 6)) -eq 0 ]; then
    mi=$(adb -s "$SER" shell dumpsys meminfo "$PKG" 2>/dev/null)
    pss=$(printf '%s\n' "$mi" | grep "TOTAL PSS:" | awk '{print $3}')
    rss=$(printf '%s\n' "$mi" | grep "TOTAL PSS:" | awk '{print $6}')
    swap=$(printf '%s\n' "$mi" | grep "TOTAL PSS:" | awk '{print $10}')
    gl=$(printf '%s\n' "$mi" | grep -E "^[[:space:]]+GL mtrack" | awk '{print $3}')
    egl=$(printf '%s\n' "$mi" | grep -E "^[[:space:]]+EGL mtrack" | awk '{print $3}')
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$epoch" "$t" "$pid" "$memavail" "$pss" "$rss" "$gl" "$egl" "$swap" >> "$TSV"
  else
    printf '%s\t%s\t%s\t%s\t\t\t\t\t\n' "$epoch" "$t" "$pid" "$memavail" >> "$TSV"
  fi
  i=$((i + 1))
  sleep 5
done
echo "monitor stopped $(date '+%H:%M:%S')"
