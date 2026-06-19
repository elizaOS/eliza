# SPDX-License-Identifier: BSD-2-Clause
# OpenSBI platform config for the eliza e1_chip_cpu_variant.
# Addresses MUST match sw/platform/e1_platform_contract.json
# (section: e1_chip_cpu_variant).

# Compiler pre-processor flags
platform-cppflags-y =

# C Compiler and assembler flags
platform-cflags-y =
platform-asflags-y =

# Linker flags: link address (SBI entry per contract: 0x80000000)
platform-ldflags-y =

# Blobs and addresses
FW_TEXT_START=0x80000000

# fw_payload: pack the Linux kernel right after the SBI image
FW_PAYLOAD=y
FW_PAYLOAD_OFFSET=0x200000     # kernel_entry = 0x80200000 (0x80000000 + 0x200000)
# FW_PAYLOAD_FDT_ADDR=0x80b00000  # optional explicit DTB load address
# FW_PAYLOAD_FDT_PATH=...          # set at build time if a DTB is provided

# Per-contract: rv64gc, 1 hart
PLATFORM_RISCV_XLEN=64
PLATFORM_RISCV_ABI=lp64d
PLATFORM_RISCV_ISA=rv64gc
PLATFORM_RISCV_CODE_MODEL=medany
