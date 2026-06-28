# Tier 1 OpenSBI S-mode payload.

CROSS    ?= riscv64-unknown-elf-
CC       := $(CROSS)gcc
OBJCOPY  := $(CROSS)objcopy

# S-mode link address.  Default matches the QEMU-virt FW_JUMP_ADDR
# (0x80200000); the CVA6 Verilator boot overrides it with a compact address so
# the whole boot image fits in the DRAM-controller preload window.
PAYLOAD_LINK_ADDR ?= 0x80200000

# UART MMIO base. Defaults to the canonical e1-chip-variant address
# (e1_chip_cpu_variant.uart.base in sw/platform/e1_platform_contract.json).
# The stock-QEMU-virt bring-up harness overrides this with
# UART0_BASE=0x10000000UL (the qemu_virt software_reference_only entry).
UART0_BASE ?= 0x10001000UL

CFLAGS   := -nostdlib -nostartfiles -ffreestanding -fno-pic \
            -mcmodel=medany -march=rv64imac_zicsr -mabi=lp64 \
            -DUART0_BASE=$(UART0_BASE) \
            -O2 -Wall -Wextra -g
LDFLAGS  := -Wl,-T,linker.ld -Wl,--no-warn-rwx-segments \
            -Wl,--defsym,PAYLOAD_LINK_ADDR=$(PAYLOAD_LINK_ADDR)

OBJS := reset.o e1.o
TARGET := e1

.PHONY: all clean
all: $(TARGET).elf $(TARGET).bin

%.o: %.S
	$(CC) $(CFLAGS) -c $< -o $@

%.o: %.c
	$(CC) $(CFLAGS) -c $< -o $@

$(TARGET).elf: $(OBJS) linker.ld
	$(CC) $(CFLAGS) $(LDFLAGS) $(OBJS) -o $@

$(TARGET).bin: $(TARGET).elf
	$(OBJCOPY) -O binary $< $@

clean:
	rm -f *.o $(TARGET).elf $(TARGET).bin
