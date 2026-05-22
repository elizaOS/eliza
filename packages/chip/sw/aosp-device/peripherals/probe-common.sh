#!/usr/bin/env bash
# Shared helpers for adb-backed Android simulator peripheral probes.

adb_cmd() {
	if [ -n "${ADB_SERIAL:-}" ]; then
		adb -s "$ADB_SERIAL" "$@"
	else
		adb "$@"
	fi
}

require_adb_device() {
	command -v adb >/dev/null 2>&1 || die "adb not on PATH" 2

	state_output=$(adb_cmd get-state 2>&1) || {
		die "adb device unavailable: $state_output" 2
	}
	state=$(printf '%s\n' "$state_output" | tr -d '\r' | tail -n1)
	[ "$state" = device ] || die "adb device is not ready: $state_output" 2
}

require_android_boot_completed() {
	boot_output=$(adb_cmd shell getprop sys.boot_completed 2>&1) || {
		die "could not read sys.boot_completed: $boot_output" 2
	}
	boot_completed=$(printf '%s\n' "$boot_output" | tr -d '\r' | tail -n1)
	emit "SYS_BOOT_COMPLETED=$boot_completed"
	[ "$boot_completed" = 1 ] || die "Android boot is not complete: sys.boot_completed=$boot_completed" 2
}
