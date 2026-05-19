#!/usr/bin/env bash
# adb-driven Wi-Fi probe for the Cuttlefish riscv64 device.
#
# Reads the Cuttlefish wlan_virtio scan list, captures the connectivity state,
# and emits the markers the completion gate expects.
set -euo pipefail

component=wifi

emit() { printf '%s\n' "$*"; }

die() {
	emit "PROBE_ERROR=$*"
	emit "eliza-evidence: status=FAIL COMPONENT=${component}"
	exit "${2:-1}"
}

adb_cmd() {
	if [ -n "${ADB_SERIAL:-}" ]; then
		adb -s "$ADB_SERIAL" "$@"
	else
		adb "$@"
	fi
}

command -v adb >/dev/null 2>&1 || die "adb not on PATH" 2

emit "COMPONENT=${component}"

scan_raw=$(adb_cmd shell cmd wifi list-scan-results 2>&1 | tr -d '\r')
emit "WIFI_SCAN_RAW<<EOF"
emit "$scan_raw"
emit "EOF"

# `cmd wifi list-scan-results` prints a header line ("SSID BSSID ...") plus
# one row per AP. Count the rows that look like BSSID-formatted lines.
scan_count=$(printf '%s\n' "$scan_raw" | grep -Ec '([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}' || true)
emit "WIFI_SCAN_RESULTS=$scan_count"
[ "$scan_count" -ge 1 ] || die "wifi list-scan-results returned no APs"

check_raw=$(adb_cmd shell cmd wifi connectivity check 2>&1 | tr -d '\r' || true)
emit "WIFI_CONNECTIVITY_CHECK<<EOF"
emit "$check_raw"
emit "EOF"

dumpsys_raw=$(adb_cmd shell dumpsys wifi 2>&1 | tr -d '\r' | head -200 || true)
emit "WIFI_DUMPSYS_HEAD<<EOF"
emit "$dumpsys_raw"
emit "EOF"

state=$(printf '%s\n' "$dumpsys_raw" | awk -F': *' '/Wi-Fi is/{print $0; exit}' || true)
[ -n "$state" ] || state="unknown"
emit "WIFI_STATE=$state"

if printf '%s\n' "$dumpsys_raw" | grep -qi "Wi-Fi is enabled"; then
	emit "ANDROID_DUMPSYS_WIFI=pass"
else
	die "dumpsys wifi did not report 'Wi-Fi is enabled' state"
fi

ip_raw=$(adb_cmd shell 'ip route 2>/dev/null; ip addr show 2>/dev/null' | tr -d '\r' || true)
emit "WIFI_IP_RAW<<EOF"
emit "$ip_raw"
emit "EOF"
if printf '%s\n' "$ip_raw" | grep -Eq 'inet [0-9]+\.[0-9]+\.[0-9]+\.[0-9]+'; then
	emit "IP_CONNECTIVITY=pass"
else
	die "no IPv4 address assigned on any interface"
fi

emit "eliza-evidence: status=PASS COMPONENT=${component} WIFI_SCAN_RESULTS=${scan_count} WIFI_STATE=${state}"
exit 0
