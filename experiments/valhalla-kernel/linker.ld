ENTRY(_start)
PHDRS { text PT_LOAD FLAGS(5); rodata PT_LOAD FLAGS(4); data PT_LOAD FLAGS(6); }
SECTIONS {
  . = 1M;
  _kernel_start = .;
  .multiboot ALIGN(8) : { KEEP(*(.multiboot)) } :text
  .text ALIGN(4K) : { *(.text.boot) *(.text .text.*) } :text
  .rodata ALIGN(4K) : { *(.rodata .rodata.*) } :rodata
  .data ALIGN(4K) : { *(.data .data.*) } :data
  .bss ALIGN(4K) (NOLOAD) : { *(COMMON) *(.bss .bss.*) } :data
  . = ALIGN(4K);
  _kernel_end = .;
  ASSERT(_kernel_end < 0x40000000, "kernel must fit inside boot identity map")
  /DISCARD/ : { *(.comment) *(.eh_frame*) *(.note*) }
}
