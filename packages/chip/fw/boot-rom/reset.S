    .option norvc
    .section .text.reset, "ax", @progbits
    .globl _start
    .globl e1_bootrom_trap
    .globl e1_bootrom_handoff

/*
 * Minimal RV64 reset ROM scaffold.
 *
 * This only establishes an executable reset vector and jumps to the configured
 * next-stage address. It does not authenticate payloads, initialize DRAM,
 * provide SBI services, or prove an OpenSBI/Linux handoff.
 */
_start:
    la      t0, e1_bootrom_trap
    csrw    mtvec, t0
    csrci   mstatus, 0x8
    la      sp, __bootrom_stack_top

    ld      t1, e1_bootrom_handoff
    beqz    t1, e1_bootrom_trap
    jr      t1

e1_bootrom_trap:
    wfi
    j       e1_bootrom_trap

    .section .rodata.handoff, "a", @progbits
    .balign 8
e1_bootrom_handoff:
    .dword  0x0000000080000000
