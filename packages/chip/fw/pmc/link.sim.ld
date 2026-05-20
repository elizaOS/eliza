/* -----------------------------------------------------------------------------
 * Eliza E1 PMC firmware linker script — simple_system smoke variant.
 *
 * Identical to link.ld except the memory map is shifted to match the
 * lowRISC ibex_simple_system Verilator harness (1 MiB RAM at 0x0010_0000,
 * vectors at 0x0010_0000, reset vector at 0x0010_0080). This is used solely
 * to verify the linker output retires its first instructions under the
 * pinned Ibex core; production AON SRAM placement is in link.ld.
 *
 * NOTE: The PMC firmware in this configuration cannot actually exercise the
 * mailbox MMIO at 0x1001_0000 because simple_system does not model that
 * peripheral. The smoke harness only validates that _start and pmc_main
 * fetch and retire from the linked image.
 * ---------------------------------------------------------------------------*/

OUTPUT_ARCH(riscv)
OUTPUT_FORMAT("elf32-littleriscv", "elf32-littleriscv", "elf32-littleriscv")
ENTRY(_start)

MEMORY
{
    ram (rwx) : ORIGIN = 0x00100000, LENGTH = 0x00100000
}

__stack_size = 0x800;

SECTIONS
{
    /* simple_system reset vector is at base + 0x80; place .vectors at base. */
    .vectors 0x00100000 : ALIGN(4)
    {
        KEEP(*(.vectors))
        KEEP(*(.vectors.*))
    } > ram

    .text : ALIGN(4)
    {
        __text_start__ = .;
        *(.text._start)
        *(.text)
        *(.text.*)
        . = ALIGN(4);
        __text_end__ = .;
    } > ram

    .rodata : ALIGN(4)
    {
        __rodata_start__ = .;
        *(.srodata)
        *(.srodata.*)
        *(.rodata)
        *(.rodata.*)
        . = ALIGN(4);
        __rodata_end__ = .;
    } > ram

    .data : ALIGN(4)
    {
        __data_start__ = .;
        PROVIDE(__global_pointer$ = . + 0x800);
        *(.sdata)
        *(.sdata.*)
        *(.data)
        *(.data.*)
        . = ALIGN(4);
        __data_end__ = .;
    } > ram

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
    } > ram

    .stack (NOLOAD) : ALIGN(16)
    {
        __stack_bottom = .;
        . = . + __stack_size;
        . = ALIGN(16);
        __stack_top = .;
    } > ram

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
