#!/usr/bin/env sh
set -eu

repo_dir="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
src_dir="$repo_dir/sw/baremetal/chipyard-trap-timer-irq"
out_dir="$repo_dir/build/evidence/cpu_ap/trap_timer_irq"
elf="$out_dir/trap_timer_irq.elf"
log="$out_dir/trap_timer_irq.raw.log"
manifest="$repo_dir/build/chipyard/eliza_rocket/ElizaRocketConfig.manifest.json"
dts="$repo_dir/build/chipyard/eliza_rocket/eliza-e1.dts"
simulator="${CHIPYARD_TRAP_TIMER_IRQ_SIMULATOR:-$repo_dir/build/chipyard/eliza_rocket/simulator/simulator-chipyard.harness-ElizaRocketConfig}"
timeout_seconds="${CHIPYARD_TRAP_TIMER_IRQ_TIMEOUT_SECONDS:-360}"
timeout_cycles="${CHIPYARD_TRAP_TIMER_IRQ_MAX_CYCLES:-100000000}"
gcc="${RISCV64_UNKNOWN_ELF_GCC:-$repo_dir/tools/bin/riscv64-unknown-elf-gcc}"

mkdir -p "$out_dir"

if [ ! -f "$manifest" ]; then
	printf 'STATUS: BLOCKED chipyard.trap_timer_irq\n'
	printf '  - missing generated manifest: %s\n' "${manifest#"$repo_dir"/}"
	exit 2
fi
if [ ! -f "$dts" ]; then
	printf 'STATUS: BLOCKED chipyard.trap_timer_irq\n'
	printf '  - missing generated DTS: %s\n' "${dts#"$repo_dir"/}"
	exit 2
fi
if [ ! -x "$simulator" ]; then
	printf 'STATUS: BLOCKED chipyard.trap_timer_irq\n'
	printf '  - missing executable generated simulator: %s\n' "${simulator#"$repo_dir"/}"
	exit 2
fi
if [ ! -x "$gcc" ]; then
	printf 'STATUS: BLOCKED chipyard.trap_timer_irq\n'
	printf '  - missing riscv64 bare-metal compiler: %s\n' "${gcc#"$repo_dir"/}"
	exit 2
fi

if ! grep -F -q 'interrupt-controller@c000000' "$dts" ||
	! grep -F -q 'clint@2000000' "$dts" ||
	! grep -F -q 'serial@10001000' "$dts"; then
	printf 'STATUS: BLOCKED chipyard.trap_timer_irq\n'
	printf '  - generated DTS lacks required CLINT/PLIC/UART nodes\n'
	exit 2
fi

"$gcc" \
	-march=rv64gc -mabi=lp64d -mcmodel=medany \
	-static -nostdlib -nostartfiles \
	-Wl,--no-warn-rwx-segments \
	-T "$src_dir/link.ld" \
	"$src_dir/trap_timer_irq.S" \
	-o "$elf"

set +e
run_status=1
{
	printf 'eliza-evidence: target=generated_chipyard_ap trap_timer_irq\n'
	printf 'eliza-evidence: generated_manifest=%s\n' "${manifest#"$repo_dir"/}"
	printf 'eliza-evidence: generated_dts=%s\n' "${dts#"$repo_dir"/}"
	printf 'eliza-evidence: simulator=%s\n' "${simulator#"$repo_dir"/}"
	printf 'eliza-evidence: payload=%s\n' "${elf#"$repo_dir"/}"
	printf 'eliza-evidence: generated DTS interrupt-controller node present: interrupt-controller@c000000 PLIC\n'
	printf 'eliza-evidence: generated DTS CLINT node present: clint@2000000 mtime mtimecmp msip\n'
	printf 'eliza-evidence: raw_transcript_begin\n'
	python3 "$repo_dir/scripts/run_with_timeout.py" \
		--timeout-seconds "$timeout_seconds" \
		--label chipyard-trap-timer-irq \
		-- "$simulator" \
		+permissive \
		+max-cycles="$timeout_cycles" \
		+custom_boot_pin=1 \
		+uart_tx_printf=1 \
		+loadmem="$elf" \
		+permissive-off \
		"$elf"
	run_status=$?
	printf 'eliza-evidence: raw_transcript_end\n'
	if [ "$run_status" -eq 0 ]; then
		printf 'eliza-evidence: status=PASS\n'
	else
		printf 'eliza-evidence: status=BLOCKED simulator_exit=%s\n' "$run_status"
	fi
} > "$log" 2>&1
status=$run_status
cat "$log"
exit "$status"
