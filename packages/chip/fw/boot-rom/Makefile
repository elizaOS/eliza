# fw/boot-rom/Makefile
#
# Builds two artifacts:
#   all         -> the reset-only scaffold ROM (4 KiB, linker.ld) — the
#                  artifact the RTL contract ROM and check_boot_rom.py consume.
#   secure-rom  -> the full secure mask ROM: reset.S calling the OPNPHN01
#                  verifier (Ed25519 + SHA-256, key ladder, rollback,
#                  lifecycle, measurement chain), linked with secure/rom.ld.
#   secure-objs -> freestanding compile-only proof of the secure C sources.
#
# This Makefile is standalone and runs no simulation.
#
# Tools (on $PATH via tools/env.sh): riscv64-unknown-elf-gcc for compile/link.
# objcopy/objdump use the cross tools when present and fall back to llvm-*,
# which the vendored toolchain provides.

CROSS_COMPILE ?= riscv64-unknown-elf-
CC      := $(CROSS_COMPILE)gcc
OBJCOPY := $(shell command -v $(CROSS_COMPILE)objcopy 2>/dev/null || command -v riscv-none-elf-objcopy 2>/dev/null || command -v llvm-objcopy 2>/dev/null || echo $(CROSS_COMPILE)objcopy)
OBJDUMP := $(shell command -v $(CROSS_COMPILE)objdump 2>/dev/null || command -v riscv-none-elf-objdump 2>/dev/null || command -v llvm-objdump 2>/dev/null || echo $(CROSS_COMPILE)objdump)

ARCH_FLAGS := -march=rv64imac_zicsr -mabi=lp64 -mcmodel=medany
CFLAGS  := $(ARCH_FLAGS) -nostdlib -nostartfiles -fno-pic -ffreestanding -fno-builtin \
           -fdata-sections -ffunction-sections -Wall -Wextra -Wno-unused-parameter -Werror -Os
ASFLAGS := $(ARCH_FLAGS) -nostdlib -nostartfiles -fno-pic -ffreestanding

# Reset-only scaffold ROM (legacy 4 KiB artifact).
LDFLAGS := -nostdlib -nostartfiles -Wl,-T,linker.ld -Wl,--no-relax
ELF     := e1_boot_rom.elf
BIN     := e1_boot_rom.bin
HEX     := e1_boot_rom.hex
DUMP    := e1_boot_rom.dump

# Secure-boot ROM: OPNPHN01 verifier, freestanding crypto, measurement chain,
# freestanding mem primitives, and the C reset entrypoint reset.S calls into.
SECURE_DIR := secure
SECURE_SRCS := \
	$(SECURE_DIR)/rom_libc.c \
	$(SECURE_DIR)/sha256.c \
	$(SECURE_DIR)/ed25519_ct.c \
	$(SECURE_DIR)/verify.c \
	$(SECURE_DIR)/measure.c \
	$(SECURE_DIR)/boot.c
SECURE_OBJS := $(SECURE_SRCS:.c=.o)

SECURE_LD   := $(SECURE_DIR)/rom.ld
SECURE_LDFLAGS := -nostdlib -nostartfiles -Wl,-T,$(SECURE_LD) -Wl,--no-relax -Wl,--gc-sections
SECURE_ELF  := e1_secure_boot_rom.elf
SECURE_BIN  := e1_secure_boot_rom.bin
SECURE_DUMP := e1_secure_boot_rom.dump

.PHONY: all secure-rom secure-objs clean tools-check
all: $(BIN) $(HEX) $(DUMP)

secure-rom: $(SECURE_BIN) $(SECURE_DUMP)
	@echo "fw/boot-rom: secure mask ROM linked freestanding ($(SECURE_ELF))"

# Compile-only proof the secure ROM C sources build freestanding for RV64.
secure-objs: $(SECURE_OBJS)
	@echo "fw/boot-rom: secure ROM objects compiled freestanding for $(ARCH_FLAGS)"

tools-check:
	@command -v $(CC) >/dev/null 2>&1 || { \
	  echo "BLOCKED: $(CC) not found. Install the riscv64-unknown-elf toolchain or set CROSS_COMPILE." >&2; \
	  exit 2; }

reset.o: reset.S
	$(CC) $(ASFLAGS) -c $< -o $@

$(SECURE_DIR)/%.o: $(SECURE_DIR)/%.c
	$(CC) $(CFLAGS) -I$(SECURE_DIR) -c $< -o $@

# --- reset-only scaffold ROM ---
$(ELF): reset.o linker.ld
	$(CC) $(CFLAGS) $(LDFLAGS) reset.o -o $@

$(BIN): $(ELF)
	$(OBJCOPY) -O binary $< $@

# Hex format suitable for $readmemh (32-bit words, little-endian).
$(HEX): $(BIN)
	@python3 -c "import sys, pathlib; data=pathlib.Path('$<').read_bytes(); \
words=[int.from_bytes(data[i:i+4].ljust(4, b'\\x00'),'little') for i in range(0,len(data),4)]; \
pathlib.Path('$@').write_text('\\n'.join(f'{w:08x}' for w in words)+'\\n')"

$(DUMP): $(ELF)
	$(OBJDUMP) -d $< > $@

# --- full secure mask ROM ---
$(SECURE_ELF): reset.o $(SECURE_OBJS) $(SECURE_LD)
	$(CC) $(CFLAGS) $(SECURE_LDFLAGS) reset.o $(SECURE_OBJS) -o $@ -lgcc

$(SECURE_BIN): $(SECURE_ELF)
	$(OBJCOPY) -O binary $< $@

$(SECURE_DUMP): $(SECURE_ELF)
	$(OBJDUMP) -d $< > $@

clean:
	rm -f reset.o $(SECURE_OBJS) \
	      $(ELF) $(BIN) $(HEX) $(DUMP) \
	      $(SECURE_ELF) $(SECURE_BIN) $(SECURE_DUMP)
