/*
 * Minimal freestanding PID-1 init for the E1 CVA6 Linux boot proof.
 *
 * It is statically linked with -nostdlib and issues raw RISC-V Linux syscalls
 * (no libc), so the initramfs stays a few KiB.  The kernel's `Run /init`
 * decompresses + executes this as PID 1.  To prove a LIVE userland on the real
 * e1 SoC (not just that /init started), it:
 *
 *   1. mounts proc on /proc,
 *   2. issues uname(2) and prints the kernel release + machine (a syscall that
 *      can only return live data from the booted kernel),
 *   3. reads /proc/cpuinfo and echoes it (the kernel's live view of the CVA6),
 *   4. prints the greppable userland marker the gate asserts,
 *
 * then spins.  Every line is written to stdout, which the kernel wires to
 * ttyS0 via the bootargs, so it lands on the ns16550a UART transcript.
 */

#define SYS_write   64
#define SYS_openat  56
#define SYS_read    63
#define SYS_close   57
#define SYS_mount   40
#define SYS_uname   160
#define SYS_exit    93

#define AT_FDCWD (-100)

static long _syscall(long n, long a0, long a1, long a2, long a3, long a4)
{
    register long _a7 __asm__("a7") = n;
    register long _a0 __asm__("a0") = a0;
    register long _a1 __asm__("a1") = a1;
    register long _a2 __asm__("a2") = a2;
    register long _a3 __asm__("a3") = a3;
    register long _a4 __asm__("a4") = a4;
    __asm__ volatile("ecall"
                     : "+r"(_a0)
                     : "r"(_a7), "r"(_a1), "r"(_a2), "r"(_a3), "r"(_a4)
                     : "memory");
    return _a0;
}

static long sys_write(long fd, const char *buf, long len)
{
    return _syscall(SYS_write, fd, (long)buf, len, 0, 0);
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

/* struct utsname: 6 fixed 65-byte fields (release is the 3rd, machine the 5th). */
struct utsname {
    char sysname[65];
    char nodename[65];
    char release[65];
    char version[65];
    char machine[65];
    char domainname[65];
};

void _start(void)
{
    struct utsname u;
    char buf[1024];
    long fd, n;

    /* Mount proc so /proc/cpuinfo is the kernel's live CVA6 view. */
    _syscall(SYS_mount, (long)"proc", (long)"/proc", (long)"proc", 0, 0);

    /* uname(2): live kernel identity — proves real syscalls into the booted
     * kernel, not a static print. */
    if (_syscall(SYS_uname, (long)&u, 0, 0, 0, 0) == 0) {
        puts_console("uname: ");
        puts_console(u.sysname);
        puts_console(" release ");
        puts_console(u.release);
        puts_console(" machine ");
        puts_console(u.machine);
        puts_console("\n");
    }

    /* /proc/cpuinfo: the kernel's enumeration of the CVA6 hart. */
    fd = _syscall(SYS_openat, AT_FDCWD, (long)"/proc/cpuinfo", 0 /*O_RDONLY*/, 0, 0);
    if (fd >= 0) {
        puts_console("--- /proc/cpuinfo ---\n");
        while ((n = _syscall(SYS_read, fd, (long)buf, sizeof(buf), 0, 0)) > 0)
            sys_write(1, buf, n);
        _syscall(SYS_close, fd, 0, 0, 0, 0);
        puts_console("--- end /proc/cpuinfo ---\n");
    }

    /* Distinct, greppable userland marker: its appearance proves PID-1 ran. */
    puts_console("ELIZA-USERLAND-OK: init reached userland on E1 CVA6\n");
    for (;;) {
        /* Idle forever; the boot proof is complete once the marker prints. */
        __asm__ volatile("wfi");
    }
}
