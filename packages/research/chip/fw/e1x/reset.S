    .option norvc
    .section .text.reset, "ax", @progbits
    .globl _start

/*
 * E1X repair-programming boot reset vector.
 *
 * Entered in M-mode at the link base. Park secondary harts, establish a stack
 * on hart 0, and call main(), which reads the repair-ROM fuse window and
 * programs the mesh route tables through the repair MMIO programmer. main()
 * does not return; on completion or fail-closed reject it parks in wfi.
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
