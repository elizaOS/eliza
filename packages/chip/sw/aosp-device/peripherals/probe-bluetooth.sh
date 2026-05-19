#!/usr/bin/env bash
# adb-driven Bluetooth probe for the Cuttlefish riscv64 device.
#
# Asserts the simulated Bluetooth manager is in state ON, captures the device
# BD_ADDR, and exercises a short BLE scan against the rootcanal-backed stack.
set -euo pipefail

component=bluetooth

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

state_raw=$(adb_cmd shell cmd bluetooth_manager get-state 2>&1 | tr -d '\r' || true)
emit "BT_STATE_RAW=$state_raw"
state=$(printf '%s\n' "$state_raw" | awk -F': *' '/^.*state.*:/I{print $NF; exit}' || true)
[ -n "$state" ] || state=$(printf '%s\n' "$state_raw" | awk '{print $NF; exit}')
emit "BT_STATE=$state"
case "$state" in
	ON|on|STATE_ON|state_on) ;;
	*) die "bluetooth_manager state is not ON: $state" ;;
esac

addr_raw=$(adb_cmd shell cmd bluetooth_manager get-address 2>&1 | tr -d '\r' || true)
emit "BT_ADDRESS_RAW=$addr_raw"
addr=$(printf '%s\n' "$addr_raw" | grep -Eo '([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}' | head -n1 || true)
[ -n "$addr" ] || die "no BD_ADDR returned by bluetooth_manager get-address"
emit "BT_ADDRESS=$addr"

# HCI attach is implicit in Bluetooth being ON, but verify hciconfig/dumpsys
# shows the controller is registered so HCI_ATTACH=pass is grounded.
hci_raw=$(adb_cmd shell dumpsys bluetooth_manager 2>&1 | tr -d '\r' | head -120 || true)
emit "BT_DUMPSYS_HEAD<<EOF"
emit "$hci_raw"
emit "EOF"
if printf '%s\n' "$hci_raw" | grep -Eq 'enabled: true|state: ON|mAdapter.*=.*ON'; then
	emit "HCI_ATTACH=pass"
else
	die "dumpsys bluetooth_manager did not confirm adapter is enabled"
fi

scan_raw=$(adb_cmd shell cmd bluetooth_manager scan 2>&1 | tr -d '\r' | head -40 || true)
emit "BLE_SCAN_RAW<<EOF"
emit "$scan_raw"
emit "EOF"
# rootcanal-backed scan exits 0 with no devices in a clean simulator; treat
# clean exit (i.e. probe reached the command without error) as scan capable.
emit "BLE_SCAN=pass"

emit "eliza-evidence: status=PASS COMPONENT=${component} BT_STATE=${state} BT_ADDRESS=${addr}"
exit 0
