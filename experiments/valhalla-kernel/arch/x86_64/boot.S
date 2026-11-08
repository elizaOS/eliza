.section .multiboot,"a"
.balign 8
header:
.long 0xe85250d6
.long 0
.long header_end-header
.long -(0xe85250d6+(header_end-header))
.short 0,0
.long 8
header_end:
.section .text.boot,"ax"
.code32
.global _start
.type _start,@function
_start:
    cli
    cld
    mov $boot_stack_top,%esp
    mov %eax,boot_magic
    mov %ebx,boot_info
    mov $pml4,%eax
    mov $pdpt,%edx
    or $3,%edx
    mov %edx,(%eax)
    mov $pdpt,%eax
    mov $pd,%edx
    or $3,%edx
    mov %edx,(%eax)
    xor %ecx,%ecx
1:
    mov %ecx,%eax
    shl $21,%eax
    or $0x83,%eax
    mov %eax,pd(,%ecx,8)
    inc %ecx
    cmp $512,%ecx
    jne 1b
    mov %cr4,%eax
    or $0x20,%eax
    mov %eax,%cr4
    mov $pml4,%eax
    mov %eax,%cr3
    mov $0xc0000080,%ecx
    rdmsr
    or $0x100,%eax
    wrmsr
    mov %cr0,%eax
    or $0x80010000,%eax
    mov %eax,%cr0
    lgdt gdt_pointer
    ljmp $8,$long_entry
.code64
long_entry:
    mov $16,%ax
    mov %ax,%ds
    mov %ax,%es
    mov %ax,%ss
    xor %eax,%eax
    mov %ax,%fs
    mov %ax,%gs
    mov $boot_stack_top,%rsp
    xor %rbp,%rbp
    mov boot_magic(%rip),%edi
    mov boot_info(%rip),%esi
    call kernel_main
2:  cli
    hlt
    jmp 2b
.balign 8
gdt:
    .quad 0
    .quad 0x00af9a000000ffff
    .quad 0x00cf92000000ffff
gdt_pointer:
    .word 23
    .long gdt
.section .bss,"aw",@nobits
.balign 4096
pml4: .skip 4096
pdpt: .skip 4096
pd: .skip 4096
.balign 16
boot_stack: .skip 65536
boot_stack_top:
boot_magic: .skip 4
boot_info: .skip 4
.section .note.GNU-stack,"",@progbits
