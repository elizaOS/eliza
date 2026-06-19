OUTPUT_ARCH(riscv)
ENTRY(_start)

/*
 * The boot shim links and runs at SHIM_ADDR (0x8008_0000), above the OpenSBI
 * image; CVA6's cv64a6 executable+cached PMA region spans 0x8000_0000.. so this
 * address is fetchable.  The shim is a handful of instructions that set a0/a1
 * and jump down to OpenSBI's _fw_start at the aligned base 0x8000_0000.
 */
SECTIONS
{
  . = 0x80080000;

  .text : ALIGN(4) {
    KEEP(*(.text.shim))
    *(.text*)
  }

  /DISCARD/ : {
    *(.comment*)
    *(.note*)
    *(.riscv.attributes*)
    *(.eh_frame*)
    *(.data*)
    *(.bss*)
  }
}
