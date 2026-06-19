    .option norvc
    .section .text.reset, "ax", @progbits
    .globl _start

/*
 * Tier 0 bare-metal reset for QEMU virt (-machine virt -bios none -kernel).
 * QEMU jumps to 0x80000000 in M-mode with a0=hartid, a1=dtb pointer.
 * Park secondary harts, set sp on hart 0, and call main().
 */
_start:
    csrr    t0, mhartid
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
