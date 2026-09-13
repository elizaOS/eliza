/** Owns native hook descriptors, payload-free output and an exclusive guardian channel.
 * A drained result is not an authenticated attempt manifest. The guardian must
 * bind source/policy identities, cleanup and the canonical attempt signature.
 */
#define _GNU_SOURCE
#include <bpf/libbpf.h>
#include <bpf/bpf.h>
#include <linux/membarrier.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/resource.h>
#include <poll.h>
#include <dirent.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "ledger.h"
#include "retirement.h"

struct owner {
 int directory, channel, guardian, output;
 unsigned int uid;
 unsigned long long received, bytes;
 unsigned char *released;
 size_t released_size;
 long long deadline;
};
static long long now_ms(void) {
 struct timespec value;
 if (clock_gettime(CLOCK_MONOTONIC, &value)) return -1;
 return (long long)value.tv_sec * 1000 + value.tv_nsec / 1000000;
}
static int healthy(struct owner *owner) {
 struct pollfd guardian = {.fd = owner->guardian, .events = POLLIN};
 return now_ms() >= 0 && now_ms() < owner->deadline && poll(&guardian, 1, 0) == 0;
}
static int complete_write(int fd, const char *bytes, size_t length) {
 while (length) {
  ssize_t count = write(fd, bytes, length);
  if (count < 0 && errno == EINTR) continue;
  if (count <= 0) return -1;
  bytes += count; length -= (size_t)count;
 }
 return 0;
}
static int private_file(int directory, const char *name, int flags, mode_t mode) {
 int fd = openat(directory, name, flags | O_NOFOLLOW | O_CLOEXEC, mode);
 if (fd < 0) return -1;
 struct stat info;
 if (fstat(fd, &info) || !S_ISREG(info.st_mode) || info.st_uid ||
     info.st_nlink != 1 || (info.st_mode & 0777) != mode) {
  close(fd); errno = EINVAL; return -1;
 }
 return fd;
}
static int map_fd(struct bpf_object *object, const char *name) {
 struct bpf_map *map = bpf_object__find_map_by_name(object, name);
 return map ? bpf_map__fd(map) : -1;
}
static int empty_map(int fd) {
 unsigned long long key;
 if (bpf_map_get_next_key(fd, NULL, &key) == 0) return 0;
 return errno == ENOENT ? 1 : -1;
}
static unsigned long long process_start(pid_t pid) {
 char path[64], buffer[4096];
 if (snprintf(path, sizeof(path), "/proc/%d/stat", pid) >= (int)sizeof(path)) return 0;
 int fd = open(path, O_RDONLY | O_CLOEXEC); if (fd < 0) return 0;
 struct stat info; ssize_t count = read(fd, buffer, sizeof(buffer) - 1);
 int invalid = fstat(fd, &info) || info.st_uid; close(fd);
 if (invalid || count <= 0 || count == sizeof(buffer) - 1) return 0;
 buffer[count] = 0; char *end = strrchr(buffer, ')'); if (!end || end[1] != ' ') return 0;
 char *saved = NULL, *field = strtok_r(end + 2, " ", &saved);
 for (int index = 3; field && index < 22; index++) field = strtok_r(NULL, " ", &saved);
 if (!field) return 0;
 char *tail; errno = 0; unsigned long long value = strtoull(field, &tail, 10);
 return errno || *tail ? 0 : value;
}
static int accept_guardian(struct owner *owner, const char *directory_path,
                           pid_t pid, unsigned long long start) {
 owner->guardian = syscall(SYS_pidfd_open, pid, 0);
 if (owner->guardian < 0 || !start || process_start(pid) != start) return -1;
 int listener = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
 if (listener < 0) return -1;
 struct sockaddr_un address = {.sun_family = AF_UNIX};
 int length = snprintf(address.sun_path, sizeof(address.sun_path), "%s/collector.sock", directory_path);
 if (length < 0 || (size_t)length >= sizeof(address.sun_path)) { close(listener); return -1; }
 mode_t previous = umask(0077);
 int bound = bind(listener, (struct sockaddr *)&address, sizeof(address)); umask(previous);
 if (bound || listen(listener, 1)) { close(listener); return -1; }
 while (healthy(owner)) {
  struct pollfd waiting = {.fd = listener, .events = POLLIN};
  int ready = poll(&waiting, 1, 50);
  if (ready < 0 && errno == EINTR) continue;
  if (ready < 0) break;
  if (!ready) continue;
  int channel = accept4(listener, NULL, NULL, SOCK_CLOEXEC | SOCK_NONBLOCK);
  if (channel < 0) break;
  struct ucred credential; socklen_t size = sizeof(credential);
  if (getsockopt(channel, SOL_SOCKET, SO_PEERCRED, &credential, &size) ||
      size != sizeof(credential) || credential.uid || credential.pid != pid ||
      process_start(pid) != start) { close(channel); break; }
  owner->channel = channel; close(listener); return 0;
 }
 close(listener); return -1;
}
static int owned_tasks_absent(unsigned int uid) {
 DIR *directory = opendir("/proc"); if (!directory) return -1;
 int outcome = 1; struct dirent *entry;
 errno = 0;
 while ((entry = readdir(directory))) {
  char *tail; unsigned long pid = strtoul(entry->d_name, &tail, 10);
  if (!pid || *tail) continue;
  char path[96]; if (snprintf(path, sizeof(path), "/proc/%lu/status", pid) >= (int)sizeof(path)) { outcome = -1; break; }
  FILE *status = fopen(path, "re");
  if (!status) { if (errno == ENOENT) { errno = 0; continue; } outcome = -1; break; }
  char *line = NULL; size_t capacity = 0; int found = 0;
  while (getline(&line, &capacity, status) >= 0) {
   unsigned int real, effective, saved, filesystem;
   if (sscanf(line, "Uid:\t%u\t%u\t%u\t%u", &real, &effective, &saved, &filesystem) == 4) {
    found = 1; if (uid == real || uid == effective || uid == saved || uid == filesystem) outcome = 0;
    break;
   }
  }
  if (ferror(status) || !found) outcome = -1;
  free(line); if (fclose(status)) outcome = -1;
  if (outcome != 1) break;
  errno = 0;
 }
 if (!entry && errno) outcome = -1;
 if (closedir(directory)) outcome = -1;
 return outcome;
}
static int record_event(void *context, void *data, size_t size) {
 struct owner *owner = context;
 if (size != sizeof(struct ledger_event) || !healthy(owner)) return -1;
 const struct ledger_event *event = data;
 if (!event->sequence || event->kind < SYSCALL_ENTER || event->kind > FILTER_SYSCALL_RESULT) return -1;
 if (event->socket_id) {
  if (event->socket_id >= SIZE_MAX) return -1;
  size_t needed = (size_t)event->socket_id + 1;
  if (needed > owner->released_size) {
   unsigned char *next = realloc(owner->released, needed); if (!next) return -1;
   memset(next + owner->released_size, 0, needed - owner->released_size);
   owner->released = next; owner->released_size = needed;
  }
  if (event->kind == SOCKET_RELEASE || event->kind == SOCKET_FREE) owner->released[event->socket_id] = 1;
 }
 char line[1024];
 int count = snprintf(line, sizeof(line),
  "{\"sequence\":%llu,\"monotonicNs\":%llu,\"thread\":%llu,\"socketId\":%llu,\"kind\":%u,\"nr\":%u,\"result\":%lld,\"family\":%u,\"port\":%u,\"address\":[%u,%u,%u,%u],\"flags\":%u,\"captured\":%u,\"operation\":%u,\"taskStartNs\":%llu,\"parentStartNs\":%llu,\"parentTgid\":%llu,\"namespaceId\":%llu,\"namespacePid\":%u,\"parentNamespacePid\":%u}\n",
  event->sequence,event->monotonic_ns,event->thread,event->socket_id,event->kind,event->nr,event->result,
  event->family,event->port,event->addr[0],event->addr[1],event->addr[2],event->addr[3],event->flags,event->captured,event->operation,event->task_start_ns,event->parent_start_ns,event->parent_thread,event->namespace_id,event->namespace_pid,event->parent_namespace_pid);
 if (count < 0 || (size_t)count >= sizeof(line) || complete_write(owner->output, line, count)) return -1;
 if (ULLONG_MAX - owner->bytes < (unsigned int)count || owner->received == ULLONG_MAX) return -1;
 owner->bytes += count; owner->received++; return 0;
}
static int retirement_complete(struct bpf_object *monitor) {
 __u32 zero = 0; struct retirement_counters values;
 if (bpf_map_lookup_elem(map_fd(monitor, "counters"), &zero, &values)) return -1;
 unsigned long long *fields = (void *)&values;
 for (size_t i = 2; i < sizeof(values) / 8; i++) if (fields[i]) return -1;
 int empty = empty_map(map_fd(monitor, "images")); if (empty < 0) return -1;
 if (values.allocated < 20 || values.allocated != values.retired || !empty) return 0;
 return 1;
}
static int program_misses(struct bpf_object *object) {
 struct bpf_program *program;
 bpf_object__for_each_program(program, object) {
  struct bpf_prog_info info = {}; __u32 size = sizeof(info);
  if (bpf_obj_get_info_by_fd(bpf_program__fd(program), &info, &size) || info.recursion_misses) return -1;
 }
 return 0;
}
/* This root-only snapshot explains rejection; it never asserts a complete seal. */
static int counter_snapshot(struct owner *owner, const struct ledger_metrics *sum) {
 int fd=private_file(owner->directory,"native-counters.json",O_WRONLY|O_CREAT|O_EXCL,0600);
 if(fd<0)return -1;
 int failed=dprintf(fd,"{\"emitted\":%llu,\"received\":%llu,\"ringLoss\":%llu,\"socketCreateFailure\":%llu,\"socketReadFailure\":%llu,\"socketDeleteFailure\":%llu,\"kernelReadFailure\":%llu,\"unsupportedFilterChange\":%llu,\"syscallEntries\":%llu,\"syscallExits\":%llu,\"filterStateCreateFailure\":%llu,\"filterStateReadFailure\":%llu,\"filterStateDeleteFailure\":%llu,\"syscallStateCreateFailure\":%llu,\"syscallStateReadFailure\":%llu,\"syscallStateDeleteFailure\":%llu,\"bootstrapRoleFailure\":%llu,\"bootstrapNetworkFailure\":%llu,\"nativeManifestAuthenticated\":false}\n",sum->emitted,owner->received,sum->ring_loss,sum->socket_create_failure,sum->socket_read_failure,sum->socket_delete_failure,sum->kernel_read_failure,sum->unsupported_filter_change,sum->syscall_entries,sum->syscall_exits,sum->filter_state_create_failure,sum->filter_state_read_failure,sum->filter_state_delete_failure,sum->syscall_state_create_failure,sum->syscall_state_read_failure,sum->syscall_state_delete_failure,sum->bootstrap_role_failure,sum->bootstrap_network_failure)<0;
 if(fsync(fd))failed=1;if(close(fd))failed=1;if(fsync(owner->directory))failed=1;
 return failed?-1:0;
}
static int final_counters(struct owner *owner, struct bpf_object *producer,
                          struct ledger_metrics *sum) {
 int cpus = libbpf_num_possible_cpus(); if (cpus <= 0) return -1;
 struct ledger_metrics *values = calloc((size_t)cpus, sizeof(*values)); if (!values) return -1;
 __u32 zero = 0; int result = bpf_map_lookup_elem(map_fd(producer, "metrics"), &zero, values);
 if (!result) {
  unsigned long long *output = (void *)sum;
  for (int cpu = 0; cpu < cpus; cpu++) {
   unsigned long long *input = (void *)&values[cpu];
   for (size_t i = 0; i < sizeof(*sum) / 8; i++) {
    if (ULLONG_MAX - output[i] < input[i]) result = -1;
    else output[i] += input[i];
   }
  }
 }
 free(values); if (result || counter_snapshot(owner, sum)) return -1;
 if (sum->emitted != owner->received || sum->ring_loss || sum->socket_create_failure ||
     sum->socket_read_failure || sum->socket_delete_failure || sum->kernel_read_failure ||
     sum->unsupported_filter_change || sum->filter_state_create_failure ||
     sum->filter_state_read_failure || sum->filter_state_delete_failure ||
     sum->syscall_entries != sum->syscall_exits || sum->syscall_state_create_failure ||
     sum->syscall_state_read_failure || sum->syscall_state_delete_failure ||
     sum->bootstrap_role_failure || sum->bootstrap_network_failure) return -1;
 unsigned long long sequence;
 if (bpf_map_lookup_elem(map_fd(producer, "serials"), &zero, &sequence) || sequence != owner->received) return -1;
 if (empty_map(map_fd(producer, "filter_calls")) != 1 ||
     empty_map(map_fd(producer, "network_calls")) != 1) return -1;
 struct ledger_bootstrap bootstrap;
 if (bpf_map_lookup_elem(map_fd(producer, "bootstrap"), &zero, &bootstrap) ||
     bootstrap.bwrap_execs != 1 || bootstrap.runtime_execs != 1 || bootstrap.filter_attempts != 2 ||
     bootstrap.filter_successes != 2 || bootstrap.filter_mismatches || bootstrap.unexpected_execs) return -1;
 __u32 init_index = 1, payload_index = 2;
 struct ledger_role init, payload;
 if (bpf_map_lookup_elem(map_fd(producer, "roles"), &init_index, &init) ||
     bpf_map_lookup_elem(map_fd(producer, "roles"), &payload_index, &payload) ||
     init.attach_success != 1 || init.syscall_success != 1 ||
     payload.attach_success != 1 || payload.syscall_success != 1 ||
     init.namespace_id != bootstrap.sandbox_namespace || payload.namespace_id != init.namespace_id ||
     init.parent_tgid != bootstrap.initial_tgid || init.parent_start_ns != bootstrap.initial_start_ns ||
     payload.parent_tgid != (init.thread >> 32) || payload.parent_start_ns != init.start_ns) return -1;
 unsigned long long key, next; void *previous = NULL;
 while (bpf_map_get_next_key(map_fd(producer, "sockets"), previous, &next) == 0) {
  unsigned long long generation;
  if (bpf_map_lookup_elem(map_fd(producer, "sockets"), &next, &generation) ||
      generation >= owner->released_size || !owner->released[generation]) return -1;
  key = next; previous = &key;
 }
 return errno == ENOENT ? 0 : -1;
}
static struct bpf_object *open_object(struct owner *owner, const char *name) {
 int fd = private_file(owner->directory, name, O_RDONLY, 0400); if (fd < 0) return NULL;
 char path[64]; snprintf(path, sizeof(path), "/proc/self/fd/%d", fd);
 struct bpf_object *object = bpf_object__open_file(path, NULL); close(fd);
 return libbpf_get_error(object) ? NULL : object;
}
static int inventory(struct owner *owner, struct bpf_object *object, struct bpf_link **links,
                      size_t count, const char *name) {
 int fd = private_file(owner->directory, name, O_WRONLY | O_CREAT | O_EXCL, 0600);
 if (fd < 0) return -1;
 int failure = 0;
 for (size_t i = 0; i < count; i++) {
  struct bpf_link_info info = {}; __u32 size = sizeof(info);
  if (bpf_obj_get_info_by_fd(bpf_link__fd(links[i]), &info, &size) || !info.id ||
      dprintf(fd, "link %u %u\n", info.id, info.prog_id) < 0) failure = 1;
 }
 struct bpf_program *program;
 bpf_object__for_each_program(program, object) {
  struct bpf_prog_info info = {}; __u32 size = sizeof(info);
  if (bpf_obj_get_info_by_fd(bpf_program__fd(program), &info, &size) || !info.id ||
      dprintf(fd, "program %s %u\n", bpf_program__name(program), info.id) < 0) failure = 1;
 }
 struct bpf_map *map;
 bpf_object__for_each_map(map, object) {
  struct bpf_map_info info = {}; __u32 size = sizeof(info);
  if (bpf_obj_get_info_by_fd(bpf_map__fd(map), &info, &size) || !info.id ||
      dprintf(fd, "map %s %u\n", bpf_map__name(map), info.id) < 0) failure = 1;
 }
 if (fsync(fd)) failure = 1;
 if (close(fd)) failure = 1;
 return failure ? -1 : 0;
}
static int verify_gone(const char *path) {
 int fd=open(path,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);if(fd<0)return 1;
 struct stat info;if(fstat(fd,&info)||!S_ISREG(info.st_mode)||info.st_uid||info.st_nlink!=1||
   (info.st_mode&0777)!=0600||info.st_size<=0||info.st_size>65536){close(fd);return 1;}
 FILE *file=fdopen(fd,"r");if(!file){close(fd);return 1;}
 char line[256];int result=0;unsigned long entries=0;
 while(fgets(line,sizeof(line),file)){
  if(!strchr(line,'\n')||entries>=256){result=1;break;}
  unsigned int id,program;char name[32],extra;int owned=-1;
  if(sscanf(line,"link %u %u %c",&id,&program,&extra)==2)owned=bpf_link_get_fd_by_id(id);
  else if(sscanf(line,"program %31s %u %c",name,&id,&extra)==2)owned=bpf_prog_get_fd_by_id(id);
  else if(sscanf(line,"map %31s %u %c",name,&id,&extra)==2)owned=bpf_map_get_fd_by_id(id);
  else {result=1;break;}
  entries++;
  if(owned>=0){if(close(owned))result=1;else if(!result)result=3;}
  else if(errno!=ENOENT){result=1;break;}
 }
 if(ferror(file)||!entries)result=1;if(fclose(file))result=1;return result;
}
static const char *required[] = {
 "syscall_enter","syscall_exit","connect_address","connect_result","message_enter","message_exit",
 "send_enter","send_exit","send_security","seccomp_denied","seccomp_audit","message_copy_result",
 "batch_result","sendto_result","stream_begin","stream_result","tcp_state","socket_release",
 "socket_free","inbound_accept","bootstrap_exec","bootstrap_filter"
};
int main(int argc, char **argv) {
 if(geteuid())return 64;
 if(argc==3&&!strcmp(argv[1],"--verify-gone"))return verify_gone(argv[2]);
 if(argc!=5)return 64;
 char *budget_tail; errno=0; unsigned long long budget=strtoull(argv[4],&budget_tail,10);
 if(errno||*budget_tail||!budget||budget>600000)return 64;
 struct owner owner = {.directory=-1,.channel=-1,.guardian=-1,.output=-1,.deadline=now_ms()+(long long)budget};
 struct bpf_object *producer=NULL,*monitor=NULL; struct ring_buffer *ring=NULL;
 struct bpf_link *native[22]={0},*watch[2]={0};size_t native_count=0,watch_count=0;
 int status=1;const char *phase="admission";signal(SIGPIPE,SIG_IGN);
 owner.directory=open(argv[1],O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
 struct stat directory_info;
 if(owner.directory<0||fstat(owner.directory,&directory_info)||directory_info.st_uid||
    (directory_info.st_mode&0777)!=0700)goto cleanup;
 char *tail;long guardian=strtol(argv[2],&tail,10);if(*tail||guardian<=1||guardian>INT_MAX)goto cleanup;
 unsigned long long start=strtoull(argv[3],&tail,10);if(*tail||!start)goto cleanup;
 phase="guardian-channel";
 if(accept_guardian(&owner,argv[1],guardian,start))goto cleanup;
 phase="configuration";
 int config_fd=private_file(owner.directory,"native-config.bin",O_RDONLY,0600);
 struct ledger_config configuration;struct stat config_info;
 if(config_fd<0)goto cleanup;
 int config_bad=fstat(config_fd,&config_info)||config_info.st_size!=sizeof(configuration)||
   read(config_fd,&configuration,sizeof(configuration))!=sizeof(configuration);if(close(config_fd))config_bad=1;
 if(config_bad||!configuration.target_uid||configuration.policy_length!=16)goto cleanup;
 owner.uid=configuration.target_uid;
 struct rlimit memlock={RLIM_INFINITY,RLIM_INFINITY};if(setrlimit(RLIMIT_MEMLOCK,&memlock))goto cleanup;
 phase="monitor-load";
 monitor=open_object(&owner,"retirement.bpf.o");producer=open_object(&owner,"ledger.bpf.o");
 if(!monitor||!producer||bpf_object__load(monitor))goto cleanup;
 struct bpf_program *program;
 bpf_object__for_each_program(program,monitor){
  const char *name=bpf_program__name(program);
  if(watch_count>=2||(strcmp(name,"image_installed")&&strcmp(name,"image_retired")))goto cleanup;
  struct bpf_link *link=bpf_program__attach(program);if(libbpf_get_error(link))goto cleanup;watch[watch_count++]=link;
 }
 if(watch_count!=2)goto cleanup;
 struct retirement_control control={.owner_thread=((unsigned long long)getpid()<<32)|(unsigned int)syscall(SYS_gettid),.armed=1};
 __u32 zero=0;if(bpf_map_update_elem(map_fd(monitor,"control"),&zero,&control,BPF_ANY))goto cleanup;
 phase="producer-load";
 struct bpf_map *ro=bpf_object__find_map_by_name(producer,".rodata");
 if(!ro||bpf_map__set_initial_value(ro,&configuration,sizeof(configuration))||bpf_object__load(producer))goto cleanup;
 phase="producer-attach";
 unsigned int seen=0;
 bpf_object__for_each_program(program,producer){
  size_t index;for(index=0;index<22;index++)if(!strcmp(bpf_program__name(program),required[index]))break;
  if(index==22||(seen&(1u<<index)))goto cleanup;seen|=1u<<index;
  struct bpf_link *link=bpf_program__attach(program);if(libbpf_get_error(link))goto cleanup;native[native_count++]=link;
 }
 if(native_count!=22||seen!=((1u<<22)-1))goto cleanup;
 phase="owned-inventory";
 if(inventory(&owner,monitor,watch,watch_count,"native-monitor-ids.txt")||
    inventory(&owner,producer,native,native_count,"native-producer-ids.txt"))goto cleanup;
 phase="output-open";
 owner.output=private_file(owner.directory,"native-events.jsonl",O_WRONLY|O_CREAT|O_EXCL|O_APPEND,0600);
 if(owner.output<0)goto cleanup;
 ring=ring_buffer__new(map_fd(producer,"events"),record_event,&owner,NULL);if(!ring)goto cleanup;
 if(send(owner.channel,"READY\n",6,MSG_NOSIGNAL)!=6)goto cleanup;
 phase="collect";
 int seal=0;
 while(healthy(&owner)){
  int consumed=ring_buffer__poll(ring,50);if(consumed<0&&consumed!=-EINTR)goto cleanup;
  char command[16];ssize_t length=recv(owner.channel,command,sizeof(command),MSG_DONTWAIT|MSG_TRUNC);
  if(length<0&&(errno==EAGAIN||errno==EWOULDBLOCK))continue;
  if(length!=5||memcmp(command,"SEAL\n",5))goto cleanup;seal=1;break;
 }
 phase="payload-quiescence";
 if(!seal||owned_tasks_absent(owner.uid)!=1)goto cleanup;
 phase="producer-detach";
 for(size_t i=0;i<native_count;i++){int result=bpf_link__destroy(native[i]);native[i]=NULL;if(result)goto cleanup;}
 control.armed=0;if(bpf_map_update_elem(map_fd(monitor,"control"),&zero,&control,BPF_ANY))goto cleanup;
 phase="retirement";
 while(healthy(&owner)){
  int complete=retirement_complete(monitor);if(complete<0)goto cleanup;if(complete)break;
  int consumed=ring_buffer__poll(ring,20);if(consumed<0&&consumed!=-EINTR)goto cleanup;
 }
 if(!healthy(&owner)||retirement_complete(monitor)!=1)goto cleanup;
 /* Trampoline retirement above and normal RCU for raw tracepoints are distinct. */
 phase="tracepoint-rcu";
 if(sysconf(_SC_NPROCESSORS_ONLN)<2||
    !(syscall(SYS_membarrier,MEMBARRIER_CMD_QUERY,0,0)&MEMBARRIER_CMD_GLOBAL)||
    syscall(SYS_membarrier,MEMBARRIER_CMD_GLOBAL,0,0))goto cleanup;
 phase="final-drain";
 int drained;while((drained=ring_buffer__consume(ring))>0)if(!healthy(&owner))goto cleanup;
 if(drained<0||program_misses(producer)||program_misses(monitor)||owned_tasks_absent(owner.uid)!=1)goto cleanup;
 phase="final-counters";
 struct ledger_metrics totals={0};if(final_counters(&owner,producer,&totals))goto cleanup;
 phase="output-sync";
 struct stat output_info;if(fstat(owner.output,&output_info)||output_info.st_nlink!=1||output_info.st_uid||
   output_info.st_size<0||(unsigned long long)output_info.st_size!=owner.bytes||fsync(owner.output))goto cleanup;
 if(close(owner.output)){owner.output=-1;goto cleanup;}owner.output=-1;
 phase="summary-sync";
 int summary=private_file(owner.directory,"native-drain.json",O_WRONLY|O_CREAT|O_EXCL,0600);if(summary<0)goto cleanup;
 int summary_bad=dprintf(summary,"{\"schema\":1,\"records\":%llu,\"bytes\":%llu,\"syscallEntries\":%llu,\"syscallExits\":%llu,\"nativeManifestAuthenticated\":false}\n",owner.received,owner.bytes,totals.syscall_entries,totals.syscall_exits)<0;
 if(fsync(summary))summary_bad=1;if(close(summary))summary_bad=1;if(summary_bad||fsync(owner.directory))goto cleanup;
 status=0;
cleanup:
 for(size_t i=0;i<native_count;i++)if(native[i]&&bpf_link__destroy(native[i]))status=1;
 for(size_t i=0;i<watch_count;i++)if(watch[i]&&bpf_link__destroy(watch[i]))status=1;
 if(ring)ring_buffer__free(ring);
 if(producer)bpf_object__close(producer);if(monitor)bpf_object__close(monitor);
 if(owner.output>=0&&close(owner.output))status=1;
 /* The guardian also requires terminal exit zero and owned-ID disappearance. */
 if(!status&&send(owner.channel,"DRAINED\n",8,MSG_NOSIGNAL)!=8)status=1;
 if(owner.channel>=0&&close(owner.channel))status=1;
 if(owner.guardian>=0&&close(owner.guardian))status=1;
 if(owner.directory>=0&&close(owner.directory))status=1;
 if(status)fprintf(stderr,"{\"code\":\"NATIVE_COLLECTOR_FAILED\",\"stage\":\"%s\"}\n",phase);
 free(owner.released);return status;
}
