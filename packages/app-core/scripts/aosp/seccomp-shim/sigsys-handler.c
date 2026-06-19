// SIGSYS-handler shim for Android x86_64 app seccomp filters.
//
// Android's app seccomp policy on x86_64 disallows several legacy
// syscalls (notably the variants that pre-date their AT-suffixed or
// signal-mask-extended forms) but allows their newer equivalents. Bun
// is built against musl libc whose userland syscall wrappers and zig
// inline asm both invoke the legacy forms directly. SECCOMP_RET_TRAP
// makes those land as SIGSYS in the offending thread; this handler
// translates the trapped syscall to the AT-/p-form and writes the
// kernel ABI return value back into ucontext->rax so the program
// resumes immediately after the syscall instruction.
//
// ── Coverage (24 legacy syscalls) ─────────────────────────────────────
//
// path-syscall → AT_FDCWD-prefixed form:
//   access     (21) → faccessat
//   open       (2)  → openat
//   stat       (4)  → newfstatat
//   lstat      (6)  → newfstatat | AT_SYMLINK_NOFOLLOW
//   readlink   (89) → readlinkat
//   unlink     (87) → unlinkat
//   rmdir      (84) → unlinkat | AT_REMOVEDIR
//   mkdir      (83) → mkdirat
//   rename     (82) → renameat
//   chmod      (90) → fchmodat
//   chown      (92) → fchownat
//   lchown     (94) → fchownat | AT_SYMLINK_NOFOLLOW
//   symlink    (88) → symlinkat
//   link       (86) → linkat
//
// poll-family → ppoll/pselect6/epoll_pwait:
//   poll       (7)   → ppoll
//   select     (23)  → pselect6
//   epoll_wait (232) → epoll_pwait
//
// handle-creation → newer flag-extended variants:
//   dup2          (33)  → dup3
//   pipe          (22)  → pipe2
//   pause         (34)  → ppoll(NULL, 0, NULL)
//   inotify_init  (253) → inotify_init1
//   eventfd       (284) → eventfd2
//   signalfd      (282) → signalfd4
//   epoll_create  (213) → epoll_create1
//
// ── Architecture coverage ─────────────────────────────────────────────
//
// x86_64 ONLY. ARM64's kernel ABI omits every legacy non-AT syscall in
// the table above (verified: __NR_access / __NR_open / __NR_poll /
// __NR_dup2 / __NR_pipe are all undefined under aarch64-linux-musl);
// musl's aarch64 syscall wrappers go straight to the AT-suffixed forms.
// The Android seccomp filter on arm64 therefore does not (and cannot)
// trap on legacy syscalls — they're literally not in the kernel.
//
// The handler uses `ucontext_t.uc_mcontext.gregs[REG_RAX]` and inline
// `syscall` asm with x86_64-specific register clobbers; compiling for
// arm64 would either fail or silently produce a non-functional handler.
// scripts/aosp/compile-shim.mjs only builds this for x86_64.
//
// ── Production-landing checklist ──────────────────────────────────────
//
// Before each build that ships this shim:
//   1. Verify zig cross-compile produces a non-empty libsigsys-handler.so
//      (compile-shim.test.ts asserts the build invocation shape).
//   2. Confirm the loader-wrap.c sibling lands at ld-musl-x86_64.so.1
//      and the original Alpine loader is renamed to .so.1.real.
//   3. After APK build, `unzip -l <apk> | grep libsigsys-handler` should
//      list the .so under assets/agent/x86_64/.
//   4. Smoke run on cuttlefish: `dmesg | grep SIGSYS` should be empty
//      for the bun pid; the agent should reach `server.listen` callback.
//
// Compile: zig cc -target x86_64-linux-musl -shared -fPIC -O2 \
//                 -o libsigsys-handler.so sigsys-handler.c
// Loaded via LD_PRELOAD before the bun runtime.

#if !defined(__x86_64__)
#error "sigsys-handler.c is x86_64-only; arm64 has no legacy non-AT syscalls. See header comment."
#endif

#define _GNU_SOURCE
#include <signal.h>
#include <ucontext.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/syscall.h>
#include <errno.h>
#include <string.h>
#include <stdio.h>

// Legacy syscalls blocked on Android x86_64 app domain. The numbers are
// stable on Linux x86_64 ABI; we redefine in case the host headers differ.
#ifndef SYS_access
#define SYS_access 21
#endif
#ifndef SYS_open
#define SYS_open 2
#endif
#ifndef SYS_stat
#define SYS_stat 4
#endif
#ifndef SYS_lstat
#define SYS_lstat 6
#endif
#ifndef SYS_readlink
#define SYS_readlink 89
#endif
#ifndef SYS_unlink
#define SYS_unlink 87
#endif
#ifndef SYS_rmdir
#define SYS_rmdir 84
#endif
#ifndef SYS_mkdir
#define SYS_mkdir 83
#endif
#ifndef SYS_rename
#define SYS_rename 82
#endif
#ifndef SYS_chmod
#define SYS_chmod 90
#endif
#ifndef SYS_chown
#define SYS_chown 92
#endif
#ifndef SYS_lchown
#define SYS_lchown 94
#endif
#ifndef SYS_symlink
#define SYS_symlink 88
#endif
#ifndef SYS_link
#define SYS_link 86
#endif
#ifndef SYS_poll
#define SYS_poll 7
#endif
#ifndef SYS_select
#define SYS_select 23
#endif
#ifndef SYS_epoll_wait
#define SYS_epoll_wait 232
#endif
#ifndef SYS_dup2
#define SYS_dup2 33
#endif
#ifndef SYS_pipe
#define SYS_pipe 22
#endif
#ifndef SYS_pause
#define SYS_pause 34
#endif
#ifndef SYS_inotify_init
#define SYS_inotify_init 253
#endif
#ifndef SYS_eventfd
#define SYS_eventfd 284
#endif
#ifndef SYS_signalfd
#define SYS_signalfd 282
#endif
#ifndef SYS_epoll_create
#define SYS_epoll_create 213
#endif

#ifndef AT_FDCWD
#define AT_FDCWD -100
#endif
#ifndef AT_SYMLINK_NOFOLLOW
#define AT_SYMLINK_NOFOLLOW 0x100
#endif
#ifndef AT_REMOVEDIR
#define AT_REMOVEDIR 0x200
#endif

// Raw kernel syscall — bypasses libc's errno-translating wrapper so the
// caller sees the kernel ABI return value (negative errno on failure).
static inline long raw_syscall6(long n, long a, long b, long c, long d, long e, long f) {
  long ret;
  register long r10 __asm__("r10") = d;
  register long r8  __asm__("r8")  = e;
  register long r9  __asm__("r9")  = f;
  __asm__ volatile (
    "syscall"
    : "=a"(ret)
    : "0"(n), "D"(a), "S"(b), "d"(c), "r"(r10), "r"(r8), "r"(r9)
    : "rcx", "r11", "memory"
  );
  return ret;
}

static void handle_sigsys(int sig, siginfo_t *info, void *ctx_v) {
  (void)sig;
  ucontext_t *ctx = (ucontext_t*)ctx_v;
  greg_t *r = ctx->uc_mcontext.gregs;
  long rdi = r[REG_RDI];
  long rsi = r[REG_RSI];
  long rdx = r[REG_RDX];
  long r10 = r[REG_R10];
  long r8  = r[REG_R8];
  long r9  = r[REG_R9];
  long ret;
  int sysno = info->si_syscall;
  (void)r9;

  switch (sysno) {
    // ── path-prefixed → AT_FDCWD-prefixed ─────────────────────────────
    case SYS_access:
      ret = raw_syscall6(SYS_faccessat, AT_FDCWD, rdi, rsi, 0, 0, 0);
      break;
    case SYS_open:
      ret = raw_syscall6(SYS_openat, AT_FDCWD, rdi, rsi, rdx, 0, 0);
      break;
    case SYS_stat:
      ret = raw_syscall6(SYS_newfstatat, AT_FDCWD, rdi, rsi, 0, 0, 0);
      break;
    case SYS_lstat:
      ret = raw_syscall6(SYS_newfstatat, AT_FDCWD, rdi, rsi, AT_SYMLINK_NOFOLLOW, 0, 0);
      break;
    case SYS_readlink:
      ret = raw_syscall6(SYS_readlinkat, AT_FDCWD, rdi, rsi, rdx, 0, 0);
      break;
    case SYS_unlink:
      ret = raw_syscall6(SYS_unlinkat, AT_FDCWD, rdi, 0, 0, 0, 0);
      break;
    case SYS_rmdir:
      ret = raw_syscall6(SYS_unlinkat, AT_FDCWD, rdi, AT_REMOVEDIR, 0, 0, 0);
      break;
    case SYS_mkdir:
      ret = raw_syscall6(SYS_mkdirat, AT_FDCWD, rdi, rsi, 0, 0, 0);
      break;
    case SYS_rename:
      ret = raw_syscall6(SYS_renameat, AT_FDCWD, rdi, AT_FDCWD, rsi, 0, 0);
      break;
    case SYS_chmod:
      ret = raw_syscall6(SYS_fchmodat, AT_FDCWD, rdi, rsi, 0, 0, 0);
      break;
    case SYS_chown:
      ret = raw_syscall6(SYS_fchownat, AT_FDCWD, rdi, rsi, rdx, 0, 0);
      break;
    case SYS_lchown:
      ret = raw_syscall6(SYS_fchownat, AT_FDCWD, rdi, rsi, rdx, AT_SYMLINK_NOFOLLOW, 0);
      break;
    case SYS_symlink:
      ret = raw_syscall6(SYS_symlinkat, rdi, AT_FDCWD, rsi, 0, 0, 0);
      break;
    case SYS_link:
      ret = raw_syscall6(SYS_linkat, AT_FDCWD, rdi, AT_FDCWD, rsi, 0, 0);
      break;

    // ── poll-family → ppoll/pselect6/epoll_pwait ─────────────────────
    case SYS_poll: {
      // poll(fds, nfds, timeout_ms) → ppoll(fds, nfds, timespec*, NULL, 0)
      // We translate timeout_ms (rdx) to a struct timespec on stack; if
      // the value is negative ("infinite") pass NULL to mean wait forever.
      long timeout_ms = rdx;
      if (timeout_ms < 0) {
        ret = raw_syscall6(SYS_ppoll, rdi, rsi, 0, 0, 0, 0);
      } else {
        struct timespec ts;
        ts.tv_sec = timeout_ms / 1000;
        ts.tv_nsec = (timeout_ms % 1000) * 1000000L;
        ret = raw_syscall6(SYS_ppoll, rdi, rsi, (long)&ts, 0, 0, 0);
      }
      break;
    }
    case SYS_select: {
      // select(nfds, rfds, wfds, efds, timeval*) → pselect6 with timespec*
      // and NULL sigmask. Convert timeval to timespec inline.
      long tv_ptr = r8;
      long ts_arg = 0;
      struct timespec ts;
      if (tv_ptr) {
        // Read timeval { tv_sec, tv_usec }
        long *tv = (long*)tv_ptr;
        ts.tv_sec = tv[0];
        ts.tv_nsec = tv[1] * 1000L;
        ts_arg = (long)&ts;
      }
      ret = raw_syscall6(SYS_pselect6, rdi, rsi, rdx, r10, ts_arg, 0);
      break;
    }
    case SYS_epoll_wait:
      // epoll_wait(epfd, events, maxevents, timeout) → epoll_pwait(..., NULL, 0)
      ret = raw_syscall6(SYS_epoll_pwait, rdi, rsi, rdx, r10, 0, 0);
      break;

    // ── handle-creation → newer variants with flags=0 ────────────────
    case SYS_dup2:
      // dup2(old, new) → dup3(old, new, 0)
      ret = raw_syscall6(SYS_dup3, rdi, rsi, 0, 0, 0, 0);
      break;
    case SYS_pipe:
      // pipe(fds) → pipe2(fds, 0)
      ret = raw_syscall6(SYS_pipe2, rdi, 0, 0, 0, 0, 0);
      break;
    case SYS_pause:
      // pause() ≡ ppoll(NULL, 0, NULL, NULL, 0) (blocks indefinitely)
      ret = raw_syscall6(SYS_ppoll, 0, 0, 0, 0, 0, 0);
      break;
    case SYS_inotify_init:
      ret = raw_syscall6(SYS_inotify_init1, 0, 0, 0, 0, 0, 0);
      break;
    case SYS_eventfd:
      // eventfd(initval, _) → eventfd2(initval, 0)
      ret = raw_syscall6(SYS_eventfd2, rdi, 0, 0, 0, 0, 0);
      break;
    case SYS_signalfd:
      // signalfd(fd, mask, masksize) → signalfd4(fd, mask, masksize, 0)
      ret = raw_syscall6(SYS_signalfd4, rdi, rsi, rdx, 0, 0, 0);
      break;
    case SYS_epoll_create:
      // epoll_create(size) → epoll_create1(0). The size hint is ignored
      // since Linux 2.6.8 anyway.
      ret = raw_syscall6(SYS_epoll_create1, 0, 0, 0, 0, 0, 0);
      break;

    default:
      ret = -ENOSYS;
      break;
  }

  r[REG_RAX] = ret;
}

__attribute__((constructor))
static void install_sigsys_handler(void) {
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_sigaction = handle_sigsys;
  sa.sa_flags = SA_SIGINFO | SA_RESTART | SA_NODEFER;
  sigemptyset(&sa.sa_mask);
  if (sigaction(SIGSYS, &sa, NULL) != 0) {
    static const char msg[] = "sigsys-handler: sigaction(SIGSYS) failed\n";
    raw_syscall6(SYS_write, 2, (long)msg, sizeof(msg) - 1, 0, 0, 0);
  } else {
    static const char msg[] = "sigsys-handler: installed\n";
    raw_syscall6(SYS_write, 2, (long)msg, sizeof(msg) - 1, 0, 0, 0);
  }
}
