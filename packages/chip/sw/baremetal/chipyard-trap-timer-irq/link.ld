OUTPUT_ARCH("riscv")
ENTRY(_start)

SECTIONS
{
  . = 0x80000000;
  .text.init : { *(.text.init) }
  .text : { *(.text*) }
  .rodata : { *(.rodata*) }
  .data ALIGN(0x40) : { *(.data*) }
  .bss ALIGN(0x40) : {
    *(.bss*)
    *(COMMON)
  }
  .tohost ALIGN(0x1000) : { *(.tohost) }
  _end = .;
}
