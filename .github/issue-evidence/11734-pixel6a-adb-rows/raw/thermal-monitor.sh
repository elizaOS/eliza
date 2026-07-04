#!/bin/bash
# thermal-monitor.sh — session-long thermal timeline for #11734 leg 2.
# Polls `dumpsys thermalservice` (Current temperatures from HAL) + battery
# every 15 s and appends one TSV row per sample. /sys/class/thermal is
# permission-blocked on this user build, so the HAL dump is the source.
set -u
SERIAL="27051JEGR10034"
OUT="$(dirname "$0")/thermal-timeline.tsv"
if [ ! -s "$OUT" ]; then
  printf 'epoch\ttime\tthermal_status\tbattery_c\tvirtual_skin_c\tskin_therm1_c\tskin_therm2_c\tneutral_c\tquiet_c\tdisp_c\tcharger_skin_c\ttpu_c\tcellular_c\tbatt_level\tcool_cpu0\tcool_cpu1\tcool_cpu2\tcool_gpu\tcool_tpu\tnote\n' >> "$OUT"
fi
while :; do
  epoch=$(date +%s)
  hhmmss=$(date '+%H:%M:%S')
  dump=$(adb -s "$SERIAL" shell dumpsys thermalservice 2>/dev/null)
  hal=$(printf '%s\n' "$dump" | sed -n '/Current temperatures from HAL/,/Current cooling devices/p')
  cool=$(printf '%s\n' "$dump" | sed -n '/Current cooling devices from HAL/,/Temperature static thresholds/p')
  status=$(printf '%s\n' "$dump" | grep -m1 'Thermal Status:' | grep -oE '[0-9]+' | head -1)
  gettemp() { printf '%s\n' "$hal" | grep -m1 "mName=$1," | grep -oE 'mValue=[0-9.]+' | cut -d= -f2; }
  getcool() { printf '%s\n' "$cool" | grep -m1 "mName=$1}" | grep -oE 'mValue=[0-9]+' | cut -d= -f2; }
  batt=$(adb -s "$SERIAL" shell dumpsys battery 2>/dev/null)
  batt_level=$(printf '%s\n' "$batt" | grep -m1 'level:' | grep -oE '[0-9]+')
  note="${THERMAL_NOTE:-}"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$epoch" "$hhmmss" "${status:-NA}" \
    "$(gettemp battery)" "$(gettemp VIRTUAL-SKIN)" "$(gettemp skin_therm1)" "$(gettemp skin_therm2)" \
    "$(gettemp neutral_therm)" "$(gettemp quiet_therm)" "$(gettemp disp_therm)" "$(gettemp charger_skin_therm)" \
    "$(gettemp TPU)" "$(gettemp cellular-emergency)" "${batt_level:-NA}" \
    "$(getcool thermal-cpufreq-0)" "$(getcool thermal-cpufreq-1)" "$(getcool thermal-cpufreq-2)" \
    "$(getcool thermal-gpufreq-0)" "$(getcool tpu_cooling)" "$note" >> "$OUT"
  sleep 15
done
