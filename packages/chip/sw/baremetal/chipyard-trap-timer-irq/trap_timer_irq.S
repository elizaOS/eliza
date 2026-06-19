/*
 * Bare-metal generated Chipyard AP trap/timer/IRQ evidence payload.
 *
 * This runs on the generated ElizaRocketConfig simulator. It prints through
 * the generated SiFive UART, exercises M-mode trap CSRs, CLINT timer/software
 * interrupts, a PLIC claim/complete path sourced by the generated UART, and an
 * S-mode trap return.
 */

    .option norvc

    .equ UART0,        0x10001000
    .equ UART_TXDATA,  0x00
    .equ UART_TXCTRL,  0x08
    .equ UART_IE,      0x10

    .equ CLINT,        0x02000000
    .equ CLINT_MSIP,   0x0000
    .equ CLINT_MTIMECMP, 0x4000
    .equ CLINT_MTIME,  0xbff8

    .equ PLIC,         0x0c000000
    .equ PLIC_PRIORITY, 0x0000
    .equ PLIC_ENABLE_M, 0x2000
    .equ PLIC_THRESHOLD_M, 0x200000
    .equ PLIC_CLAIM_M, 0x200004

    .equ ERROR_DEVICE, 0x00003000

    .equ MSTATUS_MIE,  0x00000008
    .equ MSTATUS_MPP_MASK, 0x00001800
    .equ MSTATUS_MPP_S, 0x00000800
    .equ MSTATUS_MPP_M, 0x00001800
    .equ SSTATUS_SPP, 0x00000100
    .equ MIE_MSIE,     0x00000008
    .equ MIE_MTIE,     0x00000080
    .equ MIE_MEIE,     0x00000800
    .equ MEDELEG_ECALL_S, 0x00000200

    .section .text.init, "ax"
    .globl _start
_start:
    la sp, stack_top
    la t0, m_trap_entry
    csrw mtvec, t0
    la t0, s_trap_entry
    csrw stvec, t0
    li t0, -1
    csrw pmpaddr0, t0
    li t0, 0x1f
    csrw pmpcfg0, t0

    li t0, 1
    li t1, UART0 + UART_TXCTRL
    sw t0, 0(t1)
    li t1, UART0 + UART_IE
    sw zero, 0(t1)
    csrw mie, zero
    li t0, CLINT + CLINT_MSIP
    sw zero, 0(t0)
    li t0, CLINT + CLINT_MTIMECMP
    li t1, -1
    sd t1, 0(t0)

    la a0, banner
    jal printstr
    la a0, dts_node
    jal printstr

    jal exercise_timer_interrupt
    jal exercise_software_interrupt
    jal exercise_external_interrupt
    jal exercise_sret
after_s_return:
    jal exercise_access_fault

after_s_mode:
    la a0, pass_msg
    jal printstr
    li t0, 1
    la t1, tohost
    sd t0, 0(t1)
1:
    wfi
    j 1b

exercise_access_fault:
    addi sp, sp, -16
    sd ra, 0(sp)
    la a0, access_probe
    jal printstr
    li t0, 0xdff
    csrw pmpaddr0, t0
    li t0, -1
    csrw pmpaddr1, t0
    li t0, 0x9f98
    csrw pmpcfg0, t0
    li t0, ERROR_DEVICE
    ld t1, 0(t0)
after_access_fault:
    la a0, after_access
    jal printstr
    ld ra, 0(sp)
    addi sp, sp, 16
    ret

exercise_timer_interrupt:
    addi sp, sp, -16
    sd ra, 0(sp)
    la a0, timer_setup
    jal printstr
    csrw mie, zero
    li t0, CLINT + CLINT_MSIP
    sw zero, 0(t0)
    li t0, CLINT + CLINT_MTIME
    ld s3, 0(t0)
    la a0, mtime_label
    jal printstr
    mv a0, s3
    jal printhex64nl
    addi s4, s3, 2
    li t0, CLINT + CLINT_MTIMECMP
    sd s4, 0(t0)
    la a0, mtimecmp_label
    jal printstr
    mv a0, s4
    jal printhex64nl
    la t0, 2f
    csrw mscratch, t0
    li t0, MIE_MTIE
    csrs mie, t0
    li t0, MSTATUS_MIE
    csrs mstatus, t0
1:
    j 1b
2:
    li t0, MIE_MTIE
    csrc mie, t0
    ld ra, 0(sp)
    addi sp, sp, 16
    ret

exercise_software_interrupt:
    addi sp, sp, -16
    sd ra, 0(sp)
    la a0, sw_setup
    jal printstr
    csrw mie, zero
    li t0, CLINT + CLINT_MSIP
    li t1, 1
    sw t1, 0(t0)
    la a0, msip_label
    jal printstr
    li t0, CLINT + CLINT_MSIP
    lw a0, 0(t0)
    jal printhex64nl
    la t0, 2f
    csrw mscratch, t0
    li t0, MIE_MSIE
    csrs mie, t0
    li t0, MSTATUS_MIE
    csrs mstatus, t0
1:
    j 1b
2:
    li t0, MIE_MSIE
    csrc mie, t0
    ld ra, 0(sp)
    addi sp, sp, 16
    ret

exercise_external_interrupt:
    addi sp, sp, -16
    sd ra, 0(sp)
    la a0, plic_setup
    jal printstr
    csrw mie, zero
    li t0, PLIC + PLIC_PRIORITY + 12
    li t1, 1
    sw t1, 0(t0)
    li t0, PLIC + PLIC_ENABLE_M
    li t1, 8
    sw t1, 0(t0)
    li t0, PLIC + PLIC_THRESHOLD_M
    sw zero, 0(t0)
    li t0, UART0 + UART_TXCTRL
    li t1, 0x00010001
    sw t1, 0(t0)
    li t0, UART0 + UART_IE
    li t1, 1
    sw t1, 0(t0)
    la t0, 2f
    csrw mscratch, t0
    li t0, MIE_MEIE
    csrs mie, t0
    li t0, MSTATUS_MIE
    csrs mstatus, t0
1:
    j 1b
2:
    li t0, MIE_MEIE
    csrc mie, t0
    li t0, UART0 + UART_IE
    sw zero, 0(t0)
    ld ra, 0(sp)
    addi sp, sp, 16
    ret

exercise_sret:
    la a0, sret_setup
    jal printstr
    li t0, MEDELEG_ECALL_S
    csrs medeleg, t0
    la t0, s_mode_entry
    csrw mepc, t0
    csrr t1, mstatus
    li t2, ~MSTATUS_MPP_MASK
    and t1, t1, t2
    li t2, MSTATUS_MPP_S
    or t1, t1, t2
    csrw mstatus, t1
    la a0, mret_to_s
    jal printstr
    mret

s_mode_entry:
    la a0, sret_msg
    jal printstr
    la t0, after_sret_payload
    csrw sepc, t0
    li t0, SSTATUS_SPP
    csrs sstatus, t0
    sret
after_sret_payload:
    la a0, sret_returned
    jal printstr
    li t0, 1
    csrw sscratch, t0
    .word 0
1:
    j 1b

    .align 2
m_trap_entry:
    addi sp, sp, -192
    sd ra,   0(sp)
    sd t0,   8(sp)
    sd t1,  16(sp)
    sd t2,  24(sp)
    sd t3,  32(sp)
    sd t4,  40(sp)
    sd t5,  48(sp)
    sd t6,  56(sp)
    sd a0,  64(sp)
    sd a1,  72(sp)
    sd a2,  80(sp)
    sd s0,  88(sp)
    sd s1,  96(sp)
    sd s2, 104(sp)

    csrr s0, mcause
    csrr s1, mepc
    csrr s2, mtval

    la a0, mcause_label
    jal printstr
    mv a0, s0
    jal printhex64nl
    la a0, mepc_label
    jal printstr
    mv a0, s1
    jal printhex64nl
    la a0, mtval_label
    jal printstr
    mv a0, s2
    jal printhex64nl

    srli t0, s0, 63
    bnez t0, m_interrupt

    li t0, 5
    beq s0, t0, m_access_fault
    li t0, 7
    beq s0, t0, m_access_fault
    li t0, 2
    beq s0, t0, m_illegal
    j m_unexpected_sync

m_access_fault:
    la a0, access_fault_msg
    jal printstr
    addi s1, s1, 4
    j m_trap_return

m_illegal:
    csrr t1, sscratch
    beqz t1, m_unexpected_sync
    la a0, s_to_m_msg
    jal printstr
    la s1, after_s_return
    csrr t0, mstatus
    li t1, ~MSTATUS_MPP_MASK
    and t0, t0, t1
    li t1, MSTATUS_MPP_M
    or t0, t0, t1
    csrw mstatus, t0
    j m_trap_return

m_unexpected_sync:
    la a0, unexpected_sync
    jal printstr
    addi s1, s1, 4
    j m_trap_return

m_interrupt:
    slli t0, s0, 1
    srli t0, t0, 1
    li t1, 7
    beq t0, t1, m_timer_irq
    li t1, 3
    beq t0, t1, m_software_irq
    li t1, 11
    beq t0, t1, m_external_irq
    la a0, unexpected_irq
    jal printstr
    j m_trap_return

m_timer_irq:
    la a0, timer_irq_msg
    jal printstr
    li t0, CLINT + CLINT_MTIMECMP
    li t1, -1
    sd t1, 0(t0)
    csrr s1, mscratch
    j m_trap_return

m_software_irq:
    la a0, sw_irq_msg
    jal printstr
    li t0, CLINT + CLINT_MSIP
    sw zero, 0(t0)
    csrr s1, mscratch
    j m_trap_return

m_external_irq:
    la a0, plic_irq_msg
    jal printstr
    li t0, PLIC + PLIC_CLAIM_M
    lw t1, 0(t0)
    sd t1, 112(sp)
    la a0, claim_label
    jal printstr
    ld a0, 112(sp)
    jal printhex64nl
    li t2, UART0 + UART_IE
    sw zero, 0(t2)
    li t0, PLIC + PLIC_CLAIM_M
    ld t1, 112(sp)
    sw t1, 0(t0)
    csrr s1, mscratch
    j m_trap_return

m_trap_return:
    csrw mepc, s1
    la a0, mret_msg
    jal printstr
    ld ra,   0(sp)
    ld t0,   8(sp)
    ld t1,  16(sp)
    ld t2,  24(sp)
    ld t3,  32(sp)
    ld t4,  40(sp)
    ld t5,  48(sp)
    ld t6,  56(sp)
    ld a0,  64(sp)
    ld a1,  72(sp)
    ld a2,  80(sp)
    ld s0,  88(sp)
    ld s1,  96(sp)
    ld s2, 104(sp)
    addi sp, sp, 192
    mret

    .align 2
s_trap_entry:
    addi sp, sp, -96
    sd ra,  0(sp)
    sd t0,  8(sp)
    sd t1, 16(sp)
    sd a0, 24(sp)
    csrr t0, scause
    csrr t1, sepc
    la a0, s_trap_msg
    jal printstr
    la a0, scause_label
    jal printstr
    mv a0, t0
    jal printhex64nl
    addi t1, t1, 4
    csrw sepc, t1
    la a0, sret_msg
    jal printstr
    ld ra,  0(sp)
    ld t0,  8(sp)
    ld t1, 16(sp)
    ld a0, 24(sp)
    addi sp, sp, 96
    sret

printstr:
    addi sp, sp, -24
    sd ra, 0(sp)
    sd a0, 8(sp)
    sd s0, 16(sp)
    mv s0, a0
1:
    lbu t0, 0(s0)
    beqz t0, 2f
    addi s0, s0, 1
    j 1b
2:
    ld a0, 8(sp)
    sub a1, s0, a0
    jal write_buf
    ld ra, 0(sp)
    ld s0, 16(sp)
    addi sp, sp, 24
    ret

putc:
    addi sp, sp, -24
    sd ra, 0(sp)
    sb a0, 16(sp)
    addi a0, sp, 16
    li a1, 1
    jal write_buf
    ld ra, 0(sp)
    addi sp, sp, 24
    ret

write_buf:
    addi sp, sp, -64
    li t0, 64
    sd t0, 0(sp)
    li t0, 1
    sd t0, 8(sp)
    sd a0, 16(sp)
    sd a1, 24(sp)
    fence
    la t0, tohost
    sd sp, 0(t0)
1:
    la t1, fromhost
    ld t2, 0(t1)
    beqz t2, 1b
    sd zero, 0(t1)
    fence
    addi sp, sp, 64
    ret

printhex64nl:
    addi sp, sp, -64
    sd ra, 0(sp)
    sd s0, 8(sp)
    sd s1, 16(sp)
    sd s2, 24(sp)
    mv s0, a0
    addi s2, sp, 32
    li t0, '0'
    sb t0, 0(s2)
    li t0, 'x'
    sb t0, 1(s2)
    li s1, 60
    addi t3, s2, 2
1:
    srl t1, s0, s1
    andi t1, t1, 0xf
    li t0, 10
    bltu t1, t0, 2f
    addi t1, t1, 87
    j 3f
2:
    addi t1, t1, 48
3:
    sb t1, 0(t3)
    addi t3, t3, 1
    addi s1, s1, -4
    bgez s1, 1b
    li t0, '\n'
    sb t0, 0(t3)
    mv a0, s2
    li a1, 19
    jal write_buf
    ld ra, 0(sp)
    ld s0, 8(sp)
    ld s1, 16(sp)
    ld s2, 24(sp)
    addi sp, sp, 64
    ret

    .section .rodata, "a"
banner:
    .asciz "eliza trap_timer_irq generated Chipyard AP transcript\n"
dts_node:
    .asciz "interrupt-controller node: /soc/interrupt-controller@c000000 compatible=riscv,plic0 PLIC\n"
access_probe:
    .asciz "probing generated error-device for access-fault\n"
after_access:
    .asciz "returned after access-fault handler\n"
timer_setup:
    .asciz "programming CLINT mtime and mtimecmp for timer interrupt\n"
mtime_label:
    .asciz "mtime="
mtimecmp_label:
    .asciz "mtimecmp="
sw_setup:
    .asciz "programming CLINT msip for software interrupt\n"
msip_label:
    .asciz "msip="
plic_setup:
    .asciz "programming PLIC source 3 from generated UART for external interrupt\n"
sret_setup:
    .asciz "entering S-mode to exercise sret\n"
mret_to_s:
    .asciz "mret enter S-mode\n"
pass_msg:
    .asciz "trap_timer_irq PASS\n"
mcause_label:
    .asciz "mcause="
mepc_label:
    .asciz "mepc="
mtval_label:
    .asciz "mtval="
access_fault_msg:
    .asciz "access-fault handled by generated AP trap path\n"
timer_irq_msg:
    .asciz "timer interrupt observed via CLINT MTIP\n"
sw_irq_msg:
    .asciz "software interrupt observed via CLINT MSIP\n"
plic_irq_msg:
    .asciz "PLIC external interrupt observed\n"
claim_label:
    .asciz "external interrupt claim/complete source="
s_trap_msg:
    .asciz "S-mode trap delegated and handled\n"
scause_label:
    .asciz "scause="
sret_msg:
    .asciz "executing sret from S-mode payload\n"
sret_returned:
    .asciz "sret returned to S-mode payload\n"
s_to_m_msg:
    .asciz "returned from S-mode payload to M-mode trap handler\n"
mret_msg:
    .asciz "mret return from M-mode trap handler\n"
unexpected_sync:
    .asciz "unexpected synchronous trap\n"
unexpected_irq:
    .asciz "unexpected interrupt\n"

    .section .bss, "aw", @nobits
    .align 3
stack:
    .skip 8192
stack_top:

    .section ".tohost","aw",@progbits
    .align 6
    .globl tohost
tohost:
    .dword 0
    .align 6
    .globl fromhost
fromhost:
    .dword 0
