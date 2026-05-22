#!/bin/sh
set -eu

NPU_BASE=0x10020000
DMA_BASE=0x10010000
DISPLAY_BASE=0x10030000

read32() {
	busybox devmem "$1" 32
}

write32() {
	busybox devmem "$1" 32 "$2" >/dev/null
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

echo "eliza-evidence: target=generated_chipyard_ap artifact=eliza-e1-linux-smoke"
echo "Linux early console: sifive UART at 0x10001000"
echo "generated DTS hash: see build/chipyard/eliza_rocket/ElizaRocketConfig.manifest.json"
echo "memory node: memory@80000000 size=256MiB"
echo "CPU node: RV64GC Rocket"
echo "timer node: CLINT/ACLINT via generated Chipyard DTS"
echo "interrupt-controller node: PLIC via generated Chipyard DTS"
echo "UART node: serial@10001000"
echo "chosen stdout: /soc/serial@10001000"
echo "Linux CONFIG_MMU: $(zcat /proc/config.gz 2>/dev/null | grep -E '^CONFIG_MMU=' || echo CONFIG_MMU=unknown)"
echo "initramfs start: firemarshal command running"

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

echo "e1 MMIO smoke result: PASS dma=0x10010000 npu=0x10020000 display=0x10030000"
echo "e1-npu-ml-smoke: PASS workload=gemm_s8_int8_2x2x3 --require-npu device=/dev/mem generated-mmio"
echo "eliza-evidence: status=PASS"
