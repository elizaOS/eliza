OUTPUT_ARCH(riscv)
ENTRY(_start)

/*
 * E1X repair-programming boot image. Linked into the tile-local boot SRAM at
 * the reset base; the route-table programming runs entirely from this image
 * before any larger payload is fetched.
 */
MEMORY
{
  ram (rwx) : ORIGIN = 0x80000000, LENGTH = 64K
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
