/* -----------------------------------------------------------------------------
 * Eliza E1 PMC firmware startup (RV32IMC, ilp32).
 *
 * Provides the reset vector and _start symbol referenced by link.ld /
 * link.sim.ld. On reset the Ibex core jumps to boot_addr_i + 0x80
 * (lowRISC ibex_top reset entry). The .vectors section places a single
 * jal-to-_start at offset 0x80; the remaining vector slots fall back to
 * a halt loop so an unexpected trap is observable instead of silently
 * looping back through the reset path.
 *
 * _start:
 *   1. Zero the integer GPR file (defensive: simple_system already zeros
 *      registers but real AON resets only guarantee a subset).
 *   2. Initialise gp from __global_pointer$ (linker-supplied; relax-safe).
 *   3. Set sp to __stack_top from the linker script.
 *   4. Clear .bss between __bss_start__ and __bss_end__.
 *   5. Call pmc_main().
 *   6. If pmc_main ever returns, halt with wfi in a tight loop.
 * ---------------------------------------------------------------------------*/

    .section .vectors, "ax"
    .option norvc
    .org 0x00
    /* Exception / interrupt vector table. 32 4-byte slots; we route every
     * vector to _halt_loop except slot 32 (reset) which jumps to _start. */
    .rept 32
    jal x0, _halt_loop
    .endr
    .org 0x80
    jal x0, _start

    .section .text._start, "ax"
    .global _start
    .global _halt_loop
    .type   _start, @function
    .type   _halt_loop, @function

_start:
    /* Zero GPRs. x0 is hardwired; clear x1..x31. */
    mv  x1, x0
    mv  x2, x0
    mv  x3, x0
    mv  x4, x0
    mv  x5, x0
    mv  x6, x0
    mv  x7, x0
    mv  x8, x0
    mv  x9, x0
    mv  x10, x0
    mv  x11, x0
    mv  x12, x0
    mv  x13, x0
    mv  x14, x0
    mv  x15, x0
    mv  x16, x0
    mv  x17, x0
    mv  x18, x0
    mv  x19, x0
    mv  x20, x0
    mv  x21, x0
    mv  x22, x0
    mv  x23, x0
    mv  x24, x0
    mv  x25, x0
    mv  x26, x0
    mv  x27, x0
    mv  x28, x0
    mv  x29, x0
    mv  x30, x0
    mv  x31, x0

    /* gp init must run with linker relaxation disabled or gp itself would
     * be loaded relative to its own (uninitialised) value. */
.option push
.option norelax
    la  gp, __global_pointer$
.option pop

    /* Stack pointer from linker script. */
    la  sp, __stack_top

    /* Clear BSS [__bss_start__, __bss_end__). */
    la  t0, __bss_start__
    la  t1, __bss_end__
    bgeu t0, t1, _bss_done
_bss_loop:
    sw  x0, 0(t0)
    addi t0, t0, 4
    bltu t0, t1, _bss_loop
_bss_done:

    /* Enter C. pmc_main has signature void(void). */
    call pmc_main

    /* If pmc_main returns, fall through to halt loop. */
_halt_loop:
    wfi
    j   _halt_loop

    .size _start, . - _start
    .size _halt_loop, . - _halt_loop

/* -----------------------------------------------------------------------------
 * Freestanding memcpy / memset / memmove.
 *
 * The PMC firmware uses memcpy in the RPMI frame parser/serializer and in the
 * DVFS arbiter. With -nostdlib the toolchain cannot pull these from newlib,
 * so we provide a small byte-loop implementation here. GCC may also emit
 * calls to these symbols for struct copies, so they must be globally visible.
 * ---------------------------------------------------------------------------*/
    .section .text.memcpy, "ax"
    .global memcpy
    .type   memcpy, @function
memcpy:
    /* a0 = dest, a1 = src, a2 = n. Returns dest. */
    mv      t0, a0
    beqz    a2, _memcpy_done
_memcpy_loop:
    lbu     t1, 0(a1)
    sb      t1, 0(t0)
    addi    a1, a1, 1
    addi    t0, t0, 1
    addi    a2, a2, -1
    bnez    a2, _memcpy_loop
_memcpy_done:
    ret
    .size memcpy, . - memcpy

    .section .text.memset, "ax"
    .global memset
    .type   memset, @function
memset:
    /* a0 = dest, a1 = byte value, a2 = n. Returns dest. */
    mv      t0, a0
    beqz    a2, _memset_done
_memset_loop:
    sb      a1, 0(t0)
    addi    t0, t0, 1
    addi    a2, a2, -1
    bnez    a2, _memset_loop
_memset_done:
    ret
    .size memset, . - memset

    .section .text.memmove, "ax"
    .global memmove
    .type   memmove, @function
memmove:
    /* a0 = dest, a1 = src, a2 = n. Forward copy if dest <= src, else reverse. */
    mv      t0, a0
    beqz    a2, _memmove_done
    bgeu    a1, a0, _memmove_fwd
    /* dest > src: copy backwards to avoid overlap clobber. */
    add     t0, t0, a2
    add     a1, a1, a2
_memmove_rev:
    addi    t0, t0, -1
    addi    a1, a1, -1
    lbu     t1, 0(a1)
    sb      t1, 0(t0)
    addi    a2, a2, -1
    bnez    a2, _memmove_rev
    j       _memmove_done
_memmove_fwd:
    lbu     t1, 0(a1)
    sb      t1, 0(t0)
    addi    a1, a1, 1
    addi    t0, t0, 1
    addi    a2, a2, -1
    bnez    a2, _memmove_fwd
_memmove_done:
    ret
    .size memmove, . - memmove
