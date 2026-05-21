# Tier 1 OpenSBI S-mode payload.

CROSS    ?= riscv64-elf-
CC       := $(CROSS)gcc
OBJCOPY  := $(CROSS)objcopy

# UART MMIO base. Defaults to the canonical e1-chip-variant address
# (e1_chip_cpu_variant.uart.base in sw/platform/e1_platform_contract.json).
# The stock-QEMU-virt bring-up harness overrides this with
# UART0_BASE=0x10000000UL (the qemu_virt software_reference_only entry).
UART0_BASE ?= 0x10001000UL

CFLAGS   := -nostdlib -nostartfiles -ffreestanding -fno-pic \
            -mcmodel=medany -march=rv64imac_zicsr -mabi=lp64 \
            -DUART0_BASE=$(UART0_BASE) \
            -O2 -Wall -Wextra -g
LDFLAGS  := -Wl,-T,linker.ld -Wl,--no-warn-rwx-segments

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
