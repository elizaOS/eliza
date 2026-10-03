// Drop-in replacement for ld-musl-x86_64.so.1 that injects LD_PRELOAD
// before exec'ing the real loader. This is required because the
// privileged AOSP system app's agent service (e.g. ElizaAgentService
// in elizaOS, or any white-label fork's equivalent) spawns bun via
// ProcessBuilder with the loader as argv[0]; the BUN_FEATURE_FLAG_*
// env vars don't help for SYS_access, so we need LD_PRELOAD with our
// access->faccessat shim. But the service can't be edited without an
// APK rebuild, so this wrapper takes the loader path and injects the
// env before exec'ing the real loader.
//
// ── Critical seccomp constraint ─────────────────────────────────────
// Android's untrusted_app seccomp filter on x86_64 traps the legacy
// pre-AT syscalls (access, open, stat, lstat, readlink, …). The
// libsigsys-handler.so shim translates them at runtime, but it is only
// loaded AFTER the real musl loader runs — which means this wrapper
// itself MUST NOT call any libc routine that ends up in the trapped
// syscall set. Specifically:
//
//   - No `access(2)` / `open(2)` / `readlink(2)` etc.
//   - All path probing must use the AT-suffixed syscalls directly
//     (faccessat, readlinkat, openat).
//
// Anything else gets the wrapper killed with sig=31 / SIGSYS by the
// kernel before execve() ever runs. Calls retained below — `getenv`,
// `setenv`, `execve`, `snprintf`, `strrchr`, `strncat`, `write` —
// either touch no syscall or use AT-form fast paths in modern musl.
//
// Layout on device:
//   <wrapper-dir>/ld-musl-x86_64.so.1        — this wrapper
//   <wrapper-dir>/ld-musl-x86_64.so.1.real   — real musl loader
//   <wrapper-dir>/libsigsys-handler.so       — the syscall shim
//
// Or the JNI-lib variant of the same layout:
//   <wrapper-dir>/libeliza_ld_musl_<abi>.so       — wrapper (packaged)
//   <wrapper-dir>/libeliza_ld_musl_<abi>_real.so  — real loader sibling
//   <wrapper-dir>/libsigsys-handler.so            — shim
//
// `ELIZA_REAL_LOADER` may pin an explicit absolute path. Its presence
// short-circuits the fallback construction below; the shim still loads
// from <self_dir>/libsigsys-handler.so.
//
// Build: zig cc -target x86_64-linux-musl -O2 -static -o loader-wrap loader-wrap.c
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

extern char **environ;

// Direct readlinkat(AT_FDCWD, ...) — bypasses musl's `readlink` entry
// point so we don't hit SYS_readlink which the Android seccomp filter
// traps. Returns the byte count written (excluding NUL) or -1 on error.
static long sys_readlinkat(const char *path, char *buf, size_t buf_len) {
  return syscall(SYS_readlinkat, AT_FDCWD, path, buf, buf_len);
}

// Direct faccessat(AT_FDCWD, ..., F_OK, 0). Same reason as above —
// `access(2)` is in the trapped legacy set.
static int sys_faccessat_exists(const char *path) {
  if (!path || !path[0]) return 0;
  long r = syscall(SYS_faccessat, AT_FDCWD, path, F_OK, 0);
  return r == 0;
}

// Resolve `/proc/self/exe` so the wrapper finds its on-device path even
// when argv[0] is not the absolute pathname (ProcessBuilder + the kernel
// may both hand us a stripped argv[0] for a file with the .so.1 ABI tag).
static const char *resolve_self_path(char *buf, size_t buf_len, const char *fallback) {
  long n = sys_readlinkat("/proc/self/exe", buf, buf_len - 1);
  if (n > 0) {
    buf[n] = '\0';
    return buf;
  }
  return fallback;
}

int main(int argc, char **argv) {
  char self_buf[4096];
  const char *self = resolve_self_path(self_buf, sizeof(self_buf), argv[0]);

  // Resolve the real loader path.
  char real_loader[4096];
  const char *override_real = getenv("ELIZA_REAL_LOADER");
  if (sys_faccessat_exists(override_real)) {
    snprintf(real_loader, sizeof(real_loader), "%s", override_real);
  } else {
    // Layout 1 (extracted agent dir): <self>.real, e.g. ld-musl-x86_64.so.1.real
    snprintf(real_loader, sizeof(real_loader), "%s.real", self);
    if (!sys_faccessat_exists(real_loader)) {
      // Layout 2 (packaged JNI-lib dir): replace ".so" with "_real.so".
      // AGP's jniLibs glob only matches `*.so`, so the `.real` sibling
      // ships under the renamed extension to make the cut.
      size_t n = strlen(self);
      if (n > 3 && strcmp(self + n - 3, ".so") == 0) {
        snprintf(
          real_loader, sizeof(real_loader),
          "%.*s_real.so", (int)(n - 3), self
        );
      }
    }
  }

  // Build the SIGSYS-shim path: same dir as self, name `libsigsys-handler.so`.
  char shim[4096];
  snprintf(shim, sizeof(shim), "%s", self);
  char *slash = strrchr(shim, '/');
  if (slash) {
    *slash = '\0';
    strncat(shim, "/libsigsys-handler.so", sizeof(shim) - strlen(shim) - 1);
  } else {
    strcpy(shim, "./libsigsys-handler.so");
  }

  // Prepend our shim to LD_PRELOAD so the real loader picks it up.
  const char *existing = getenv("LD_PRELOAD");
  char preload_buf[8192];
  if (existing && existing[0]) {
    snprintf(preload_buf, sizeof(preload_buf), "%s:%s", shim, existing);
  } else {
    snprintf(preload_buf, sizeof(preload_buf), "%s", shim);
  }
  setenv("LD_PRELOAD", preload_buf, 1);

  // Replace argv[0] with the real loader path, exec it.
  argv[0] = real_loader;
  execve(real_loader, argv, environ);

  // execve only returns on failure. Dump enough context to debug from
  // service logs without invoking trapped syscalls.
  static const char banner[] = "loader-wrap: execve failed real_loader=";
  syscall(SYS_write, 2, banner, sizeof(banner) - 1);
  syscall(SYS_write, 2, real_loader, strlen(real_loader));
  static const char self_label[] = " self=";
  syscall(SYS_write, 2, self_label, sizeof(self_label) - 1);
  syscall(SYS_write, 2, self, strlen(self));
  static const char nl[] = "\n";
  syscall(SYS_write, 2, nl, 1);
  return 127;
}
