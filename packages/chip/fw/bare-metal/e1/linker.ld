OUTPUT_ARCH(riscv)
ENTRY(_start)

/*
 * QEMU virt -kernel loads ELF segments at their physical addresses and
 * jumps to the entry point in M-mode. We link at 0x80000000 (DRAM base).
 */
MEMORY
{
  ram (rwx) : ORIGIN = 0x80000000, LENGTH = 16M
}

SECTIONS
{
  . = ORIGIN(ram);

  .text : ALIGN(4) {
    KEEP(*(.text.reset))
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
