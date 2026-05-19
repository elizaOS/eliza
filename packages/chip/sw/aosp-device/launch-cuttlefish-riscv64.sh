#!/usr/bin/env bash
# launch-cuttlefish-riscv64.sh
#
# Cuttlefish riscv64 launcher with pre-flight host checks, optional cleanup,
# deterministic launch_cvd flags, and a polled wait-for-boot loop. Pairs with
# cuttlefish-boot-gate.sh and bootloop-triage.sh; together they form the
# launch + boot validation harness for Task 29.
#
# This script does not produce evidence by itself. cuttlefish-boot-gate.sh is
# responsible for emitting the archived
# docs/evidence/android/cuttlefish_riscv64_boot.log transcript.

set -euo pipefail

usage() {
	cat >&2 <<'USAGE'
usage: launch-cuttlefish-riscv64.sh [options]

Pre-flights the host, optionally cleans stale Cuttlefish state, launches a
Cuttlefish riscv64 instance, and polls until the guest reports
sys.boot_completed=1.

options:
  --clean                 stop any running Cuttlefish instance and rm ~/cuttlefish_runtime
  --cpus=N                guest vCPU count (default: 8)
  --memory-mb=N           guest RAM in MiB (default: 12288)
  --gpu-mode=MODE         launch_cvd --gpu_mode (default: none;
                          use guest_swiftshader for home-screen boots)
  --boot-timeout-seconds=N
                          max wait for sys.boot_completed=1 (default: 1800)
  --launcher=PATH         override launch_cvd binary (default: auto-discover
                          launch_cvd then cvd create)
  --host-path=PATH        Cuttlefish host tools directory (default: auto-detect
                          from /usr/lib/cuttlefish-common/bin or ANDROID_HOST_OUT)
  --product-path=PATH     AOSP product images directory (default: $ANDROID_PRODUCT_OUT
                          or <aosp>/out/target/product/eliza_ai_soc)
  --aosp=PATH             optional AOSP tree; if provided, build/envsetup.sh
                          will be sourced so launch_cvd and adb are on PATH
  --help                  this message

Notable host requirements (checked at startup):
  - rw /dev/kvm
  - vhost_vsock kernel module loaded
  - $USER in groups kvm, cvdnetwork, render
  - qemu-system-riscv64 >= 9.2
USAGE
}

clean=0
cpus=8
memory_mb=12288
gpu_mode=none
boot_timeout_seconds=1800
launcher=
host_path=
product_path=
aosp=

while [ "$#" -gt 0 ]; do
	case "$1" in
		--clean)
			clean=1
			shift
			;;
		--cpus=*)
			cpus=${1#*=}
			shift
			;;
		--memory-mb=*)
			memory_mb=${1#*=}
			shift
			;;
		--gpu-mode=*)
			gpu_mode=${1#*=}
			shift
			;;
		--boot-timeout-seconds=*)
			boot_timeout_seconds=${1#*=}
			shift
			;;
		--launcher=*)
			launcher=${1#*=}
			shift
			;;
		--host-path=*)
			host_path=${1#*=}
			shift
			;;
		--product-path=*)
			product_path=${1#*=}
			shift
			;;
		--aosp=*)
			aosp=${1#*=}
			shift
			;;
		--help|-h)
			usage
			exit 0
			;;
		*)
			echo "error: unknown option $1" >&2
			usage
			exit 2
			;;
	esac
done

case "$cpus" in *[!0-9]*|"") echo "error: --cpus must be a positive integer" >&2; exit 2;; esac
case "$memory_mb" in *[!0-9]*|"") echo "error: --memory-mb must be a positive integer" >&2; exit 2;; esac
case "$boot_timeout_seconds" in *[!0-9]*|"") echo "error: --boot-timeout-seconds must be a positive integer" >&2; exit 2;; esac

log() {
	printf 'cf-launch %s %s\n' "$(date -u +%H:%M:%SZ)" "$*"
}

fail() {
	printf 'cf-launch error: %s\n' "$*" >&2
	exit 1
}

if [ -n "$aosp" ]; then
	if [ ! -f "$aosp/build/envsetup.sh" ]; then
		fail "--aosp=$aosp is not an AOSP checkout (missing build/envsetup.sh)"
	fi
	# shellcheck disable=SC1091
	. "$aosp/build/envsetup.sh"
fi

log "preflight: host checks"

if [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
	fail "/dev/kvm is not rw for the current user; ensure KVM is enabled and the user is in the kvm group"
fi

if ! lsmod 2>/dev/null | awk '{print $1}' | grep -qx vhost_vsock; then
	fail "vhost_vsock kernel module is not loaded; run: sudo modprobe vhost_vsock"
fi

missing_groups=""
for required_group in kvm cvdnetwork render; do
	if ! id -nG "$USER" 2>/dev/null | tr ' ' '\n' | grep -qx "$required_group"; then
		missing_groups="$missing_groups $required_group"
	fi
done
if [ -n "$missing_groups" ]; then
	fail "user '$USER' is not in required groups:$missing_groups; sudo usermod -aG kvm,cvdnetwork,render \"$USER\" then re-login"
fi

if ! command -v qemu-system-riscv64 >/dev/null 2>&1; then
	fail "qemu-system-riscv64 not on PATH; install QEMU >= 9.2 (Cuttlefish riscv64 uses TCG, not KVM)"
fi
qemu_version_line=$(qemu-system-riscv64 --version | head -n1)
qemu_version=$(printf '%s\n' "$qemu_version_line" | sed -n 's/^QEMU emulator version \([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p')
if [ -z "$qemu_version" ]; then
	fail "could not parse qemu-system-riscv64 version from: $qemu_version_line"
fi
qemu_major=${qemu_version%%.*}
qemu_minor=${qemu_version#*.}
qemu_minor=${qemu_minor%%.*}
if [ "$qemu_major" -lt 9 ] || { [ "$qemu_major" -eq 9 ] && [ "$qemu_minor" -lt 2 ]; }; then
	fail "qemu-system-riscv64 $qemu_version is too old; require >= 9.2 (TCG-only riscv64 guest performance regressed below this)"
fi
log "preflight: qemu-system-riscv64 $qemu_version"

if [ "$clean" -eq 1 ]; then
	log "cleanup: stop any running Cuttlefish instances + ~/cuttlefish_runtime"
	cvd reset -y >/dev/null 2>&1 || stop_cvd >/dev/null 2>&1 || true
	pkill -f crosvm >/dev/null 2>&1 || true
	rm -rf "$HOME/cuttlefish_runtime"
fi

if [ -z "$launcher" ]; then
	if command -v launch_cvd >/dev/null 2>&1; then
		launcher=launch_cvd
	elif command -v cvd >/dev/null 2>&1; then
		launcher=cvd
	else
		fail "neither launch_cvd nor cvd is on PATH; pass --aosp=/path/to/aosp or source build/envsetup.sh first"
	fi
fi

# Auto-detect host_path and product_path for the system cvd.
if [ "$launcher" = cvd ]; then
	if [ -z "$host_path" ]; then
		if [ -d /usr/lib/cuttlefish-common/bin ]; then
			host_path=/usr/lib/cuttlefish-common/bin
		elif [ -n "${ANDROID_HOST_OUT:-}" ] && [ -d "$ANDROID_HOST_OUT/bin" ]; then
			host_path=$ANDROID_HOST_OUT/bin
		fi
	fi
	if [ -z "$product_path" ]; then
		if [ -n "${ANDROID_PRODUCT_OUT:-}" ] && [ -d "$ANDROID_PRODUCT_OUT" ]; then
			product_path=$ANDROID_PRODUCT_OUT
		elif [ -n "$aosp" ]; then
			product_path="$aosp/out/target/product/eliza_ai_soc"
		fi
	fi
fi

log "launcher: $launcher"
log "launch: --cpus=$cpus --memory_mb=$memory_mb --gpu_mode=$gpu_mode"
[ -n "$host_path" ] && log "host_path: $host_path"
[ -n "$product_path" ] && log "product_path: $product_path"

if [ "$launcher" = cvd ]; then
	cvd_host_arg=
	cvd_product_arg=
	[ -n "$host_path" ] && cvd_host_arg="--host_path=$host_path"
	[ -n "$product_path" ] && cvd_product_arg="--product_path=$product_path"
	# cvd create creates a new device group and starts it; unlike the legacy
	# launch_cvd, it requires host_path when run outside an AOSP build environment.
	# shellcheck disable=SC2086
	cvd create \
		${cvd_host_arg:+$cvd_host_arg} \
		${cvd_product_arg:+$cvd_product_arg} \
		--cpus="$cpus" \
		--memory_mb="$memory_mb" \
		--gpu_mode="$gpu_mode" \
		--start_webrtc=false \
		--vnc_server_port=0 \
		--report_anonymous_usage_stats=n \
		--daemon
else
	"$launcher" \
		--cpus="$cpus" \
		--memory_mb="$memory_mb" \
		--gpu_mode="$gpu_mode" \
		--start_webrtc=false \
		--vnc_server_port=0 \
		--report_anonymous_usage_stats=n \
		--daemon
fi

log "launch: returned; polling adb get-state then sys.boot_completed (timeout ${boot_timeout_seconds}s)"

if ! command -v adb >/dev/null 2>&1; then
	fail "adb not on PATH after launch; source build/envsetup.sh from the AOSP tree first"
fi

deadline=$(( $(date +%s) + boot_timeout_seconds ))
last_progress=0
progress_interval=30

until adb get-state >/dev/null 2>&1; do
	now=$(date +%s)
	if [ "$now" -ge "$deadline" ]; then
		fail "timeout waiting for adb get-state (>${boot_timeout_seconds}s); run bootloop-triage.sh"
	fi
	if [ $(( now - last_progress )) -ge "$progress_interval" ]; then
		log "waiting for adb transport ($((deadline - now))s remaining)"
		last_progress=$now
	fi
	sleep 2
done
log "adb transport up"

boot_completed=
while :; do
	boot_completed=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
	if [ "$boot_completed" = 1 ]; then
		break
	fi
	now=$(date +%s)
	if [ "$now" -ge "$deadline" ]; then
		fail "timeout waiting for sys.boot_completed=1 (>${boot_timeout_seconds}s); run bootloop-triage.sh"
	fi
	if [ $(( now - last_progress )) -ge "$progress_interval" ]; then
		log "sys.boot_completed=$boot_completed ($((deadline - now))s remaining)"
		last_progress=$now
	fi
	sleep 5
done

log "boot complete: sys.boot_completed=1"
