#!/usr/bin/env bash
# bootloop-triage.sh
#
# Failure-path companion for launch-cuttlefish-riscv64.sh + cuttlefish-boot-gate.sh.
# Captures the host + guest signals needed to triage a Cuttlefish riscv64 boot
# that never reached sys.boot_completed=1.
#
# Output:
#   out/triage/cuttlefish-riscv64-bootfail-<epoch>.log

set -euo pipefail

usage() {
	cat >&2 <<'USAGE'
usage: bootloop-triage.sh [options]

options:
  --out=PATH              triage log path
                          (default: <repo_root>/out/triage/cuttlefish-riscv64-bootfail-<epoch>.log)
  --runtime-dir=PATH      Cuttlefish runtime directory (default: ~/cuttlefish_runtime)
  --help                  this message
USAGE
}

out=
runtime_dir="$HOME/cuttlefish_runtime"

while [ "$#" -gt 0 ]; do
	case "$1" in
		--out=*) out=${1#*=}; shift ;;
		--runtime-dir=*) runtime_dir=${1#*=}; shift ;;
		--help|-h) usage; exit 0 ;;
		*) echo "error: unknown option $1" >&2; usage; exit 2 ;;
	esac
done

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
if [ -z "$out" ]; then
	mkdir -p "$repo_root/out/triage"
	out="$repo_root/out/triage/cuttlefish-riscv64-bootfail-$(date +%s).log"
fi
mkdir -p "$(dirname "$out")"

section() {
	printf '\n===== %s =====\n' "$1"
}

run() {
	# Print the command line then run it; ignore failures so the triage log
	# always completes.
	printf '$ %s\n' "$*"
	set +e
	"$@"
	rc=$?
	set -e
	printf '(exit %d)\n' "$rc"
}

{
	echo "eliza-triage: target=cuttlefish_riscv64 mode=bootfail"
	echo "TRIAGE_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	echo "RUNTIME_DIR=$runtime_dir"

	section "host groups"
	run sh -c 'groups | tr " " "\n" | grep -E "^(kvm|cvdnetwork|render)$" || echo "no kvm/cvdnetwork/render groups"'

	section "host modules"
	run sh -c 'lsmod 2>/dev/null | grep -E "^(vhost_vsock|nbd)" || echo "no vhost_vsock or nbd modules loaded"'

	section "qemu version"
	if command -v qemu-system-riscv64 >/dev/null 2>&1; then
		run qemu-system-riscv64 --version
	else
		echo "qemu-system-riscv64 not on PATH"
	fi

	section "kvm device"
	run ls -l /dev/kvm

	section "crosvm processes"
	run sh -c 'pgrep -af crosvm || echo "no crosvm processes"'

	section "launcher.log tail"
	if [ -f "$runtime_dir/launcher.log" ]; then
		run tail -200 "$runtime_dir/launcher.log"
	else
		echo "$runtime_dir/launcher.log not present"
	fi

	section "kernel.log tail"
	if [ -f "$runtime_dir/kernel.log" ]; then
		run tail -200 "$runtime_dir/kernel.log"
	else
		echo "$runtime_dir/kernel.log not present"
	fi

	section "adb devices"
	if command -v adb >/dev/null 2>&1; then
		run adb devices -l
	else
		echo "adb not on PATH"
	fi

	echo
	echo "TRIAGE_END_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} | tee "$out"

printf '\nbootloop-triage: wrote %s\n' "$out" >&2
