.text
.global context_switch
.type context_switch,@function
context_switch:
    push %rbp
    push %rbx
    push %r12
    push %r13
    push %r14
    push %r15
    mov %rsp,(%rdi)
    mov %rsi,%rsp
    pop %r15
    pop %r14
    pop %r13
    pop %r12
    pop %rbx
    pop %rbp
    ret
.size context_switch,.-context_switch
.section .note.GNU-stack,"",@progbits
