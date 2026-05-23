    .option norvc
    .section .text.reset, "ax", @progbits
    .globl _start

/*
 * Tier 1 S-mode payload entry. OpenSBI (M-mode) hands off to the payload in
 * S-mode with a0=hartid, a1=dtb pointer.  hartid comes from a0 — `mhartid` is
 * an M-mode CSR and reading it from S-mode raises an illegal-instruction trap
 * (it must NOT be touched here).  Park secondary harts, set sp on hart 0,
 * call main().
 */
_start:
    bnez    a0, park        /* a0 = hartid (passed by OpenSBI) */

    la      sp, __stack_top
    call    main

park:
    wfi
    j       park

    .section .bss.stack, "aw", @nobits
    .balign 16
    .globl __stack_bottom
__stack_bottom:
    .skip 4096
    .globl __stack_top
__stack_top:
