// SIGSYS-handler shim for Android riscv64 app seccomp filters.
//
// Android's `untrusted_app` seccomp filter on riscv64 (from bionic's
// `riscv64_app_policy.cpp`, mirroring the arm64 policy shape) traps any
// syscall outside the app allowlist with SECCOMP_RET_TRAP, raising
// SIGSYS in the offending thread. bun 1.3.13 issues `epoll_pwait2`
// (syscall 441, Linux 5.11+) on every event-loop tick from
// `packages/bun-usockets/src/eventing/epoll_kqueue.c` — gated only by a
// runtime kernel-version probe, no env-var/CLI escape. On a kernel
// >= 5.11 (every shipping Android-on-riscv64 device target) the call
// goes out raw and the app filter traps it. Bun's `errno == ENOSYS`
// fallback to `epoll_pwait` is unreachable: SIGSYS fires *before* the
// syscall would have returned.
//
// This handler intercepts SIGSYS, decodes the trapped syscall from
// `siginfo_t.si_syscall`, re-issues the safe equivalent via raw
// `ecall`, and writes the result back into the saved A0 slot of
// `ucontext_t.uc_mcontext.__gregs[REG_A0]` so the trapped thread
// resumes immediately after the offending `ecall` instruction with the
// right return value in place.
//
// ── Coverage (riscv64) ────────────────────────────────────────────────
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
// riscv64 — like arm64 — uses the generic Linux syscall ABI
// (`<asm-generic/unistd.h>`) and therefore does NOT have the legacy
// non-AT syscalls (access/open/stat/poll/dup2/pipe/eventfd/signalfd/
// epoll_create/inotify_init) that the x86_64 shim covers — musl's
// riscv64 wrappers go straight to the AT/p-form equivalents, and the
// kernel's riscv64 ABI omits those numbers entirely.
//
// If a future bun version adds another riscv64-blocked syscall, add a
// case here and the upstream fix is to extend bionic's riscv64 app
// policy allowlist.
//
// ── ucontext register layout ──────────────────────────────────────────
//
// musl's `<bits/signal.h>` for riscv64 declares:
//
//   typedef unsigned long __riscv_mc_gp_state[32];
//   typedef struct mcontext_t {
//     __riscv_mc_gp_state __gregs;
//     union __riscv_mc_fp_state __fpregs;
//   } mcontext_t;
//
//   #define REG_PC 0    // pc
//   #define REG_RA 1    // ra (x1)
//   #define REG_SP 2    // sp (x2)
//   #define REG_TP 4    // tp (x4)
//   #define REG_S0 8    // s0/fp (x8)
//   #define REG_S1 9    // s1 (x9)
//   #define REG_A0 10   // a0..a7 = __gregs[10..17] (x10..x17)
//   #define REG_S2 18   // s2..s11 = __gregs[18..27]
//
// Linux riscv64 syscall ABI: syscall number in a7 (__gregs[17]), args
// in a0..a5 (__gregs[10..15]), return value in a0 (__gregs[10]).
// `siginfo_t.si_syscall` already gives us the trapped syscall number
// so we don't read a7 directly. Bionic's riscv64 mcontext layout
// matches: bionic's `<sys/ucontext.h>` for riscv64 wraps the kernel's
// `struct sigcontext` (defined in `<asm/sigcontext.h>` with `__gregs`
// as `__riscv_mc_gp_state`), so the same offsets apply when the shim
// is loaded under bionic's `linker64` instead of musl's loader-wrap.
//
// ── Production-landing checklist ─────────────────────────────────────
//
//   1. zig cross-compile produces non-empty libsigsys-handler.so for
//      riscv64 (see compile-shim.mjs).
//   2. After APK build: `unzip -l <apk> | grep libsigsys-handler` lists
//      the .so under jniLibs/riscv64/ (legacy-packaging on).
//   3. On a riscv64 cuttlefish or device boot: `adb logcat -s ElizaAgent`
//      shows `Agent process started` but NO `exited early code=159` —
//      `/api/health 31337` becomes reachable in <15s.
//
// Compile: zig cc -target riscv64-linux-musl -shared -fPIC -O2 \
//                 -o libsigsys-handler.so sigsys-handler-riscv64.c
// Loaded via LD_PRELOAD before the bun runtime (see loader-wrap.c).

#if !defined(__riscv) || __riscv_xlen != 64
#error "sigsys-handler-riscv64.c is riscv64-only; arm64 lives in sigsys-handler-arm64.c and x86_64 in sigsys-handler.c."
#endif

#define _GNU_SOURCE
#include <signal.h>
#include <ucontext.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>
#include <time.h>
#include <sys/syscall.h>

// riscv64 Linux syscall numbers (generic syscall ABI). Stable per
// `<asm-generic/unistd.h>`; we redefine in case the host headers are
// out of date relative to the device kernel.
#ifndef SYS_epoll_pwait2
#define SYS_epoll_pwait2 441
#endif
#ifndef SYS_epoll_pwait
#define SYS_epoll_pwait 22
#endif
#ifndef SYS_write
#define SYS_write 64
#endif

// musl's riscv64 mcontext_t uses `__gregs[32]`. REG_A0 = 10 (a0..a7 at
// __gregs[10..17]). If headers ever omit the macro (e.g. building
// against a stripped libc), fall back to the ABI-defined index.
#ifndef REG_A0
#define REG_A0 10
#endif

// Raw kernel syscall — bypasses libc's errno wrapper so the handler sees
// the kernel ABI return value (negative errno on failure). riscv64 ABI:
// syscall number in a7, args in a0..a5, return in a0. Use a named asm
// operand for a7 so GCC/clang allocate it for us instead of demanding
// the inline-asm reservation that named register declarations would
// impose on the whole function.
static inline long raw_syscall6(long n, long a, long b, long c, long d, long e, long f) {
  register long a0 __asm__("a0") = a;
  register long a1 __asm__("a1") = b;
  register long a2 __asm__("a2") = c;
  register long a3 __asm__("a3") = d;
  register long a4 __asm__("a4") = e;
  register long a5 __asm__("a5") = f;
  register long a7 __asm__("a7") = n;
  __asm__ volatile (
    "ecall"
    : "+r"(a0)
    : "r"(a1), "r"(a2), "r"(a3), "r"(a4), "r"(a5), "r"(a7)
    : "memory"
  );
  return a0;
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
  // mcontext_t.__gregs[0..31] maps the integer register file:
  //   __gregs[0]  = pc
  //   __gregs[1]  = ra (x1)
  //   __gregs[2]  = sp (x2)
  //   __gregs[10..17] = a0..a7 (x10..x17)
  // riscv64 syscalls take up to 6 args in a0..a5; the syscall number
  // lives in a7 but is also exposed via siginfo_t.si_syscall for
  // SECCOMP_RET_TRAP traps.
  unsigned long *r = ctx->uc_mcontext.__gregs;
  long a0 = (long)r[REG_A0 + 0];
  long a1 = (long)r[REG_A0 + 1];
  long a2 = (long)r[REG_A0 + 2];
  long a3 = (long)r[REG_A0 + 3];
  long a4 = (long)r[REG_A0 + 4];
  long a5 = (long)r[REG_A0 + 5];
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

  r[REG_A0] = (unsigned long)ret;
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
    static const char msg[] = "sigsys-handler-riscv64: sigaction(SIGSYS) failed\n";
    raw_syscall6(SYS_write, 2, (long)msg, sizeof(msg) - 1, 0, 0, 0);
  } else {
    static const char msg[] = "sigsys-handler-riscv64: installed\n";
    raw_syscall6(SYS_write, 2, (long)msg, sizeof(msg) - 1, 0, 0, 0);
  }
}
