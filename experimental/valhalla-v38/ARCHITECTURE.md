# Architecture and contracts

## Boot

`arch/x86_64/boot.S` supplies a Multiboot2 header and 32-bit entry. GRUB loads
segments and zeros BSS. Entry preserves EAX/EBX, installs a GDT and a 1 GiB
identity mapping, enables PAE, EFER.LME, paging and CR0.WP, and calls
`kernel_main(magic, info)` on a 32 KiB aligned stack. Interrupts stay disabled.
The target must support x86-64 long mode; there is no CPUID fallback.

## Physical memory

`pmm_init` validates the Multiboot magic, tag lengths, and memory-map layout.
It manages full 4 KiB usable frames below 1 GiB with allocation and eligibility
bitmaps. It excludes memory below `kernel_end`, boot tags, and module contents.
`pmm_alloc` returns a zeroed, identity-mapped physical frame, or zero on exhaustion.
`pmm_free` rejects unaligned, reserved, and already-free frames. The caller must
not release frames still used as page tables, stacks, or active mappings.
The allocator cannot detect dangling aliases or ownership violations.

## Virtual memory and heap

`mmu_map(virt, phys, writable)` accepts aligned lower-canonical virtual addresses
and physical addresses below 1 GiB. It creates supervisor-only four-level page
tables as needed. It rejects an existing leaf or a huge-page collision and
invalidates the local TLB entry. Boot identity pages cannot be replaced with this
API. `mmu_unmap` returns the old physical frame through an optional pointer; it
does not free that frame or empty page tables. No cross-core TLB shootdown exists.
`heap_init` maps 256 KiB at virtual 2 GiB. `kmalloc` returns 16-byte-aligned memory,
or NULL for zero, oversized, or exhausted requests. There is no `kfree`.

## Scheduling

There are eight lifetime thread slots, including the initial kernel thread.
New threads receive a 16 KiB heap stack. `context_switch` saves the SysV x86-64
callee-saved general registers and stack pointer; compiler flags prohibit red-zone
and SIMD state. A trampoline invokes the entry function and calls `thread_exit`
on return. Yield scans READY slots in round-robin order. Dead slots and stacks
are not reused. The main kernel thread remains runnable as the idle thread.
All shared APIs assume one CPU and no preemption; they are not thread-safe under
other execution models. A non-yielding task can stop all progress.

## Daemon interface

Services are trusted kernel threads, not protected userspace daemons. Up to eight
unique service names of 1-31 bytes can register; IDs are 1-based, zero means
failure. Each service owns an eight-message FIFO. Messages are 112 bytes:
`uint16_t abi, type; uint32_t length; uint64_t sender; uint8_t payload[96]`.
A static assertion protects the native x86-64 structure size. `abi` must be 38;
`length` is a byte count from 0 to 96. Payloads are not assumed NUL-terminated.
The sender field is caller-supplied, not an authenticated identity. This is an
in-kernel ABI, not a network serialization or syscall contract.

Send/receive copy data and return IPC_OK, IPC_INVALID, IPC_NOT_FOUND, IPC_FULL,
or IPC_EMPTY. They never block and never implicitly yield. FIFO wraparound and
saturation are tested by the running guest. Service deletion and waiting queues
are not implemented. Callers must pass valid kernel pointers.

## Demonstration

The guest checks page zeroing, map/alias/unmap behavior, duplicate-map rejection,
invalid frees, heap alignment, daemon validation, saturation, FIFO, and wraparound.
A producer sends three messages to a yielding logger, then returns. Main requires
that all three messages arrived and the producer completed before emitting the
smoke marker. The emulator debug-exit port is used only by the smoke-test device;
normal run targets do not attach that device.
