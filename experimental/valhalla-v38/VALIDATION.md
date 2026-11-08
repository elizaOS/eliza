# Validation record

Validated locally on 2026-11-08, x86-64 Linux, native GCC and GNU ld, QEMU TCG
10.2.1, GRUB BIOS Multiboot2, one virtual CPU.

- `make CROSS= all`: passed with `-Wall -Wextra -Werror`, debug symbols,
  freestanding flags, no red zone, and general registers only.
- `grub-file --is-x86-multiboot2 build/kernel.elf`: passed.
- `make CROSS= test`: actual 128 MiB ISO boot passed, required serial markers,
  exactly three worker messages, and QEMU exit status 33.
- `python3 scripts/smoke.py --memory 64M`: actual ISO boot passed with the same
  evidence and exit status.

The initial harness used `-no-shutdown`, so it timed out despite a complete guest
PASS trace. Removing that option from the smoke runner produced the expected
process exit. The interactive run/debug targets retain it intentionally.

These checks demonstrate the educational boot path, not production safety or
arbitrary hardware compatibility. No UEFI, physical-device, ARM, SMP, userspace,
exception-recovery, or preemption validation was performed. Application-wide
`bun run verify` was not run: this isolated C/assembly project does not install or
change the Bun application workspace. The exact native build and boot checks above
are the relevant kernel evidence. Hosted CI is not enabled by the template.
