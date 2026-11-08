# ValhallaOS V38 educational kernel

An isolated, original x86-64 kernel experiment. This is not the ElizaOS application,
not the existing V38 application services, and not a production operating system.
It does not change the trading, wallet, login, Linux image, or Android code.
See [approved scope](PLAN.md), [architecture and API contracts](ARCHITECTURE.md), and
[validation record](VALIDATION.md).

## Build and run

On an **x86-64 Debian/Ubuntu host**:

```sh
sudo apt-get update
sudo apt-get install build-essential binutils grub-common grub-pc-bin xorriso mtools qemu-system-x86 python3 gdb
cd experimental/valhalla-v38
make CROSS= test
make CROSS= run
```

`CROSS=` selects native x86-64 GCC/binutils. The default prefix is `x86_64-elf-`.
For an ARM host, install that cross-toolchain; native ARM GCC will not work.
`make iso` makes `build/valhalla-v38.iso`. Shell wrappers accept the same overrides:
`./scripts/build.sh CROSS=` and `./scripts/run.sh CROSS=`.

Direct launch after building:

```sh
qemu-system-x86_64 -accel tcg -m 128M -smp 1 \
  -cdrom build/valhalla-v38.iso -boot d -display none \
  -serial mon:stdio -no-reboot -no-shutdown
```

Press **Ctrl+A, then X** to leave the QEMU multiplexed console. The guest has no
shell or desktop. It prints three worker messages and `V38_SMOKE_PASS`, then
continues cooperative scheduling. Do not install it on a physical device.

## Test and debug

`make CROSS= test` builds a BIOS-bootable ISO and runs the actual guest under TCG.
It requires allocator, MMU, FIFO, context-switch, and thread-exit serial markers,
exactly three worker messages, and the debug-exit device status 33. A panic,
timeout, missing marker, or wrong exit status fails the test. The smoke runner
intentionally omits `-no-shutdown`, which would prevent debug-exit from ending
QEMU on the tested version. It saves `build/qemu-serial.log`.

```sh
make CROSS= debug
# In a second terminal:
gdb build/kernel.elf
# GDB:
# target remote :1234
# break kernel_main
# continue
```

The debug target pauses QEMU before execution. The ELF includes `-g` symbols.
The supplied [CI template](ci/v38-kernel.yml) builds, boots, and uploads the ISO,
ELF, checksum file, and serial log. It is **not enabled** until a maintainer copies
it to `.github/workflows/v38-kernel.yml` using credentials with workflow-edit
permission. Source and verified release artifacts can be published independently.

## Limits

Single-core, cooperative, trusted kernel threads only. Interrupts remain disabled;
there is no IDT/exception handler, preemption, userspace, syscall boundary, SMP,
filesystem, networking, storage driver, authentication, or browser emulator.
Only usable physical RAM below 1 GiB is managed. The initial 1 GiB mapping uses
2 MiB pages; new mappings use 4 KiB pages. Page-table pages, heap allocations,
and exited thread stacks are not reclaimed. No NX/W^X isolation is provided.
A mapping failure can retain intermediate page-table pages. Boot requires
Multiboot2, BIOS GRUB, and an x86-64 CPU with long-mode support.
