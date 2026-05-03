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
// Layout on device:
//   $DEVICE_DIR/ld-musl-x86_64.so.1        — this wrapper (renamed from ld-musl-x86_64.so.1.real)
//   $DEVICE_DIR/ld-musl-x86_64.so.1.real   — real musl loader
//   $DEVICE_DIR/libsigsys-handler.so          — the syscall shim
//
// Build: zig cc -target x86_64-linux-musl -O2 -static -o loader-wrap loader-wrap.c
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

extern char **environ;

int main(int argc, char **argv) {
  const char *self = argv[0];
  // Build the real loader path: <self>.real
  char real_loader[4096];
  snprintf(real_loader, sizeof(real_loader), "%s.real", self);

  // Build the access-shim path. Heuristic: same dir as self, named libsigsys-handler.so.
  char shim[4096];
  snprintf(shim, sizeof(shim), "%s", self);
  char *slash = strrchr(shim, '/');
  if (slash) {
    *slash = '\0';
    strncat(shim, "/libsigsys-handler.so", sizeof(shim) - strlen(shim) - 1);
  } else {
    strcpy(shim, "./libsigsys-handler.so");
  }

  // Prepend our shim to LD_PRELOAD.
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
  // If we get here, exec failed.
  perror("execve real loader");
  return 127;
}
