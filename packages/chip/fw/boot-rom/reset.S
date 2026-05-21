    .option norvc
    .section .text.reset, "ax", @progbits
    .globl _start
    .globl e1_bootrom_trap

/*
 * RV64 mask-ROM reset vector.
 *
 * Establishes the trap vector and stack, masks interrupts, then calls the C
 * secure-boot entrypoint. That entrypoint authenticates the first-stage image
 * (OPNPHN01 container, Ed25519 + SHA-256, key ladder, rollback, lifecycle) and
 * returns the authenticated next-stage entry address in a0, or 0 on any
 * reject. A zero return is a hard fail-closed trap: there is no fixed handoff
 * address and no unsigned fallback. The handoff target is decided only after
 * authentication succeeds.
 */
_start:
    la      t0, e1_bootrom_trap
    csrw    mtvec, t0
    csrci   mstatus, 0x8
    la      sp, __bootrom_stack_top

    call    e1_secure_boot_main
    beqz    a0, e1_bootrom_trap
    jr      a0

e1_bootrom_trap:
    wfi
    j       e1_bootrom_trap
