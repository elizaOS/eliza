/*
 * Linker script for the full secure mask ROM (reset.S + the OPNPHN01 verifier,
 * Ed25519 + SHA-256, measurement chain, and freestanding mem primitives).
 *
 * The reset-only scaffold uses ../linker.ld with a 4 KiB aperture; the secure
 * ROM with crypto needs a larger window. 64 KiB matches an OpenTitan-class mask
 * ROM and leaves headroom; the ASSERT fails the build if the image outgrows it.
 */
OUTPUT_ARCH(riscv)
ENTRY(_start)

MEMORY
{
  rom (rx)  : ORIGIN = 0x00000000, LENGTH = 64K
  ram (rwx) : ORIGIN = 0x00010000, LENGTH = 16K
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
    *(.srodata*)
  } > rom

  .data : ALIGN(8) {
    *(.data*)
    *(.sdata*)
  } > ram

  .bss (NOLOAD) : ALIGN(8) {
    *(.bss*)
    *(.sbss*)
    *(COMMON)
  } > ram

  . = ALIGN(16);
  __bootrom_stack_top = ORIGIN(ram) + LENGTH(ram);

  /DISCARD/ : {
    *(.comment*)
    *(.note*)
    *(.riscv.attributes*)
  }
}

ASSERT(SIZEOF(.text) + SIZEOF(.rodata) <= LENGTH(rom),
       "secure boot ROM exceeds 64 KiB")
