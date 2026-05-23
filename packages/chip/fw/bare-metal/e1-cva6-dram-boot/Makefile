# Bare-metal RV64 M-mode CPU-execution proof for the E1 CVA6 boot substrate.
#
# Builds boot.S into an ELF linked at the DRAM base (0x8000_0000), then emits
# the flat binary + a 128-bit-per-line hex image the cocotb harness preloads
# into the SoC's DRAM controller via $readmemh.
#
# Toolchain: riscv64-unknown-elf-* (tools/env.sh puts it on PATH).

# Compile/link with the GNU RISC-V gcc driver (tools/env.sh provides
# riscv64-unknown-elf-gcc, a wrapper over the xPack riscv-none-elf toolchain).
# Binary/disassembly post-processing uses the LLVM tools, which are on PATH for
# every tool boundary and read RISC-V ELF identically — this avoids depending on
# the exact GNU binutils prefix (riscv64-unknown-elf- vs riscv-none-elf-).
CC      := riscv64-unknown-elf-gcc
OBJCOPY := llvm-objcopy
OBJDUMP := llvm-objdump

ARCH    := rv64imac_zicsr
ABI     := lp64

CFLAGS  := -march=$(ARCH) -mabi=$(ABI) -mcmodel=medany -nostdlib -nostartfiles \
           -ffreestanding -fno-pic -Wall -Wextra -O2
LDFLAGS := -T linker.ld -Wl,--build-id=none

BUILD   ?= build
TARGET  := $(BUILD)/boot

# The hex128 image is the only artifact the sim consumes; the disassembly is a
# best-effort human aid (skipped if the LLVM disassembler lacks a RISC-V target).
all: $(TARGET).elf $(TARGET).bin $(TARGET).hex128 $(TARGET).lst

$(BUILD):
	mkdir -p $(BUILD)

$(TARGET).elf: boot.S linker.ld | $(BUILD)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ boot.S

$(TARGET).bin: $(TARGET).elf
	$(OBJCOPY) -O binary $< $@

$(TARGET).lst: $(TARGET).elf
	-$(OBJDUMP) -d --triple=riscv64 --mattr=+m,+a,+c $< > $@ 2>/dev/null || \
	  echo "(disassembly unavailable: llvm-objdump lacks a riscv64 target)" > $@

# 128-bit (16-byte) words, one per line, MSB-first — matches the
# $readmemh layout the DRAM-model preload expects.
$(TARGET).hex128: $(TARGET).bin
	python3 bin2hex128.py $< $@

clean:
	rm -rf $(BUILD)

.PHONY: all clean
