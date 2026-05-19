# fw/boot-rom/Makefile
#
# Build the v0 Eliza boot ROM stub.
# This Makefile is intentionally standalone: it does NOT run any simulation.
# It only assembles, links, and emits the binary + hex artefacts that the
# generated CPU wrapper (docs/rtl/cpu-config-selection.md) and any future
# contract ROM model will consume.
#
# Required tools (on $PATH):
#   riscv64-unknown-elf-gcc
#   riscv64-unknown-elf-objcopy
#   riscv64-unknown-elf-objdump
# If absent, the `tools-check` target reports a clear blocker without
# pretending the build succeeded.

CROSS_COMPILE ?= riscv64-unknown-elf-
CC      := $(CROSS_COMPILE)gcc
OBJCOPY := $(CROSS_COMPILE)objcopy
OBJDUMP := $(CROSS_COMPILE)objdump

ARCH_FLAGS := -march=rv64imac_zicsr -mabi=lp64 -mcmodel=medany
CFLAGS  := $(ARCH_FLAGS) -nostdlib -nostartfiles -fno-pic -ffreestanding -Wall -Werror -O1
LDFLAGS := -nostdlib -nostartfiles -Wl,-T,linker.ld -Wl,--no-relax

OBJS    := reset.o
ELF     := e1_boot_rom.elf
BIN     := e1_boot_rom.bin
HEX     := e1_boot_rom.hex
DUMP    := e1_boot_rom.dump

.PHONY: all clean tools-check
all: $(BIN) $(HEX) $(DUMP)

tools-check:
	@command -v $(CC) >/dev/null 2>&1 || { \
	  echo "BLOCKED: $(CC) not found. Install the riscv64-unknown-elf toolchain or set CROSS_COMPILE." >&2; \
	  exit 2; }

%.o: %.S
	$(CC) $(CFLAGS) -c $< -o $@

$(ELF): $(OBJS) linker.ld
	$(CC) $(CFLAGS) $(LDFLAGS) $(OBJS) -o $@

$(BIN): $(ELF)
	$(OBJCOPY) -O binary $< $@

# Hex format suitable for $readmemh (32-bit words, little-endian).
$(HEX): $(BIN)
	@python3 -c "import sys, pathlib; data=pathlib.Path('$<').read_bytes(); \
words=[int.from_bytes(data[i:i+4].ljust(4, b'\\x00'),'little') for i in range(0,len(data),4)]; \
pathlib.Path('$@').write_text('\\n'.join(f'{w:08x}' for w in words)+'\\n')"

$(DUMP): $(ELF)
	$(OBJDUMP) -d $< > $@

clean:
	rm -f $(OBJS) $(ELF) $(BIN) $(HEX) $(DUMP)
