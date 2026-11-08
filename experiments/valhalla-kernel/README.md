# ValhallaOS V38 educational kernel

An original, freestanding x86-64 experiment. This is **not** the Eliza application,
the production ValhallaOS platform, or an implementation of an external V38 spec.
It does not replace `packages/os`, its Linux images, or the existing V38 services.

## Approved scope

The repository owner requested this isolated educational baseline and authorized
repository and website integration in the implementation session. This document
is the scope and MVP plan for this experiment. The supported milestone is a real
QEMU boot that checks memory, cooperative threads, and daemon message delivery.
Production deployment means publishing this download and its documentation,
not running the kernel as the website's server.

## Build and run

On an **x86-64 Ubuntu/Debian host**:

```sh
sudo apt-get update
sudo apt-get install build-essential binutils grub-common grub-pc-bin xorriso mtools qemu-system-x86 gdb
cd experiments/valhalla-kernel
make test
make iso CROSS=
make smoke CROSS=
make run CROSS=
```

The default compiler prefix is `x86_64-elf-`. With that cross-toolchain installed,
omit `CROSS=`. Native GCC is supported only on x86-64 Linux. ARM/macOS hosts need
a suitable cross-toolchain and GRUB image tools; the native command is not for them.
There are no network dependencies or host disk attachments in the QEMU command.
`-accel tcg` makes hardware virtualization optional.

The serial terminal prints memory, heap, scheduler, and daemon checks, exactly
three `worker says hello` lines, and `SELFTEST PASS`. There is no shell or desktop.
With `make run`, the kernel then halts; exit QEMU with **Ctrl+A, then X**.
`make smoke` attaches QEMU's test-exit device and checks both the serial milestones
and host exit status 1 (guest status 0). It fails after 30 seconds, on a panic,
on a bad exit, or when expected messages are missing. See `build/serial.log`.

For GDB, run `make debug CROSS=`, then in a second terminal:

```sh
gdb build/kernel.elf
```

```gdb
target remote :1234
break kernel_main
continue
```

The kernel has DWARF debug data. It is optimized, so some variables may be absent.
`scripts/build.sh`, `scripts/run.sh`, and `scripts/debug.sh` wrap these targets.

## Module contracts

| Module | Contract |
| --- | --- |
| `arch/x86_64/boot.S` | Multiboot2 entry, 32-bit to long-mode transition, GDT, 64 KiB boot stack, first 1 GiB identity map using 2 MiB pages. Requires an x86-64-capable QEMU CPU. |
| `kernel/pmm.c` | Reads the Multiboot2 RAM map; tracks usable 4 KiB pages below 1 GiB. Reserves low RAM, the full kernel, boot tags, and loaded modules. Returns zeroed pages, or 0 on exhaustion. Rejects unaligned, reserved, and double frees. |
| `kernel/vmm.c` | Four-level supervisor RW 4 KiB mappings from 1 GiB to the lower canonical limit. Rejects boot-map changes and existing mappings. Unmap invalidates the local TLB, but does not free backing frames or page-table pages. |
| `kernel/heap.c` | Zeroing, 16-byte-aligned 256 KiB bump heap. Returns NULL on zero size, overflow, or exhaustion. No free. |
| `kernel/scheduler.c` | Eight task slots including the boot thread, 16 KiB per worker stack, round-robin yield, and explicit task exit. Preserves System V callee-saved integer registers. No task-slot or stack reuse. |
| `kernel/ipc.c` | Eight registered service IDs, eight messages per mailbox, 96-byte payloads, ABI version 38. Synchronous copies; nonblocking FIFO send/receive with explicit error returns. No hidden retries or drop policy. |
| `kernel/main.c` | Executes actual memory and service boundary checks, then schedules logger and producer threads and verifies their completed delivery. |

Services and threads are trusted kernel code. Message validation checks format,
not pointer trust or permissions. Interrupts are disabled and there is one CPU;
IPC and allocators are **not** interrupt-safe or SMP-safe. Thread code must yield.

## Boundaries and risks

There is no exception handler, userspace, syscall ABI, process isolation, NX/W^X
enforcement, preemption, filesystem, networking, persistent storage, or hardware
installer. Bad memory accesses can triple-fault. The boot identity mapping covers
addresses that are not all usable RAM; allocation must use the RAM map, not that
mapping alone. Failed page-table construction can retain intermediate tables.
No memory or slots are reclaimed for exited tasks. Heap and page table operations
must be serialized. This is for QEMU study, not physical or production deployment.

## Verification and publishing

`make test` checks real IPC implementation code on the host. `make smoke CROSS=`
boots the ISO and exercises the allocator, page mapping, heap boundaries, threads,
and IPC in the guest. The inactive template in `ci/educational-kernel.yml.example` repeats the boot with 64, 128, and 256 MiB RAM and uploads
the ISO, ELF, source archive, checksums, and each serial log. A successful host test
alone does not establish a successful boot.

Before this change there was no educational freestanding kernel in this folder.
Local verification during implementation passed IPC tests, warnings-as-errors
compilation, Multiboot2 recognition, and actual QEMU/TCG boots with 64, 128, and
256 MiB RAM. The repository-wide Bun verification was unavailable in the sandbox;
this isolated C experiment does not certify the unrelated application stack.

For published downloads, obtain `valhalla.iso`, `kernel.elf`, `source.tar.gz`, and
`SHA256SUMS` from the same GitHub release. Run `sha256sum -c SHA256SUMS` after all
listed files and logs are downloaded. Checksums detect changed downloads; they
are not code signatures or a production security guarantee.

## CI activation permission

GitHub rejected the initial branch push because the authorized GitHub CLI OAuth
session lacks the `workflow` scope. No workflow was activated. The workflow is
provided as `ci/educational-kernel.yml.example`, not under `.github/workflows`.
A maintainer with workflow authorization can review it and copy it to
`.github/workflows/educational-kernel.yml`. Local real-boot verification is
complete; automatic kernel CI remains inactive until that authorized step.
