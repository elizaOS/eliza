# Eliza E1 NPU QEMU functional model

This directory holds a functional QEMU device model for the `eliza,e1-npu` MMIO
block plus the host scripts that boot Linux on it and produce the e1 MMIO and
e1 NPU ML smoke evidence for the software-BSP gates.

The smoke output is computed by a real model, not fabricated: the QEMU device
executes the same INT8/INT4 GEMM, scalar, packed-dot and vector-ReLU arithmetic
as the RTL (`rtl/npu/e1_npu.sv`), over the operands the kernel driver programs.

## Contents

- `qemu-device/eliza_e1_npu.c`, `qemu-device/eliza_e1_npu.h` — the QEMU
  `SysBusDevice` model. Register byte offsets follow
  `sw/platform/e1_platform_contract.json` (the RTL 6-bit word address equals
  `byte_offset >> 2`). On a START doorbell it runs the programmed scalar/GEMM/
  vector op; on a descriptor doorbell it walks the 4-word descriptor ring from
  guest memory, optionally streams operands into the scratchpad, executes, and
  optionally writes GEMM output back to guest memory via DMA. It raises the IRQ
  line on completion and models the perf counters.
- `qemu-device/virt-e1-npu-integration.patch` — adds the device to QEMU's
  `virt` machine at `0x10020000`, gated behind `-machine virt,e1-npu=on`
  (default off — zero change to default `virt` behaviour), wired to the virt
  PLIC, with an auto-generated `npu@10020000` FDT node.
- `build-e1-qemu-stack.sh` — builds `qemu-system-riscv64` with the device, a
  RISC-V Linux Image with the e1 NPU/DMA contract drivers
  (`sw/linux/drivers/e1/{e1-npu,e1-dma}.c`) built in plus
  `CONFIG_SERIAL_OF_PLATFORM`, and an initramfs containing the smoke binaries.
- `run-e1-smoke.sh mmio|ml` — boots Linux on the model and runs one smoke,
  emitting its guest stdout and exiting with the smoke's exit code.
- `guest-init/S99e1smoke`, `gen-cpio-list.py` — guest-side runner and
  initramfs assembly helper.

## Reproduce

```sh
sw/qemu/build-e1-qemu-stack.sh
sw/qemu/run-e1-smoke.sh ml      # GEMM_S8 c=[[-44,8],[139,-54]] (golden_gemm_s8)
sw/qemu/run-e1-smoke.sh mmio
```

## Evidence capture

```sh
BR=external/buildroot-2024.11
LX=$BR/output/build/linux-6.12.90
E1_SMOKE_CMD="$PWD/sw/qemu/run-e1-smoke.sh mmio" \
  sw/buildroot/scripts/capture-buildroot-evidence.sh "$PWD/$BR" smoke
E1_NPU_ML_SMOKE_CMD="$PWD/sw/qemu/run-e1-smoke.sh ml" \
  sw/buildroot/scripts/capture-buildroot-evidence.sh "$PWD/$BR" ml-smoke
E1_SMOKE_CMD="$PWD/sw/qemu/run-e1-smoke.sh mmio" \
  sw/linux/scripts/capture-linux-bsp-evidence.sh "$PWD/$LX" smoke
python3 scripts/check_software_bsp.py buildroot --require-evidence
python3 scripts/check_software_bsp.py linux --require-evidence
```

The QEMU source tree (`external/qemu-src`) and buildroot/Linux build trees are
gitignored host checkouts; `build-e1-qemu-stack.sh` installs the tracked device
model and integration patch into them and rebuilds.
