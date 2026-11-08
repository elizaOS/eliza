CROSS ?= x86_64-elf-
CC := $(CROSS)gcc
LD := $(CROSS)ld
QEMU ?= qemu-system-x86_64
CFLAGS := -std=c11 -O2 -g -Wall -Wextra -Werror -ffreestanding -fno-builtin -fno-pie -fno-stack-protector -fno-asynchronous-unwind-tables -m64 -mno-red-zone -mgeneral-regs-only -Iinclude
ASFLAGS := -g -m64 -ffreestanding -fno-pie
SOURCES := kernel/main.c kernel/runtime.c mm/physical.c mm/virtual.c mm/heap.c sched/scheduler.c ipc/daemon.c
ASSEMBLY := arch/x86_64/boot.S arch/x86_64/switch.S
OBJECTS := $(SOURCES:%.c=build/%.o) $(ASSEMBLY:%.S=build/%.o)
.PHONY: all iso run debug test smoke clean
all: build/kernel.elf
build/%.o: %.c
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -MMD -MP -c $< -o $@
build/%.o: %.S
	@mkdir -p $(dir $@)
	$(CC) $(ASFLAGS) -c $< -o $@
build/kernel.elf: $(OBJECTS) linker.ld
	$(LD) -nostdlib -static -z max-page-size=0x1000 -T linker.ld -o $@ $(OBJECTS)
build/valhalla-v38.iso: build/kernel.elf boot/grub.cfg
	grub-file --is-x86-multiboot2 build/kernel.elf
	mkdir -p build/isodir/boot/grub
	cp build/kernel.elf build/isodir/boot/kernel.elf
	cp boot/grub.cfg build/isodir/boot/grub/grub.cfg
	grub-mkrescue -o $@ build/isodir
iso: build/valhalla-v38.iso
run: iso
	$(QEMU) -accel tcg -m 128M -smp 1 -cdrom build/valhalla-v38.iso -boot d -display none -serial mon:stdio -no-reboot -no-shutdown
debug: iso
	$(QEMU) -accel tcg -m 128M -smp 1 -cdrom build/valhalla-v38.iso -boot d -display none -serial mon:stdio -no-reboot -no-shutdown -s -S
smoke test: iso
	python3 scripts/smoke.py --qemu $(QEMU)
clean:
	rm -rf build
-include $(SOURCES:%.c=build/%.d)
