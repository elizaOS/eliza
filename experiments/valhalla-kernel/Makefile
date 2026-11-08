CROSS ?= x86_64-elf-
CC := $(CROSS)gcc
LD := $(CROSS)ld
HOSTCC ?= cc
QEMU ?= qemu-system-x86_64
CFLAGS := -std=c11 -O2 -g -Wall -Wextra -Werror -ffreestanding -fno-builtin -fno-stack-protector -fno-pie -fno-asynchronous-unwind-tables -m64 -mno-red-zone -mgeneral-regs-only -Iinclude
SOURCES := $(wildcard kernel/*.c)
ASSEMBLY := $(wildcard arch/x86_64/*.S)
OBJECTS := $(patsubst %.c,build/%.o,$(SOURCES)) $(patsubst %.S,build/%.o,$(ASSEMBLY))
.PHONY: all iso run debug test smoke clean
all: build/kernel.elf
build/%.o: %.c include/kernel.h
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -MMD -MP -c $< -o $@
build/%.o: %.S
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c $< -o $@
build/kernel.elf: $(OBJECTS) linker.ld
	$(LD) -nostdlib -z max-page-size=0x1000 -T linker.ld $(OBJECTS) -o $@
	grub-file --is-x86-multiboot2 $@
build/valhalla.iso: build/kernel.elf boot/grub.cfg
	mkdir -p build/iso/boot/grub
	cp build/kernel.elf build/iso/boot/kernel.elf
	cp boot/grub.cfg build/iso/boot/grub/grub.cfg
	grub-mkrescue -o $@ build/iso >build/iso-build.log 2>&1
iso: build/valhalla.iso
run: iso
	$(QEMU) -accel tcg -m 128M -smp 1 -cdrom build/valhalla.iso -boot d -display none -serial mon:stdio -no-reboot -no-shutdown
debug: iso
	$(QEMU) -accel tcg -m 128M -smp 1 -cdrom build/valhalla.iso -boot d -display none -serial mon:stdio -no-reboot -no-shutdown -S -s
build/ipc-test: tests/ipc.c kernel/ipc.c include/kernel.h
	mkdir -p build
	$(HOSTCC) -std=c11 -O2 -Wall -Wextra -Werror -Iinclude tests/ipc.c kernel/ipc.c -o $@
test: build/ipc-test
	./build/ipc-test
smoke: iso
	python3 scripts/smoke.py --qemu $(QEMU)
clean:
	rm -rf build
-include $(OBJECTS:.o=.d)
