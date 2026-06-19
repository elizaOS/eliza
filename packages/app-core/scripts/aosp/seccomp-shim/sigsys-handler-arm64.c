// SIGSYS-handler shim for Android arm64 app seccomp filters.
//
// Android's `untrusted_app` seccomp filter on arm64 (from
// `bionic/libc/seccomp/arm64_app_policy.cpp`) traps any syscall outside
// the app allowlist with SECCOMP_RET_TRAP, raising SIGSYS in the
// offending thread. bun 1.3.13 issues `epoll_pwait2` (syscall 441,
// Linux 5.11+) on every event-loop tick from
// `packages/bun-usockets/src/eventing/epoll_kqueue.c` — gated only by a
// runtime kernel-version probe, no env-var/CLI escape. On a kernel
// >= 5.11 (every shipping Android 13+ device) the call goes out raw
// and the app filter traps it. Bun's `errno == ENOSYS` fallback to
// `epoll_pwait` is unreachable: SIGSYS fires *before* the syscall
// would have returned.
//
// This handler intercepts SIGSYS, decodes the trapped syscall from
// `siginfo_t.si_syscall`, re-issues the safe equivalent via raw
// `svc 0`, and writes the result back into `ucontext_t.uc_mcontext.regs[0]`
// (X0) so the trapped thread resumes immediately after the offending
// `svc 0` instruction with the right return value in place.
//
// ── Coverage (arm64) ─────────────────────────────────────────────────
//
// epoll_pwait2 (441) → epoll_pwait (22)
//
// Translation: epoll_pwait2 takes a `struct timespec *` timeout; the
// older epoll_pwait takes `int timeout_ms`. We collapse the timespec
// down to milliseconds (clamped to 32-bit) on the way in. NULL timeout
// (block forever) maps to `-1`. Round-tripping milliseconds is bun's
// own native idiom — `bun_us_loop_pump` uses the millisecond form
// throughout, so no precision is lost.
//
// arm64 does NOT have the legacy non-AT syscalls (access/open/stat/poll/
// dup2/pipe/eventfd/signalfd/epoll_create/inotify_init) that the x86_64
// shim covers — musl's aarch64 wrappers go straight to the AT/p-form
// equivalents, and the kernel's aarch64 ABI omits those numbers entirely.
// If a future bun version adds another arm64-blocked syscall, add a
// case here and bump `arm64_app_policy.cpp` is the upstream fix.
//
// ── Production-landing checklist ─────────────────────────────────────
//
//   1. zig cross-compile produces non-empty libsigsys-handler.so for
//      arm64-v8a (see compile-shim.mjs).
//   2. After APK build: `unzip -l <apk> | grep libsigsys-handler` lists
//      the .so under jniLibs/arm64-v8a/ (legacy-packaging on).
//   3. On the Moto run: `adb logcat -s ElizaAgent` shows
//      `Agent process started` but NO `exited early code=159` —
//      `/api/health 31337` becomes reachable in <15s.
//
// Compile: zig cc -target aarch64-linux-musl -shared -fPIC -O2 \
//                 -o libsigsys-handler.so sigsys-handler-arm64.c
// Loaded via LD_PRELOAD before the bun runtime (see loader-wrap-arm64.c).

#if !defined(__aarch64__)
#error "sigsys-handler-arm64.c is arm64-only; the x86_64 variant lives in sigsys-handler.c."
#endif

#define _GNU_SOURCE
#include <signal.h>
#include <ucontext.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>
#include <time.h>
#include <sys/syscall.h>

// arm64 Linux syscall numbers. Stable per the Linux aarch64 ABI; we
// redefine in case the host headers are out of date relative to the
// device kernel.
#ifndef SYS_epoll_pwait2
#define SYS_epoll_pwait2 441
#endif
#ifndef SYS_epoll_pwait
#define SYS_epoll_pwait 22
#endif
#ifndef SYS_write
#define SYS_write 64
#endif

// Raw kernel syscall — bypasses libc's errno wrapper so the handler sees
// the kernel ABI return value (negative errno on failure). aarch64 ABI:
// syscall number in x8, args in x0..x5, return in x0.
static inline long raw_syscall6(long n, long a, long b, long c, long d, long e, long f) {
  register long x0 __asm__("x0") = a;
  register long x1 __asm__("x1") = b;
  register long x2 __asm__("x2") = c;
  register long x3 __asm__("x3") = d;
  register long x4 __asm__("x4") = e;
  register long x5 __asm__("x5") = f;
  register long x8 __asm__("x8") = n;
  __asm__ volatile (
    "svc 0"
    : "+r"(x0)
    : "r"(x1), "r"(x2), "r"(x3), "r"(x4), "r"(x5), "r"(x8)
    : "memory", "cc"
  );
  return x0;
}

// Clamp a `struct timespec` timeout to int milliseconds for the older
// epoll_pwait ABI. NULL → -1 (block forever).
static int timespec_to_ms(const struct timespec *ts) {
  if (!ts) return -1;
  long long ms_ll = (long long)ts->tv_sec * 1000LL + ts->tv_nsec / 1000000L;
  if (ms_ll < 0) return -1;
  if (ms_ll > 2147483647LL) return 2147483647;
  return (int)ms_ll;
}

static void handle_sigsys(int sig, siginfo_t *info, void *ctx_v) {
  (void)sig;
  ucontext_t *ctx = (ucontext_t*)ctx_v;
  // mcontext_t.regs[0..30] are X0..X30. arm64 syscalls take up to 6 args
  // in X0..X5; the syscall number lives in X8 but is also exposed via
  // siginfo_t.si_syscall for SECCOMP_RET_TRAP traps.
  unsigned long *r = ctx->uc_mcontext.regs;
  long a0 = (long)r[0];
  long a1 = (long)r[1];
  long a2 = (long)r[2];
  long a3 = (long)r[3];
  long a4 = (long)r[4];
  long a5 = (long)r[5];
  long ret;
  int sysno = info->si_syscall;
  (void)a5;

  switch (sysno) {
    case SYS_epoll_pwait2: {
      // epoll_pwait2(epfd, events, maxevents, timeout*, sigmask, sigsetsize)
      //   → epoll_pwait(epfd, events, maxevents, timeout_ms, sigmask, sigsetsize)
      // bun's caller in epoll_kqueue.c always passes a 4-arg sigmask
      // pair (sigmask, sizeof(sigset_t)) — pass them through unchanged.
      int timeout_ms = timespec_to_ms((const struct timespec *)a3);
      ret = raw_syscall6(SYS_epoll_pwait, a0, a1, a2, (long)timeout_ms, a4, a5);
      break;
    }

    default:
      // Anything else lands as ENOSYS so the offending code sees a
      // recoverable error path instead of an unhandled SIGSYS-style
      // process death. New blocked syscalls should add a `case` above
      // rather than relying on this default.
      ret = -ENOSYS;
      break;
  }

  r[0] = (unsigned long)ret;
}

__attribute__((constructor))
static void install_sigsys_handler(void) {
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_sigaction = handle_sigsys;
  // SA_SIGINFO: enable the 3-arg handler signature (we need siginfo_t
  // for si_syscall and ucontext_t for the trapped registers).
  // SA_RESTART: irrelevant for SIGSYS — the SIGSYS is delivered in
  // place of the syscall, not interrupting one — but harmless.
  // SA_NODEFER: allow re-entry so a SIGSYS during the replacement
  // syscall (shouldn't happen, but defensive) is still handled.
  sa.sa_flags = SA_SIGINFO | SA_RESTART | SA_NODEFER;
  sigemptyset(&sa.sa_mask);
  if (sigaction(SIGSYS, &sa, NULL) != 0) {
    static const char msg[] = "sigsys-handler-arm64: sigaction(SIGSYS) failed\n";
    raw_syscall6(SYS_write, 2, (long)msg, sizeof(msg) - 1, 0, 0, 0);
  } else {
    static const char msg[] = "sigsys-handler-arm64: installed\n";
    raw_syscall6(SYS_write, 2, (long)msg, sizeof(msg) - 1, 0, 0, 0);
  }
}
