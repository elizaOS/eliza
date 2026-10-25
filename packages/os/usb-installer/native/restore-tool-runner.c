#define _GNU_SOURCE
#include "restore-tool-runner.h"
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define OUTPUT_LIMIT (256U * 1024U)
struct tool_spec { const char *path; char *const *argv; int timeout_ms; };

static int64_t monotonic_ms(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
  return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static void child_error(int error_fd, int error) {
  const unsigned char *bytes = (const unsigned char *)&error;
  size_t offset = 0;
  while (offset < sizeof(error)) {
    ssize_t n = write(error_fd, bytes + offset, sizeof(error) - offset);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) break;
    offset += (size_t)n;
  }
  _exit(127);
}

static int high_fd(int fd) {
  if (fd < 0) return -1;
  int copy = fcntl(fd, F_DUPFD_CLOEXEC, 10);
  int saved = errno;
  close(fd);
  errno = saved;
  return copy;
}

static int run_spec(const struct tool_spec *spec, int partition_fd,
                    struct elizaos_tool_result *result) {
  int pipes[3][2] = {{-1,-1},{-1,-1},{-1,-1}};
  int null_fd = -1, held = -1, rc = -EIO;
  pid_t child = -1;
  *result = (struct elizaos_tool_result){.outcome = ELIZAOS_TOOL_SETUP};
  /* A reaping handler (or SIG_IGN) could release and recycle the leader PID
   * before process-group cleanup. This API belongs in a single-threaded helper. */
  struct sigaction child_action;
  if (sigaction(SIGCHLD, NULL, &child_action) != 0) {
    result->detail = errno; return -errno;
  }
  if (child_action.sa_handler != SIG_DFL || (child_action.sa_flags & SA_NOCLDWAIT)) {
    result->detail = EINVAL; return -EINVAL;
  }
  const int64_t start = monotonic_ms();
  if (start < 0) { result->detail = errno; return -errno; }
  /* Duplicate before creating pipes: a closed caller FD must not be reused
   * by our own setup and accidentally become the inherited descriptor. */
  if (partition_fd >= 0) {
    held = fcntl(partition_fd, F_DUPFD_CLOEXEC, 10);
    if (held < 0) goto setup_failed;
  }
  for (size_t stream = 0; stream < 3U; ++stream) {
    if (pipe2(pipes[stream], O_CLOEXEC) != 0) goto setup_failed;
    for (size_t end = 0; end < 2U; ++end) {
      pipes[stream][end] = high_fd(pipes[stream][end]);
      if (pipes[stream][end] < 0) goto setup_failed;
    }
    int flags = fcntl(pipes[stream][0], F_GETFL);
    if (flags < 0 || fcntl(pipes[stream][0], F_SETFL, flags | O_NONBLOCK) < 0)
      goto setup_failed;
  }
  null_fd = high_fd(open("/dev/null", O_RDONLY | O_CLOEXEC | O_NOFOLLOW));
  if (null_fd < 0) goto setup_failed;
  const pid_t parent = getpid();
  child = fork();
  if (child < 0) goto setup_failed;
  if (child == 0) {
    int errfd = pipes[2][1];
    if (setpgid(0, 0) != 0 || prctl(PR_SET_PDEATHSIG, SIGKILL) != 0)
      child_error(errfd, errno);
    if (getppid() != parent) child_error(errfd, ESRCH);
    sigset_t empty;
    sigemptyset(&empty);
    if (sigprocmask(SIG_SETMASK, &empty, NULL) != 0) child_error(errfd, errno);
    for (int sig = 1; sig < NSIG; ++sig) {
      if (sig == SIGKILL || sig == SIGSTOP) continue;
      struct sigaction action = {.sa_handler = SIG_DFL};
      sigemptyset(&action.sa_mask);
      if (sigaction(sig, &action, NULL) != 0 && errno != EINVAL)
        child_error(errfd, errno);
    }
    if (dup2(null_fd, 0) < 0 || dup2(pipes[0][1], 1) < 0 ||
        dup2(pipes[1][1], 2) < 0 || (held >= 0 && dup2(held, 4) < 0) ||
        dup3(errfd, 5, O_CLOEXEC) < 0) child_error(errfd, errno);
    close(3);
    if (held < 0) close(4);
    if (close_range(6U, UINT_MAX, 0) != 0) child_error(5, errno);
    char *const environment[] = {"LANG=C", "LC_ALL=C", "PATH=/nonexistent", NULL};
    execve(spec->path, spec->argv, environment);
    child_error(5, errno);
  }
  /* The child also establishes the group before exec. EACCES means it won
   * that race. Keep the leader unreaped until group cleanup prevents PID reuse. */
  if (setpgid(child, child) != 0 && errno != EACCES && errno != ESRCH) {
    result->detail = errno;
    goto stop;
  }
  for (size_t i = 0; i < 3U; ++i) { close(pipes[i][1]); pipes[i][1] = -1; }
  bool ended = false;
  unsigned char exec_error[sizeof(int)];
  size_t exec_bytes = 0;
  for (;;) {
    const int64_t now = monotonic_ms();
    if (now < 0) { result->outcome = ELIZAOS_TOOL_IO; result->detail = errno; goto stop; }
    if (now - start >= spec->timeout_ms) {
      result->outcome = ELIZAOS_TOOL_TIMEOUT; rc = -ETIMEDOUT; goto stop;
    }
    struct pollfd events[3];
    for (size_t i = 0; i < 3U; ++i)
      events[i] = (struct pollfd){.fd = pipes[i][0], .events = POLLIN};
    int remaining = spec->timeout_ms - (int)(now - start);
    int polled = poll(events, 3, remaining < 20 ? remaining : 20);
    if (polled < 0 && errno == EINTR) continue;
    if (polled < 0) { result->outcome = ELIZAOS_TOOL_IO; result->detail = errno; goto stop; }
    for (size_t i = 0; i < 3U; ++i) {
      if (events[i].revents & POLLNVAL) { result->outcome = ELIZAOS_TOOL_IO; goto stop; }
      if (!(events[i].revents & (POLLIN | POLLHUP | POLLERR))) continue;
      /* One bounded read per stream per iteration: flooding one pipe cannot
       * starve the other stream, wait status, or the monotonic deadline. */
      unsigned char buffer[4096];
      ssize_t n = read(pipes[i][0], buffer, sizeof(buffer));
      if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
      if (n < 0) { result->outcome = ELIZAOS_TOOL_IO; result->detail = errno; goto stop; }
      if (n == 0) { close(pipes[i][0]); pipes[i][0] = -1; continue; }
      if (i == 2U) {
        if ((size_t)n > sizeof(exec_error) - exec_bytes) {
          result->outcome = ELIZAOS_TOOL_IO; goto stop;
        }
        memcpy(exec_error + exec_bytes, buffer, (size_t)n);
        exec_bytes += (size_t)n;
      } else {
        size_t *count = i == 0U ? &result->stdout_bytes : &result->stderr_bytes;
        *count += (size_t)n;
        if (*count > OUTPUT_LIMIT) {
          result->outcome = ELIZAOS_TOOL_OUTPUT_LIMIT; rc = -EFBIG; goto stop;
        }
      }
    }
    siginfo_t info = {0};
    if (waitid(P_PID, (id_t)child, &info, WEXITED | WNOHANG | WNOWAIT) != 0) {
      if (errno == EINTR) continue;
      result->outcome = ELIZAOS_TOOL_IO; result->detail = errno; goto stop;
    }
    if (info.si_pid != 0 && !ended) {
      ended = true;
      /* Fixed utilities have no legitimate background workers. Terminate
       * descendants even if they close their output or the leader exits zero. */
      (void)kill(-child, SIGKILL);
    }
    if (!ended || pipes[0][0] >= 0 || pipes[1][0] >= 0 || pipes[2][0] >= 0) continue;
    if (exec_bytes != 0U) {
      if (exec_bytes == sizeof(int)) memcpy(&result->detail, exec_error, sizeof(int));
      result->outcome = ELIZAOS_TOOL_SETUP; rc = -EIO; goto stop;
    }
    result->detail = info.si_status;
    result->outcome = info.si_code != CLD_EXITED ? ELIZAOS_TOOL_SIGNAL :
                      info.si_status != 0 ? ELIZAOS_TOOL_EXIT : ELIZAOS_TOOL_OK;
    rc = result->outcome == ELIZAOS_TOOL_OK ? 0 : -ECHILD;
    goto stop;
  }
setup_failed:
  result->detail = errno;
  rc = -errno;
stop:
  if (child > 0) {
    (void)kill(-child, SIGKILL);
    (void)kill(child, SIGKILL);
    int status;
    while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
  }
  for (size_t i = 0; i < 3U; ++i)
    for (size_t j = 0; j < 2U; ++j) if (pipes[i][j] >= 0) close(pipes[i][j]);
  if (held >= 0) close(held);
  if (null_fd >= 0) close(null_fd);
  return rc;
}

int elizaos_restore_run_tool(enum elizaos_restore_tool tool, int partition_fd,
                            struct elizaos_tool_result *result) {
  if (!result) return -EINVAL;
  *result = (struct elizaos_tool_result){.outcome = ELIZAOS_TOOL_SETUP, .detail = EINVAL};
  char *const settle[] = {"udevadm", "settle", "--timeout=10", NULL};
  char *const format[] = {"elizaos-mkfs-exfat-fd", NULL};
  char *const check[] = {"elizaos-fsck-exfat-fd", NULL};
  struct tool_spec spec = {.timeout_ms = 15000};
  switch (tool) {
    case ELIZAOS_RESTORE_SETTLE:
      if (partition_fd != -1) return -EINVAL;
      spec.path = "/usr/bin/udevadm"; spec.argv = settle; break;
    case ELIZAOS_RESTORE_FORMAT:
      if (partition_fd < 0) return -EINVAL;
      spec.path = "/usr/libexec/elizaos-mkfs-exfat-fd"; spec.argv = format; break;
    case ELIZAOS_RESTORE_CHECK:
      if (partition_fd < 0) return -EINVAL;
      spec.path = "/usr/libexec/elizaos-fsck-exfat-fd"; spec.argv = check; break;
    default: return -EINVAL;
  }
  return run_spec(&spec, partition_fd, result);
}
