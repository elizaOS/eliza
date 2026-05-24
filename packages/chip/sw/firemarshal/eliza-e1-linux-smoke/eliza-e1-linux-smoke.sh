#!/bin/sh
set -eu

NPU_BASE=0x10020000
DMA_BASE=0x10010000
DISPLAY_BASE=0x10030000
UART_BASE=0x10001000
UART_TXDATA="$UART_BASE"
UART_TX_FULL=0x80000000

read32() {
	busybox devmem "$1" 32
}

write32() {
	busybox devmem "$1" 32 "$2" >/dev/null
}

uart_putc() {
	byte="$1"
	wait=0
	while [ "$wait" -lt 100000 ]; do
		tx="$(read32 "$UART_TXDATA")"
		if [ $((tx & UART_TX_FULL)) -eq 0 ]; then
			write32 "$UART_TXDATA" "$byte"
			return 0
		fi
		wait=$((wait + 1))
	done
	echo "e1-uart-evidence: FAIL tx fifo full"
	exit 1
}

uart_puts() {
	printf '%s\n' "$1" | od -An -t u1 -v | while read -r line; do
		for byte in $line; do
			uart_putc "$byte"
		done
	done
}

emit() {
	echo "$1"
	uart_puts "$1"
}

expect32() {
	name="$1"
	addr="$2"
	expected="$3"
	actual="$(read32 "$addr")"
	if [ "$actual" != "$expected" ]; then
		echo "e1-mmio-smoke: FAIL ${name} expected=${expected} actual=${actual}"
		exit 1
	fi
}

emit "eliza-evidence: target=generated_chipyard_ap artifact=eliza-e1-linux-smoke"
emit "Linux early console: SiFive MMIO earlycon enabled; Linux userland UART evidence at 0x10001000"
emit "generated DTS hash: see build/chipyard/eliza_rocket/ElizaRocketConfig.manifest.json"
emit "memory node: memory@80000000 size=256MiB"
emit "CPU node: RV64GC Rocket"
emit "timer node: CLINT/ACLINT via generated Chipyard DTS"
emit "interrupt-controller node: PLIC via generated Chipyard DTS"
emit "UART node: serial@10001000"
emit "chosen stdout: /soc/serial@10001000"
emit "Linux CONFIG_MMU: $(zcat /proc/config.gz 2>/dev/null | grep -E '^CONFIG_MMU=' || echo CONFIG_MMU=unknown)"
emit "initramfs start: firemarshal command running"

if /usr/bin/eliza-riscv-hwprobe > /tmp/eliza-riscv-hwprobe.log 2>&1; then
	while IFS= read -r line; do
		emit "$line"
	done < /tmp/eliza-riscv-hwprobe.log
else
	while IFS= read -r line; do
		emit "$line"
	done < /tmp/eliza-riscv-hwprobe.log
	emit "riscv_hwprobe: FAIL userspace helper exited nonzero"
	exit 1
fi

write32 "$DMA_BASE" 0x00000001
expect32 "dma-reg0" "$DMA_BASE" "0x00000001"
write32 "$DISPLAY_BASE" 0x00000002
expect32 "display-reg0" "$DISPLAY_BASE" "0x00000002"

# A = [[1, 2, 3], [4, 5, 6]], B = [[7, 8], [9, 10], [11, 12]]
# Expected C = [[58, 64], [139, 154]] for the generated NPU GEMM opcode.
write32 "$((NPU_BASE + 0x80))" 0x04030201
write32 "$((NPU_BASE + 0x84))" 0x00000605
write32 "$((NPU_BASE + 0x88))" 0x0a090807
write32 "$((NPU_BASE + 0x8c))" 0x00000c0b
write32 "$((NPU_BASE + 0x20))" 0x00030202
write32 "$((NPU_BASE + 0x24))" 0x00200800
write32 "$((NPU_BASE + 0x10))" 0x00000008
write32 "$((NPU_BASE + 0x0c))" 0x00000001

expect32 "npu-result-c00" "$((NPU_BASE + 0x08))" "0x0000003A"
expect32 "npu-result-c01" "$((NPU_BASE + 0x18))" "0x00000040"
expect32 "npu-scratch-c00" "$((NPU_BASE + 0x80 + 8 * 4))" "0x0000003A"
expect32 "npu-scratch-c01" "$((NPU_BASE + 0x80 + 9 * 4))" "0x00000040"
expect32 "npu-scratch-c10" "$((NPU_BASE + 0x80 + 10 * 4))" "0x0000008B"
expect32 "npu-scratch-c11" "$((NPU_BASE + 0x80 + 11 * 4))" "0x0000009A"
expect32 "npu-perf-macs" "$((NPU_BASE + 0x54))" "0x0000000C"
expect32 "npu-perf-errors" "$((NPU_BASE + 0x5c))" "0x00000000"

emit "e1 MMIO smoke result: PASS dma=0x10010000 npu=0x10020000 display=0x10030000"

if [ ! -c /dev/e1-npu ]; then
	emit "e1-npu-ml-smoke: FAIL device=/dev/e1-npu missing"
	emit "CPU-only fallback rejected: e1 NPU device is required"
	exit 1
fi

if /usr/bin/e1-npu-ml-smoke --device /dev/e1-npu --workload gemm_s8_int8_2x2x3 --require-npu > /tmp/e1-npu-ml-smoke.log 2>&1; then
	while IFS= read -r line; do
		emit "$line"
	done < /tmp/e1-npu-ml-smoke.log
	emit "device=/dev/e1-npu"
	emit "require_npu=true"
	emit "CPU fallback percent=0"
else
	while IFS= read -r line; do
		emit "$line"
	done < /tmp/e1-npu-ml-smoke.log
	emit "e1-npu-ml-smoke: FAIL device=/dev/e1-npu require_npu=true"
	emit "CPU-only fallback rejected: e1 NPU device is required"
	exit 1
fi

emit "eliza-evidence: status=PASS"

poweroff -f
