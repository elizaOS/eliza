OUTPUT_ARCH(riscv)
ENTRY(_start)

/*
 * The E1 SoC releases CVA6 with boot_addr = DRAM base (0x8000_0000), which is
 * CVA6's cv64a6 executable + cached PMA region.  All code/data is linked into
 * the low 16 KiB of DRAM that the cocotb harness backs and reads back; the
 * marker scratch region begins at 0x8000_2000 and is written at runtime, so
 * the program image itself stays below it.
 */
MEMORY
{
  ram (rwx) : ORIGIN = 0x80000000, LENGTH = 8K
}

SECTIONS
{
  . = ORIGIN(ram);

  .text : ALIGN(4) {
    KEEP(*(.text.boot))
    *(.text*)
  } > ram

  .rodata : ALIGN(8) {
    *(.rodata*)
    *(.srodata*)
  } > ram

  .data : ALIGN(8) {
    *(.data*)
    *(.sdata*)
  } > ram

  .bss : ALIGN(8) {
    __bss_start = .;
    *(.bss*)
    *(.sbss*)
    *(COMMON)
    __bss_end = .;
  } > ram

  /DISCARD/ : {
    *(.comment*)
    *(.note*)
    *(.riscv.attributes*)
    *(.eh_frame*)
  }
}
