#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static void foreign_handler(int signal) { (void)signal; }
static void mask_is(int sys, int usr) {
  sigset_t actual;
  assert(sigprocmask(SIG_SETMASK, NULL, &actual) == 0);
  assert(sigismember(&actual, SIGSYS) == sys);
  assert(sigismember(&actual, SIGUSR1) == usr);
}
int main(void) {
  struct sigaction owned;
  assert(sigaction(SIGSYS, NULL, &owned) == 0);
  assert(owned.sa_flags & SA_SIGINFO);
  sigset_t empty, requested, old;
  sigemptyset(&empty);
  sigemptyset(&requested);
  sigaddset(&requested, SIGSYS);
  sigaddset(&requested, SIGUSR1);
  assert(sigprocmask(SIG_SETMASK, &empty, NULL) == 0);
  assert(sigprocmask(SIG_BLOCK, &requested, &old) == 0);
  assert(sigismember(&old, SIGSYS) == 0 && sigismember(&old, SIGUSR1) == 0);
  mask_is(0, 1);
  assert(sigprocmask(SIG_UNBLOCK, &requested, NULL) == 0);
  mask_is(0, 0);
  assert(sigprocmask(SIG_SETMASK, &requested, NULL) == 0);
  mask_is(0, 1);
  sigset_t alias = requested;
  int (*const mask_call)(int, const sigset_t *, sigset_t *) = sigprocmask;
  assert(mask_call(SIG_SETMASK, &alias, &alias) == 0);
  assert(sigismember(&alias, SIGSYS) == 0 && sigismember(&alias, SIGUSR1) == 1);
  mask_is(0, 1);
  errno = 0;
  assert(sigprocmask(999, &requested, NULL) == -1 && errno == EINVAL);
  mask_is(0, 1);
  assert(sigprocmask(999, NULL, &old) == 0);
  assert(sigismember(&old, SIGSYS) == 0 && sigismember(&old, SIGUSR1) == 1);
  assert(sigprocmask(SIG_SETMASK, &empty, NULL) == 0);
  struct sigaction foreign = { .sa_handler = foreign_handler };
  sigemptyset(&foreign.sa_mask);
  assert(sigaction(SIGSYS, &foreign, NULL) == 0);
  assert(sigprocmask(SIG_SETMASK, &requested, NULL) == 0);
  mask_is(1, 1);
  assert(sigprocmask(SIG_UNBLOCK, &requested, NULL) == 0);
  mask_is(0, 0);
  foreign.sa_handler = SIG_DFL;
  assert(sigaction(SIGSYS, &foreign, NULL) == 0);
  assert(sigprocmask(SIG_BLOCK, &requested, NULL) == 0);
  mask_is(1, 1);
  assert(sigprocmask(SIG_SETMASK, &empty, NULL) == 0);
  assert(sigaction(SIGSYS, &owned, NULL) == 0);

  // Real kernel trap, not a mocked callback. The shim translates dup2 to dup3.
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_dup2, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_TRAP),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = { .len = sizeof(filter)/sizeof(filter[0]), .filter = filter };
  assert(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0);
  assert(prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) == 0);
  sigset_t all;
  sigfillset(&all);
  assert(sigprocmask(SIG_SETMASK, &all, &old) == 0);
  pid_t child = fork();
  assert(child >= 0);
  if (!child) {
    struct sigaction reset = { .sa_handler = SIG_DFL };
    for (int signal = 1; signal < NSIG; signal++) sigaction(signal, &reset, NULL);
    int fd = open("/dev/null", O_WRONLY | O_CLOEXEC);
    if (fd < 0 || dup2(fd, STDOUT_FILENO) < 0) _exit(41);
    close(fd);
    if (sigprocmask(SIG_SETMASK, &old, NULL)) _exit(42);
    execl("/bin/true", "true", NULL);
    _exit(43);
  }
  assert(sigprocmask(SIG_SETMASK, &old, NULL) == 0);
  int status;
  assert(waitpid(child, &status, 0) == child);
  assert(WIFEXITED(status) && WEXITSTATUS(status) == 0);
  puts("signal masks, foreign handlers, aliasing, errno and real child seccomp trap passed");
}
