# Tier 1 OpenSBI S-mode payload.

CROSS    ?= riscv64-elf-
CC       := $(CROSS)gcc
OBJCOPY  := $(CROSS)objcopy

CFLAGS   := -nostdlib -nostartfiles -ffreestanding -fno-pic \
            -mcmodel=medany -march=rv64imac_zicsr -mabi=lp64 \
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
