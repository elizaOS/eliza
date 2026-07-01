OUTPUT_ARCH(riscv)
ENTRY(_start)

/*
 * OpenSBI generic on QEMU virt drops to S-mode at 0x80200000 by default
 * (FW_TEXT_START 0x80000000 + 2 MiB jump). Link the payload there unless the
 * caller overrides the origin with --defsym PAYLOAD_LINK_ADDR=... The CVA6
 * Verilator boot uses a compact link address so the whole boot image (shim +
 * OpenSBI + DTB + this payload) fits inside the DRAM-controller preload
 * window (a dense beat array).
 */
SECTIONS
{
  PROVIDE(PAYLOAD_LINK_ADDR = 0x80200000);
  . = PAYLOAD_LINK_ADDR;

  .text : ALIGN(4) {
    KEEP(*(.text.reset))
    *(.text*)
  }

  .rodata : ALIGN(8) {
    *(.rodata*)
    *(.srodata*)
  }

  .data : ALIGN(8) {
    *(.data*)
    *(.sdata*)
  }

  .bss : ALIGN(8) {
    __bss_start = .;
    *(.bss*)
    *(.sbss*)
    *(COMMON)
    __bss_end = .;
  }

  /DISCARD/ : {
    *(.comment*)
    *(.note*)
    *(.riscv.attributes*)
    *(.eh_frame*)
  }
}
