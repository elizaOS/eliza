/*
 * e1-cva6-dram-boot — bare-metal RV64 M-mode CPU-execution proof.
 *
 * This program is the executable substrate proof for booting the E1 SoC:
 * a real CVA6 RV64 core fetches and executes these instructions from the
 * real AXI4 DRAM controller through the real on-chip fabric.  It is NOT a
 * Linux boot — it is the minimal program that proves the CPU↔DRAM↔CLINT
 * datapath is alive and correct end to end.
 *
 * It links and runs at the DRAM base 0x8000_0000 (CVA6's cv64a6 executable
 * + cached PMA region; see core/include/cv64a6_imafdc_sv39_config_pkg.sv
 * ExecuteRegionAddrBase[0]=0x8000_0000, length 0x4000_0000).
 *
 * What it proves, in order:
 *   1. Instruction fetch from real DRAM:  the core fetches this code from
 *      0x8000_0000 through the fabric and the DRAM controller.
 *   2. DRAM data writes:  it stores a deterministic marker pattern to a
 *      scratch region in DRAM and reads it back.
 *   3. CLINT timer trap:  it programs CLINT mtimecmp (@0x0200_4000), enables
 *      mie.MTIE + mstatus.MIE, and waits; the real CLINT raises mtip; the
 *      core takes the machine timer trap into mtvec; the handler records
 *      mepc/mcause to DRAM and disarms the timer.
 *   4. Boot-OK marker:  after the trap returns it writes the ASCII marker
 *      "E1BOOT-OK\0" to DRAM, then spins in a WFI loop.
 *
 * The cocotb harness reads the DRAM markers + the trap record back through
 * the DRAM controller to assert the program provably executed.
 *
 * DRAM marker map (byte offsets from DRAM base 0x8000_0000):
 *   0x0000_2000  MARK_ALIVE     64-bit  0x1122_3344_5566_7788  (store proof)
 *   0x0000_2008  MARK_ECHO      64-bit  read-back of MARK_ALIVE (load proof)
 *   0x0000_2010  MARK_TRAP_HIT  64-bit  0x0000_0000_0000_0001  set in handler
 *   0x0000_2018  MARK_MCAUSE    64-bit  mcause latched in the trap
 *   0x0000_2020  MARK_MEPC      64-bit  mepc latched in the trap
 *   0x0000_2030  MARK_BOOT_OK   80-bit  ASCII "E1BOOT-OK\0"
 */

    .equ DRAM_BASE,     0x80000000
    .equ CLINT_BASE,    0x02000000
    .equ CLINT_MTIMECMP,0x02004000
    .equ CLINT_MTIME,   0x0200BFF8

    .equ MARK_BASE,     0x80002000   /* DRAM_BASE + 0x2000 */

    /* mstatus.MIE = bit 3; mie.MTIE = bit 7 */
    .equ MSTATUS_MIE,   0x00000008
    .equ MIE_MTIE,      0x00000080

    .section .text.boot, "ax", @progbits
    .globl _start
    .option norvc            /* keep the reset path 4-byte aligned, no RVC */

_start:
    /* ---- 1. minimal M-mode machine state -------------------------------- */
    csrw    mie, zero            /* mask all interrupts while we set up */
    csrw    mip, zero
    la      t0, trap_vector
    csrw    mtvec, t0            /* direct-mode trap vector */

    /* stack near the top of the 16 KiB scratch DRAM window the sim backs */
    li      sp, DRAM_BASE
    li      t0, 0x3FF0           /* 16 KiB - 16, stack just under marker tail */
    add     sp, sp, t0

    /* ---- 2. DRAM store/load proof --------------------------------------- */
    li      t1, MARK_BASE
    /* MARK_ALIVE = 0x1122334455667788 */
    li      t2, 0x11223344
    slli    t2, t2, 32
    li      t3, 0x55667788
    or      t2, t2, t3
    sd      t2, 0(t1)            /* DRAM[MARK_BASE+0x00] = MARK_ALIVE */
    ld      t4, 0(t1)            /* read it back */
    sd      t4, 8(t1)            /* DRAM[MARK_BASE+0x08] = echo */

    /* clear the trap-record words so a stale value can never pass */
    sd      zero, 16(t1)         /* MARK_TRAP_HIT */
    sd      zero, 24(t1)         /* MARK_MCAUSE  */
    sd      zero, 32(t1)         /* MARK_MEPC    */

    /* ---- 3. arm the CLINT timer ----------------------------------------- */
    /* The CLINT is a 32-bit AXI-Lite slave; all CLINT accesses are 4-byte
       word accesses (lw/sw), per the riscv,clint0 binding (64-bit registers
       are two 32-bit words: lo @ +0, hi @ +4).  mtimecmp = mtime + delta so
       the timer fires promptly.  mtime is large but monotonically rising;
       to keep mtimecmp ahead even across the lo/hi read race we read mtime,
       add a generous delta to the low word, and write hi first then lo. */
    li      t0, CLINT_MTIME
    lw      t2, 0(t0)            /* mtime[31:0]  */
    lw      t3, 4(t0)            /* mtime[63:32] */
    li      t4, 4096             /* delta cycles (comfortably > setup latency) */
    add     t2, t2, t4           /* low += delta (may carry; widen below) */
    /* program mtimecmp: write hi (max-safe) is unnecessary since mtime[63:32]
       is ~0 early in the run; set hi = current hi, lo = low+delta. */
    li      t0, CLINT_MTIMECMP
    sw      t3, 4(t0)            /* mtimecmp[63:32] = mtime hi */
    sw      t2, 0(t0)            /* mtimecmp[31:0]  = mtime lo + delta */

    /* enable machine timer interrupt + global interrupt enable */
    li      t0, MIE_MTIE
    csrw    mie, t0
    li      t0, MSTATUS_MIE
    csrs    mstatus, t0

    /* ---- 4. wait for the timer trap ------------------------------------- */
    li      t5, MARK_BASE
wait_trap:
    ld      t6, 16(t5)           /* poll MARK_TRAP_HIT (set by handler) */
    beqz    t6, wait_trap

    /* ---- 5. boot-OK marker ---------------------------------------------- */
    /* write ASCII "E1BOOT-OK\0" (10 bytes) as two 64-bit stores.
       Increasing byte addresses hold:
         b0 'E'=0x45 b1 '1'=0x31 b2 'B'=0x42 b3 'O'=0x4F
         b4 'O'=0x4F b5 'T'=0x54 b6 '-'=0x2D b7 'O'=0x4F
       Little-endian 64-bit word = 0x4F2D_544F_4F42_3145
       (high32 = 0x4F2D544F, low32 = 0x4F423145). */
    li      t1, MARK_BASE
    li      t2, 0x4F2D544F
    slli    t2, t2, 32
    li      t3, 0x4F423145
    or      t2, t2, t3
    sd      t2, 48(t1)           /* MARK_BOOT_OK[0..7] = "E1BOOT-O" */
    /* bytes 8..9: 'K'=0x4B, '\0'=0x00, rest 0 */
    li      t2, 0x0000004B       /* "K\0" */
    sd      t2, 56(t1)           /* MARK_BOOT_OK[8..15] = "K\0..." */

    /* ---- 6. spin ---------------------------------------------------------*/
spin:
    wfi
    j       spin

    /* ---- trap vector ----------------------------------------------------- */
    .align 4
trap_vector:
    /* record the trap to DRAM so the harness can see it was taken */
    li      a0, MARK_BASE
    li      a1, 1
    sd      a1, 16(a0)           /* MARK_TRAP_HIT = 1 */
    csrr    a2, mcause
    sd      a2, 24(a0)           /* MARK_MCAUSE */
    csrr    a3, mepc
    sd      a3, 32(a0)           /* MARK_MEPC */

    /* disarm the timer: mtimecmp = all-ones so mtip drops (two 32-bit stores) */
    li      t0, CLINT_MTIMECMP
    li      t1, -1
    sw      t1, 0(t0)            /* mtimecmp[31:0]  = 0xFFFFFFFF */
    sw      t1, 4(t0)            /* mtimecmp[63:32] = 0xFFFFFFFF */
    /* clear MTIE so we do not re-enter */
    li      t0, MIE_MTIE
    csrc    mie, t0

    mret
