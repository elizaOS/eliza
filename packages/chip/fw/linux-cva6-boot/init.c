/*
 * Minimal freestanding PID-1 init for the E1 CVA6 Linux boot proof.
 *
 * It is statically linked with -nostdlib and issues raw RISC-V Linux syscalls
 * (no libc), so the initramfs stays a few KiB.  The kernel's `Run /init`
 * decompresses + executes this as PID 1; it writes the userland marker to the
 * console (stdout, which the kernel wires to ttyS0 via the bootargs) and then
 * spins, which is the executable proof that the boot reached userland.
 *
 * The marker is the greppable token the gate asserts.
 */

#define SYS_write 64
#define SYS_exit  93

static long sys_write(long fd, const char *buf, long len)
{
    register long a7 __asm__("a7") = SYS_write;
    register long a0 __asm__("a0") = fd;
    register long a1 __asm__("a1") = (long)buf;
    register long a2 __asm__("a2") = len;
    __asm__ volatile("ecall" : "+r"(a0) : "r"(a7), "r"(a1), "r"(a2) : "memory");
    return a0;
}

static long slen(const char *s)
{
    long n = 0;
    while (s[n]) n++;
    return n;
}

static void puts_console(const char *s)
{
    sys_write(1, s, slen(s));
}

void _start(void)
{
    /* Distinct, greppable userland marker: its appearance proves PID-1 ran. */
    puts_console("ELIZA-USERLAND-OK: init reached userland on E1 CVA6\n");
    for (;;) {
        /* Idle forever; the boot proof is complete once the marker prints. */
        __asm__ volatile("wfi");
    }
}
