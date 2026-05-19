OUTPUT_ARCH(riscv)
ENTRY(_start)

/*
 * OpenSBI generic on QEMU virt drops to S-mode at 0x80200000 by default
 * (FW_TEXT_START 0x80000000 + 2 MiB jump). Link the payload there.
 */
MEMORY
{
  ram (rwx) : ORIGIN = 0x80200000, LENGTH = 16M
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
