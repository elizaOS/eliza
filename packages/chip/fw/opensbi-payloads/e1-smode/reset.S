    .option norvc
    .section .text.reset, "ax", @progbits
    .globl _start

/*
 * Tier 1 S-mode payload entry. OpenSBI (M-mode) hands off to the payload
 * at 0x80200000 in S-mode with a0=hartid, a1=dtb pointer.
 * Park secondary harts, set sp on hart 0, call main().
 */
_start:
    csrr    t0, mhartid     /* still readable; OpenSBI may emulate */
    bnez    t0, park

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
