.section .multiboot,"a"
.balign 8
header:
.long 0xe85250d6
.long 0
.long header_end-header
.long -(0xe85250d6 + (header_end-header))
.short 0,0
.long 8
header_end:
.section .text.boot,"ax"
.code32
.global _start
_start:
    cli
    cld
    movl %eax, boot_magic
    movl %ebx, boot_info
    movl $boot_stack_top, %esp
    movl $boot_pdpt, %eax
    orl $3, %eax
    movl %eax, boot_pml4
    movl $boot_pd, %eax
    orl $3, %eax
    movl %eax, boot_pdpt
    xorl %ecx, %ecx
1:
    movl %ecx, %eax
    shll $21, %eax
    orl $0x83, %eax
    movl %eax, boot_pd(,%ecx,8)
    incl %ecx
    cmpl $512, %ecx
    jne 1b
    movl %cr4, %eax
    orl $0x20, %eax
    movl %eax, %cr4
    movl $boot_pml4, %eax
    movl %eax, %cr3
    movl $0xc0000080, %ecx
    rdmsr
    orl $0x100, %eax
    wrmsr
    movl %cr0, %eax
    orl $0x80010001, %eax
    movl %eax, %cr0
    lgdt gdt_pointer
    ljmp $0x08, $long_entry
.code64
long_entry:
    movw $0x10, %ax
    movw %ax, %ds
    movw %ax, %es
    movw %ax, %ss
    xorw %ax, %ax
    movw %ax, %fs
    movw %ax, %gs
    leaq boot_stack_top(%rip), %rsp
    xorq %rbp, %rbp
    movl boot_magic(%rip), %edi
    movl boot_info(%rip), %esi
    call kernel_main
2:  cli
    hlt
    jmp 2b
.section .rodata
.balign 8
gdt:
.quad 0, 0x00af9a000000ffff, 0x00cf92000000ffff
gdt_end:
gdt_pointer:
.word gdt_end-gdt-1
.long gdt
.section .bss
.balign 4
boot_magic: .skip 4
boot_info: .skip 4
.balign 4096
boot_pml4: .skip 4096
boot_pdpt: .skip 4096
boot_pd: .skip 4096
.balign 16
boot_stack: .skip 32768
boot_stack_top:
.section .note.GNU-stack,"",@progbits
