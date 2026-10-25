/* The private generic fixture entrypoint exists only in this test translation
 * unit. Production exports only the fixed-tool enum API. No block devices. */
#include "restore-tool-runner.c"
#include <assert.h>
#include <stdlib.h>
#include <stdio.h>
#include <sys/stat.h>
#include <sys/resource.h>

static void write_all(int fd, const void *data, size_t size) {
  const char *bytes = data;
  while (size) {
    ssize_t n = write(fd, bytes, size);
    if (n < 0 && errno == EINTR) continue;
    assert(n > 0);
    bytes += n; size -= (size_t)n;
  }
}

static int fixture(const char *mode, const char *pid_path) {
  if (strcmp(mode, "contract") == 0 || strcmp(mode, "no-fd") == 0) {
    extern char **environ;
    size_t count = 0;
    while (environ[count]) ++count;
    assert(count == 3U);
    assert(strcmp(getenv("LANG"), "C") == 0);
    assert(strcmp(getenv("LC_ALL"), "C") == 0);
    assert(strcmp(getenv("PATH"), "/nonexistent") == 0);
    char input;
    assert(read(0, &input, 1) == 0);
    for (int fd = 3; fd < 1024; ++fd) {
      if (fd == 4 && strcmp(mode, "contract") == 0) continue;
      assert(fcntl(fd, F_GETFD) < 0 && errno == EBADF);
    }
    assert(fcntl(9000, F_GETFD) < 0 && errno == EBADF);
    if (strcmp(mode, "contract") == 0) {
      assert(pread(4, &input, 1, 0) == 1 && input == 'X');
      assert(fcntl(4, F_GETFD) == 0);
    }
    write_all(1, "out", 3); write_all(2, "err!", 4);
    return 0;
  }
  if (strcmp(mode, "exit") == 0) return 23;
  if (strcmp(mode, "signal") == 0) { raise(SIGTERM); return 99; }
  if (strcmp(mode, "closed-hang") == 0) { close(1); close(2); }
  if (strcmp(mode, "hang") == 0 || strcmp(mode, "closed-hang") == 0) {
    signal(SIGTERM, SIG_IGN);
    for (;;) pause();
  }
  if (strcmp(mode, "descendant") == 0) {
    pid_t worker = fork(); assert(worker >= 0);
    if (worker == 0) { for (;;) pause(); }
    FILE *out = fopen(pid_path, "w"); assert(out);
    assert(fprintf(out, "%d\n", worker) > 0); assert(fclose(out) == 0);
    return 0;
  }
  char buffer[4096]; memset(buffer, 'A', sizeof(buffer));
  if (strcmp(mode, "boundary") == 0) {
    for (size_t i = 0; i < OUTPUT_LIMIT / sizeof(buffer); ++i) {
      write_all(1, buffer, sizeof(buffer)); write_all(2, buffer, sizeof(buffer));
    }
    return 0;
  }
  if (strcmp(mode, "stdout-flood") == 0 || strcmp(mode, "stderr-flood") == 0) {
    int fd = strcmp(mode, "stdout-flood") == 0 ? 1 : 2;
    for (;;) write_all(fd, buffer, sizeof(buffer));
  }
  return 90;
}

static struct elizaos_tool_result check(const char *mode, int fd,
                                        enum elizaos_tool_outcome outcome,
                                        const char *extra) {
  char *const argv[] = {"restore-fixture", (char *)mode, (char *)extra, NULL};
  const struct tool_spec spec = {.path = "/proc/self/exe", .argv = argv,
    .timeout_ms = strstr(mode, "hang") ? 150 : 3000};
  struct elizaos_tool_result result;
  int64_t start = monotonic_ms();
  int rc = run_spec(&spec, fd, &result);
  if (result.outcome != outcome) {
    fprintf(stderr, "%s: outcome=%d expected=%d detail=%d rc=%d\n", mode,
            result.outcome, outcome, result.detail, rc);
    abort();
  }
  assert((rc == 0) == (outcome == ELIZAOS_TOOL_OK));
  assert(monotonic_ms() - start < 10000);
  assert(result.stdout_bytes <= OUTPUT_LIMIT + 4096U);
  assert(result.stderr_bytes <= OUTPUT_LIMIT + 4096U);
  return result;
}

int main(int argc, char **argv) {
  if (argc > 1) return fixture(argv[1], argc > 2 ? argv[2] : NULL);
  /* Adopt fixture grandchildren so the test can prove group cleanup without
   * leaving zombies to the host's PID 1. The production runner is no subreaper. */
  assert(prctl(PR_SET_CHILD_SUBREAPER, 1) == 0);
  char path[] = "/tmp/elizaos-runner-test-XXXXXX";
  int fd = mkstemp(path); assert(fd >= 0); assert(unlink(path) == 0);
  write_all(fd, "X", 1);
  struct rlimit limit; assert(getrlimit(RLIMIT_NOFILE, &limit) == 0);
  assert(limit.rlim_max > 9000U);
  if (limit.rlim_cur <= 9000U) { limit.rlim_cur = 9001U; assert(setrlimit(RLIMIT_NOFILE, &limit) == 0); }
  assert(dup2(fd, 9000) == 9000);
  assert(setenv("ELIZAOS_SHOULD_NOT_LEAK", "secret", 1) == 0);
  struct elizaos_tool_result result = check("contract", fd, ELIZAOS_TOOL_OK, NULL);
  assert(result.stdout_bytes == 3U && result.stderr_bytes == 4U);
  check("no-fd", -1, ELIZAOS_TOOL_OK, NULL);
  result = check("exit", -1, ELIZAOS_TOOL_EXIT, NULL); assert(result.detail == 23);
  result = check("signal", -1, ELIZAOS_TOOL_SIGNAL, NULL); assert(result.detail == SIGTERM);
  check("hang", -1, ELIZAOS_TOOL_TIMEOUT, NULL);
  check("closed-hang", -1, ELIZAOS_TOOL_TIMEOUT, NULL);
  result = check("boundary", -1, ELIZAOS_TOOL_OK, NULL);
  assert(result.stdout_bytes == OUTPUT_LIMIT && result.stderr_bytes == OUTPUT_LIMIT);
  check("stdout-flood", -1, ELIZAOS_TOOL_OUTPUT_LIMIT, NULL);
  check("stderr-flood", -1, ELIZAOS_TOOL_OUTPUT_LIMIT, NULL);
  char directory[] = "/tmp/elizaos-runner-worker-XXXXXX";
  assert(mkdtemp(directory));
  char pid_path[128]; assert(snprintf(pid_path, sizeof(pid_path), "%s/pid", directory) > 0);
  check("descendant", -1, ELIZAOS_TOOL_OK, pid_path);
  FILE *input = fopen(pid_path, "r"); assert(input);
  int worker; assert(fscanf(input, "%d", &worker) == 1); assert(fclose(input) == 0);
  int status; assert(waitpid(worker, &status, 0) == worker);
  assert(WIFSIGNALED(status) && WTERMSIG(status) == SIGKILL);
  assert(unlink(pid_path) == 0); assert(rmdir(directory) == 0);
  char *const missing_argv[] = {"missing", NULL};
  const struct tool_spec missing = {.path = "/nonexistent/elizaos", .argv = missing_argv,
                                    .timeout_ms = 300};
  assert(run_spec(&missing, -1, &result) < 0);
  assert(result.outcome == ELIZAOS_TOOL_SETUP && result.detail == ENOENT);
  assert(elizaos_restore_run_tool((enum elizaos_restore_tool)99, -1, &result) == -EINVAL);
  assert(elizaos_restore_run_tool(ELIZAOS_RESTORE_FORMAT, -1, &result) == -EINVAL);
  assert(elizaos_restore_run_tool(ELIZAOS_RESTORE_SETTLE, fd, &result) == -EINVAL);
  assert(elizaos_restore_run_tool(ELIZAOS_RESTORE_CHECK, 8000, &result) == -EBADF);
  int closed = dup(fd); assert(closed >= 0); close(closed);
  assert(run_spec(&missing, closed, &result) == -EBADF);
  assert(signal(SIGCHLD, SIG_IGN) != SIG_ERR);
  assert(run_spec(&missing, -1, &result) == -EINVAL);
  assert(signal(SIGCHLD, SIG_DFL) != SIG_ERR);
  char byte; assert(pread(fd, &byte, 1, 0) == 1 && byte == 'X');
  close(9000); close(fd);
  assert(waitpid(-1, &status, WNOHANG) == -1 && errno == ECHILD);
  puts("PASS: fixed-tool runner isolation, output limits, deadline, exec errors, signals and descendant cleanup");
  return 0;
}
