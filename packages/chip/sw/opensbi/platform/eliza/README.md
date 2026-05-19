# OpenSBI platform: eliza-e1-cpu-variant

OpenSBI platform glue for the `e1_chip_cpu_variant` projection from
[`sw/platform/e1_platform_contract.json`](../../../platform/e1_platform_contract.json).

## Addresses (single source of truth: the contract)

| Block | Base       | Notes                                |
|-------|------------|--------------------------------------|
| UART  | 0x10001000 | ns16550a, IRQ 1, 50 MHz, 115200 8N1  |
| PLIC  | 0x0C000000 | 32 sources, 2 contexts (M + S)       |
| CLINT | 0x02000000 | mtime 10 MHz                         |
| DRAM  | 0x80000000 | 256 MiB; SBI @ 0x80000000, kernel @ 0x80200000 |

## Build

```sh
# Copy this directory into a sibling OpenSBI checkout:
cp -r sw/opensbi/platform/eliza external/opensbi/platform/

# Build fw_payload with the Linux kernel embedded:
make -C external/opensbi PLATFORM=eliza \
    FW_PAYLOAD_PATH=$(pwd)/external/linux/arch/riscv/boot/Image

# Output:
# external/opensbi/build/platform/eliza/firmware/fw_payload.elf
```

Then run the Renode tier-2 smoke from `scripts/sim/run_renode_tier2.sh`.
