/* -----------------------------------------------------------------------------
 * Eliza E1 PMC firmware linker script
 *
 * Targets the AON SRAM aperture seen by the Ibex management core. The aperture
 * is sized for the boot ROM + retention SRAM bank declared in
 * rtl/power/pmc_top.sv (the actual SRAM macro is instantiated at integration
 * in rtl/top/; this script defines the firmware-side contract).
 *
 *   AON_SRAM : 0x1005_0000 .. 0x1005_3FFF (16 KiB)
 *
 * The mailbox MMIO window lives at 0x1001_0000 (PMC_REG_BASE in
 * fw/pmc/include/pmc.h) and is accessed by the firmware via volatile pointers;
 * it is NOT a loadable region for this script.
 *
 * Entry point: _start (provided by fw/pmc/src/crt0.S). _start clears BSS,
 * loads the stack pointer to __stack_top, then jumps to pmc_main().
 * ---------------------------------------------------------------------------*/

OUTPUT_ARCH(riscv)
OUTPUT_FORMAT("elf32-littleriscv", "elf32-littleriscv", "elf32-littleriscv")
ENTRY(_start)

MEMORY
{
    AON_SRAM (rwx) : ORIGIN = 0x10050000, LENGTH = 16K
}

/* Stack reservation. Firmware is single-thread; 2 KiB is sufficient for the
 * RPMI dispatcher + SPMI bit-bang call depth. */
__stack_size = 0x800;

SECTIONS
{
    .text : ALIGN(4)
    {
        __text_start__ = .;
        KEEP(*(.vectors))
        KEEP(*(.vectors.*))
        *(.text._start)
        *(.text)
        *(.text.*)
        . = ALIGN(4);
        __text_end__ = .;
    } > AON_SRAM

    .rodata : ALIGN(4)
    {
        __rodata_start__ = .;
        *(.srodata)
        *(.srodata.*)
        *(.rodata)
        *(.rodata.*)
        . = ALIGN(4);
        __rodata_end__ = .;
    } > AON_SRAM

    .data : ALIGN(4)
    {
        __data_start__ = .;
        /* gp anchors the 4 KiB small-data window straddling .sdata/.sbss for
         * RISC-V GP relaxation. Placed at the start of .sdata. */
        PROVIDE(__global_pointer$ = . + 0x800);
        *(.sdata)
        *(.sdata.*)
        *(.data)
        *(.data.*)
        . = ALIGN(4);
        __data_end__ = .;
    } > AON_SRAM

    .bss (NOLOAD) : ALIGN(4)
    {
        __bss_start__ = .;
        *(.sbss)
        *(.sbss.*)
        *(.bss)
        *(.bss.*)
        *(COMMON)
        . = ALIGN(4);
        __bss_end__ = .;
    } > AON_SRAM

    .stack (NOLOAD) : ALIGN(16)
    {
        __stack_bottom = .;
        . = . + __stack_size;
        . = ALIGN(16);
        __stack_top = .;
    } > AON_SRAM

    /* Heap is intentionally zero-sized: PMC firmware performs no dynamic
     * allocation. If a future revision needs heap, place it between .bss
     * and .stack and provide _sbrk in crt0.S. */
    .heap (NOLOAD) : ALIGN(4)
    {
        __heap_start__ = .;
        __heap_end__   = .;
    } > AON_SRAM

    /DISCARD/ :
    {
        *(.comment)
        *(.note)
        *(.note.*)
        *(.eh_frame)
        *(.eh_frame.*)
        *(.riscv.attributes)
    }
}

ASSERT(__stack_top <= ORIGIN(AON_SRAM) + LENGTH(AON_SRAM),
       "PMC firmware overflows AON_SRAM budget")
