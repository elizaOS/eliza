// Keep this shim's compatibility handler during Bun's pre-exec signal reset.
// The kernel still applies the inherited seccomp policy. Successful exec resets
// caught handlers normally; the next runtime installs its own shim at startup.
#include <dlfcn.h>

static int (*libc_sigaction)(int, const struct sigaction *, struct sigaction *);
static int (*libc_sigprocmask)(int, const sigset_t *, sigset_t *);
static void resolve_sigaction(void) {
  libc_sigprocmask = dlsym(RTLD_NEXT, "sigprocmask");
  libc_sigaction = dlsym(RTLD_NEXT, "sigaction");
}

int sigaction(int sig, const struct sigaction *action, struct sigaction *old) {
  // Constructor order may expose this symbol before our constructor. Resolve
  // locally then; the cached pointer is set only during single-threaded startup.
  int (*real_action)(int, const struct sigaction *, struct sigaction *) = libc_sigaction;
  if (!real_action) real_action = dlsym(RTLD_NEXT, "sigaction");
  if (!real_action) { errno = ENOSYS; return -1; }
  if (sig == SIGSYS && action && action->sa_handler == SIG_DFL) {
    struct sigaction current;
    if (real_action(sig, NULL, &current) != 0) return -1;
    // Preserve only our own handler, never another consumer's disposition.
    if ((current.sa_flags & SA_SIGINFO) && current.sa_sigaction == handle_sigsys) {
      if (old) *old = current;
      return 0;
    }
  }
  return real_action(sig, action, old);
}

// Bun blocks signals before vfork, then uses legacy syscalls while preparing
// the child's descriptors. A blocked synchronous SIGSYS kills that child even
// when our disposition is preserved above. Keep only our translation signal
// available; the inherited kernel seccomp policy still handles every syscall.
int sigprocmask(int how, const sigset_t *set, sigset_t *old) {
  int (*real_mask)(int, const sigset_t *, sigset_t *) = libc_sigprocmask;
  if (!real_mask) real_mask = dlsym(RTLD_NEXT, "sigprocmask");
  if (!real_mask) { errno = ENOSYS; return -1; }
  if (set && (how == SIG_BLOCK || how == SIG_SETMASK) && libc_sigaction) {
    struct sigaction current;
    if (libc_sigaction(SIGSYS, NULL, &current) == 0 &&
        (current.sa_flags & SA_SIGINFO) && current.sa_sigaction == handle_sigsys) {
      // Copy first: callers may use the same object for set and old.
      sigset_t compatible = *set;
      sigdelset(&compatible, SIGSYS);
      return real_mask(how, &compatible, old);
    }
  }
  return real_mask(how, set, old);
}
