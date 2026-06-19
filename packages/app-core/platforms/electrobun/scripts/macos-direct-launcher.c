#include <errno.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int fail(const char *message) {
  fprintf(stderr, "%s: %s\n", message, strerror(errno));
  return 111;
}

int main(void) {
  uint32_t executable_path_size = 0;
  _NSGetExecutablePath(NULL, &executable_path_size);

  char *executable_path = malloc((size_t)executable_path_size + 1U);
  if (executable_path == NULL) {
    fputs("failed to allocate executable path buffer\n", stderr);
    return 111;
  }

  if (_NSGetExecutablePath(executable_path, &executable_path_size) != 0) {
    free(executable_path);
    fputs("failed to resolve executable path\n", stderr);
    return 111;
  }

  char resolved_path[PATH_MAX];
  if (realpath(executable_path, resolved_path) == NULL) {
    free(executable_path);
    return fail("failed to canonicalize executable path");
  }
  free(executable_path);

  char *last_slash = strrchr(resolved_path, '/');
  if (last_slash == NULL) {
    fputs("unexpected executable path format\n", stderr);
    return 111;
  }
  *last_slash = '\0';

  if (chdir(resolved_path) != 0) {
    return fail("failed to change into launcher directory");
  }

  size_t bun_path_size = strlen(resolved_path) + strlen("/bun") + 1U;
  char *bun_path = malloc(bun_path_size);
  if (bun_path == NULL) {
    fputs("failed to allocate bun path buffer\n", stderr);
    return 111;
  }
  if (snprintf(bun_path, bun_path_size, "%s/bun", resolved_path) < 0) {
    free(bun_path);
    fputs("failed to format bun path\n", stderr);
    return 111;
  }

  size_t main_js_path_size =
      strlen(resolved_path) + strlen("/../Resources/main.js") + 1U;
  char *main_js_path = malloc(main_js_path_size);
  if (main_js_path == NULL) {
    free(bun_path);
    fputs("failed to allocate main.js path buffer\n", stderr);
    return 111;
  }
  if (snprintf(
          main_js_path,
          main_js_path_size,
          "%s/../Resources/main.js",
          resolved_path) < 0) {
    free(main_js_path);
    free(bun_path);
    fputs("failed to format main.js path\n", stderr);
    return 111;
  }

  char *const child_argv[] = {bun_path, main_js_path, NULL};
  execv(child_argv[0], child_argv);
  free(main_js_path);
  free(bun_path);
  return fail("failed to exec bundled bun runtime");
}
