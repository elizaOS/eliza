OUTPUT_ARCH(riscv)
ENTRY(_start)

MEMORY
{
  /* Legacy reset-only scaffold image. The current RTL contract ROM has a
     64 KiB aperture and is checked through fw/boot-rom/check_boot_rom.py. */
  rom (rx) : ORIGIN = 0x00000000, LENGTH = 4K
}

SECTIONS
{
  . = ORIGIN(rom);
  .text : ALIGN(4) {
    KEEP(*(.text.reset))
    *(.text*)
  } > rom

  .rodata : ALIGN(8) {
    *(.rodata*)
  } > rom

  . = ALIGN(16);
  __bootrom_stack_top = ORIGIN(rom) + LENGTH(rom);

  /DISCARD/ : {
    *(.comment*)
    *(.note*)
    *(.riscv.attributes*)
  }
}

ASSERT(SIZEOF(.text) + SIZEOF(.rodata) <= LENGTH(rom), "legacy reset-only ROM exceeds 4 KiB")
