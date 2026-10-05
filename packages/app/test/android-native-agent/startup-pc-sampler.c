/* Test-only disposable-emulator sampler. Never reads process memory or arguments. */
#define _GNU_SOURCE
#include <errno.h>
#include <elf.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ptrace.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <sys/user.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t interrupted;
static void stop(int sig) { (void)sig; interrupted = 1; }
static long millis(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec*1000 + t.tv_nsec/1000000; }
static int stopped(pid_t pid, long deadline) {
  int status;
  while (millis() < deadline) {
    pid_t result = waitpid(pid, &status, WNOHANG | __WALL);
    if (result == pid) return WIFSTOPPED(status);
    if (result < 0 && errno != EINTR) return 0;
    usleep(1000);
  }
  return 0;
}
int main(int argc, char **argv) {
  if (argc != 3 || getuid() != 0) { puts("error:root_required"); return 1; }
  char *end; long rawpid = strtol(argv[1], &end, 10);
  if (*end || rawpid <= 1 || rawpid > 2147483647) return 1;
  pid_t pid = (pid_t)rawpid;
  long uid = strtol(argv[2], &end, 10);
  if (*end || uid < 10000 || uid > 2147483647) return 1;
  char path[96], line[1024], executable[1024];
  snprintf(path, sizeof(path), "/proc/%d/status", pid);
  FILE *status = fopen(path, "r"); int owned = 0;
  if (status) {
    while (fgets(line, sizeof(line), status)) {
      unsigned a,b,c,d;
      if (sscanf(line,"Uid: %u %u %u %u",&a,&b,&c,&d)==4) owned = a==uid && b==uid && c==uid && d==uid;
    }
    fclose(status);
  }
  snprintf(path, sizeof(path), "/proc/%d/exe", pid);
  ssize_t n = readlink(path, executable, sizeof(executable)-1);
  if (!owned || n <= 0) { puts("error:target_identity_unverified"); return 1; }
  executable[n]=0; char *base=strrchr(executable,'/'); base=base?base+1:executable;
  if (strcmp(base,"libeliza_ld_musl_x86_64_real.so")) { puts("error:unexpected_executable"); return 1; }
  signal(SIGTERM, stop); signal(SIGINT, stop);
  long deadline = millis()+2000;
  for (int sample=0; sample<2 && !interrupted && millis()<deadline; sample++) {
    if (ptrace(PTRACE_SEIZE,pid,0,0)) { printf("error:seize_errno_%d\n",errno); return 1; }
    int is_stopped=0, failed=0;
    if (ptrace(PTRACE_INTERRUPT,pid,0,0) || !(is_stopped=stopped(pid,deadline))) {
      puts("error:interrupt_or_wait_failed"); failed=1;
    } else {
      struct user_regs_struct regs; struct iovec io={&regs,sizeof(regs)};
      if (ptrace(PTRACE_GETREGSET,pid,(void*)NT_PRSTATUS,&io)) { printf("error:register_errno_%d\n",errno); failed=1; }
      else {
        snprintf(path,sizeof(path),"/proc/%d/maps",pid); FILE *maps=fopen(path,"r"); int found=0;
        if (maps) {
          while (fgets(line,sizeof(line),maps)) {
            unsigned long lo,hi,off; char permissions[5],module[768]={0};
            int fields=sscanf(line,"%lx-%lx %4s %lx %*s %*s %767[^\n]",&lo,&hi,permissions,&off,module);
            if (fields>=4 && regs.rip>=lo && regs.rip<hi) {
              char *name=strrchr(module,'/'); name=name?name+1:module;
              for (char *p=name; *p; p++) if (!( (*p>='a'&&*p<='z')||(*p>='A'&&*p<='Z')||(*p>='0'&&*p<='9')||strchr("._-[]",*p))) *p='_';
              printf("sample:%d module:%s pc_offset:%lx\n",sample,*name?name:"anonymous",regs.rip-lo+off); found=1; break;
            }
          }
          fclose(maps);
        }
        if (!found) puts("error:pc_mapping_unavailable");
      }
    }
    /* Every successful seize must detach. If first wait failed, retry interrupt before detaching. */
    if (!is_stopped) { ptrace(PTRACE_INTERRUPT,pid,0,0); is_stopped=stopped(pid,millis()+200); }
    if (is_stopped && ptrace(PTRACE_DETACH,pid,0,0)==0) puts("detached");
    else { puts("error:detach_failed"); return 1; } /* Tracer exit also auto-detaches; no EXITKILL. */
    if (failed) return 1;
    usleep(100000);
  }
  return interrupted ? 1 : 0;
}
