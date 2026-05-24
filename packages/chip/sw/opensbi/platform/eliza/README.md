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

## Build (OpenSBI v1.8.1, verified)

This platform builds against the pinned OpenSBI v1.8.1 in
`external/opensbi/opensbi`. It carries the three files OpenSBI v1.8.x requires
for a fixed (non-FDT) platform — `platform.c`, `Kconfig`, and
`configs/defconfig` — and uses the v1.8.x driver model (single-shot
`irqchip_init`/`timer_init`, no `.console_init`/`.ipi_init` ops; the console
UART is registered in `early_init`).

OpenSBI requires a **PIE-capable linker**, which the bare-metal newlib
toolchain (`riscv-none-elf-`) does not provide. Build with the Linux GNU
cross under `external/riscv64-linux-gnu` (its binutils needs `libopcodes` on
`LD_LIBRARY_PATH`):

```sh
source tools/env.sh
cp -r sw/opensbi/platform/eliza external/opensbi/opensbi/platform/eliza
export PATH="$PWD/external/riscv64-linux-gnu/usr/bin:$PATH"
export LD_LIBRARY_PATH="$PWD/external/riscv64-linux-gnu/usr/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH"

# fw_jump (no payload) — proves the platform builds + links PIE:
make -C external/opensbi/opensbi PLATFORM=eliza \
    CROSS_COMPILE=riscv64-linux-gnu- FW_PAYLOAD=n FW_JUMP=y \
    FW_JUMP_ADDR=0x80200000 FW_JUMP_FDT_ADDR=0x82200000 \
    PLATFORM_RISCV_ISA=rv64gc
# -> build/platform/eliza/firmware/fw_jump.{elf,bin}  (banner: eliza-e1-cpu-variant)

# fw_payload with the Linux kernel embedded:
make -C external/opensbi/opensbi PLATFORM=eliza \
    CROSS_COMPILE=riscv64-linux-gnu- PLATFORM_RISCV_ISA=rv64gc \
    FW_PAYLOAD_PATH=$(pwd)/external/linux/arch/riscv/boot/Image
# -> build/platform/eliza/firmware/fw_payload.elf
```

Running the image on CVA6 in Verilator additionally needs a ns16550a UART
model @ 0x10001000 wired into the CPU-from-DRAM boot top
(`rtl/top/e1_cva6_dram_boot_top.sv`) plus a DTB in `a1`. The CVA6 execution
substrate that this firmware sits on is proven by
`scripts/check_cva6_boot_substrate.py` (see
`docs/evidence/cpu_ap/cva6-boot-substrate.json`).
