ENTRY(_start)
PHDRS { text PT_LOAD FLAGS(5); data PT_LOAD FLAGS(6); }
SECTIONS {
  . = 1M;
  .multiboot ALIGN(8) : { KEEP(*(.multiboot)) } :text
  .text ALIGN(4096) : { *(.text.boot) *(.text .text.*) } :text
  .rodata ALIGN(4096) : { *(.rodata .rodata.*) } :text
  .data ALIGN(4096) : { *(.data .data.*) } :data
  .bss ALIGN(4096) : { *(COMMON) *(.bss .bss.*) } :data
  . = ALIGN(4096);
  kernel_end = .;
  /DISCARD/ : { *(.eh_frame*) *(.comment) *(.note*) }
}
