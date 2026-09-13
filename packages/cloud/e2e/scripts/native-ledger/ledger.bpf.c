/** Observes owned native network attempts using kernel-copied addresses only.
 * Hooks are mandatory as a set. Numeric syscall metadata describes inputs that
 * fail before a kernel address exists; no tracee memory or payload is read.
 */
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>
#include "ledger.h"
const volatile struct ledger_config ledger_configuration = {};
struct { __uint(type, BPF_MAP_TYPE_ARRAY); __uint(max_entries, 1);
  __type(key, __u32); __type(value, struct ledger_bootstrap); } bootstrap SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY); __uint(max_entries, 1);
  __type(key, __u32); __type(value, struct ledger_metrics); } metrics SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_RINGBUF); __uint(max_entries, 1048576); } events SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_HASH); __uint(max_entries, 4096);
  __type(key, __u64); __type(value, __u64); } sockets SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_ARRAY); __uint(max_entries, 2);
  __type(key, __u32); __type(value, __u64); } serials SEC(".maps");
static __always_inline int own(void) { return (__u32)bpf_get_current_uid_gid() == ledger_configuration.target_uid; }
static __always_inline struct ledger_metrics *counters(void) {
  __u32 zero = 0; return bpf_map_lookup_elem(&metrics, &zero);
}
static __always_inline void emit(struct ledger_event *event) {
  struct ledger_metrics *m = counters(); __u32 index = 0;
  __u64 *sequence = bpf_map_lookup_elem(&serials, &index);
  if (!m || !sequence) return; /* Fixed array indices are admitted by the loader. */
  event->sequence = __sync_fetch_and_add(sequence, 1) + 1;
  event->monotonic_ns = bpf_ktime_get_ns(); event->thread = bpf_get_current_pid_tgid();
  struct ledger_event *output = bpf_ringbuf_reserve(&events, sizeof(*output), 0);
  if (!output) { __sync_fetch_and_add(&m->ring_loss, 1); return; }
  *output = *event; bpf_ringbuf_submit(output, 0); __sync_fetch_and_add(&m->emitted, 1);
}
static __always_inline void address(struct ledger_event *event, void *value, int length) {
  __u16 family = 0, port = 0; struct ledger_metrics *m = counters();
  if (!value || length < 2) return;
  if (bpf_probe_read_kernel(&family, sizeof(family), value)) goto failed;
  event->family = family;
  if (!((family == 2 && length >= 16) || (family == 10 && length >= 28))) return;
  if (bpf_probe_read_kernel(&port, sizeof(port), value + 2)) goto failed;
  event->port = __builtin_bswap16(port);
  if (family == 2) {
    if (bpf_probe_read_kernel(event->addr, 4, value + 4)) goto failed;
  } else if (bpf_probe_read_kernel(event->addr, 16, value + 8)) goto failed;
  event->captured = 1; return;
failed:
  if (m) __sync_fetch_and_add(&m->kernel_read_failure, 1);
}
static __always_inline __u64 identity(struct sock *socket, int create, int required) {
  __u64 key = (__u64)socket, *found = bpf_map_lookup_elem(&sockets, &key);
  struct ledger_metrics *m = counters();
  if (found) return *found;
  if (!create) {
    if (required && m) __sync_fetch_and_add(&m->socket_read_failure, 1);
    return 0;
  }
  __u32 index = 1; __u64 *serial = bpf_map_lookup_elem(&serials, &index);
  if (!socket || !serial) goto failed;
  __u64 next = __sync_fetch_and_add(serial, 1) + 1;
  if (!bpf_map_update_elem(&sockets, &key, &next, BPF_NOEXIST)) return next;
  /* Another owned thread can legitimately admit the same shared socket. */
  found = bpf_map_lookup_elem(&sockets, &key);
  if (found) return *found;
failed:
  if (m) __sync_fetch_and_add(&m->socket_create_failure, 1);
  return 0;
}
/* Kernel task/namespace identity makes bootstrap roles independently reviewable. */
static __always_inline int namespace_identity(struct task_struct *task, __u64 *identity, __u32 *number) {
  struct pid *pid = BPF_CORE_READ(task, thread_pid);
  unsigned int level = BPF_CORE_READ(pid, level);
  if (!pid || level > 32) return -1;
  struct upid value;
  if (bpf_core_read(&value, sizeof(value), &pid->numbers[level])) return -1;
  *number = value.nr;
  *identity = BPF_CORE_READ(value.ns, ns.inum);
  return *identity && *number ? 0 : -1;
}
static __always_inline void bootstrap_identity(struct ledger_event *event, struct task_struct *task) {
  struct task_struct *parent = BPF_CORE_READ(task, real_parent);
  event->task_start_ns = BPF_CORE_READ(task, start_boottime);
  event->parent_start_ns = BPF_CORE_READ(parent, start_boottime);
  event->parent_thread = BPF_CORE_READ(parent, tgid);
  __u64 parent_namespace = 0;
  if (namespace_identity(task, &event->namespace_id, &event->namespace_pid) ||
      namespace_identity(parent, &parent_namespace, &event->parent_namespace_pid)) {
    __u32 zero = 0; struct ledger_metrics *m = bpf_map_lookup_elem(&metrics, &zero);
    if (m) __sync_fetch_and_add(&m->kernel_read_failure, 1);
  }
}
static __always_inline int executable_is(struct file *file, __u64 device, __u64 inode) {
  struct inode *node = BPF_CORE_READ(file, f_inode);
  return node && BPF_CORE_READ(node, i_ino) == inode &&
    BPF_CORE_READ(node, i_sb, s_dev) == device;
}
struct filter_call { __u32 nr, operation, flags, mutation, role; };
struct { __uint(type, BPF_MAP_TYPE_HASH); __uint(max_entries, 2);
  __type(key, __u32); __type(value, struct ledger_role); } roles SEC(".maps");
/* The two roles are identified by kernel lineage, never by arrival order. */
static __always_inline __u32 admit_filter_role(struct task_struct *task) {
  __u32 zero = 0; struct ledger_bootstrap *boot = bpf_map_lookup_elem(&bootstrap, &zero);
  if (!boot || boot->bwrap_execs != 1 || !boot->initial_tgid ||
      !executable_is(BPF_CORE_READ(task, mm, exe_file), ledger_configuration.bwrap_device, ledger_configuration.bwrap_inode)) return 0;
  __u64 ns = 0, parent_ns = 0; __u32 number = 0, parent_number = 0;
  struct task_struct *parent = BPF_CORE_READ(task, real_parent);
  if (namespace_identity(task, &ns, &number) || namespace_identity(parent, &parent_ns, &parent_number) ||
      ns == boot->initial_namespace || (number != 1 && number != 2) ||
      BPF_CORE_READ(task, pid) != BPF_CORE_READ(task, tgid) ||
      !executable_is(BPF_CORE_READ(parent, mm, exe_file), ledger_configuration.bwrap_device, ledger_configuration.bwrap_inode)) return 0;
  struct task_struct *ancestor = parent;
  if (number == 2) {
    if (parent_number != 1 || parent_ns != ns) return 0;
    ancestor = BPF_CORE_READ(parent, real_parent);
  }
  if (BPF_CORE_READ(ancestor, tgid) != boot->initial_tgid ||
      BPF_CORE_READ(ancestor, start_boottime) != boot->initial_start_ns) return 0;
  __u64 existing = __sync_val_compare_and_swap(&boot->sandbox_namespace, 0, ns);
  if (existing && existing != ns) return 0;
  struct ledger_role role = {.thread = bpf_get_current_pid_tgid(),
    .start_ns = BPF_CORE_READ(task, start_boottime), .parent_tgid = BPF_CORE_READ(parent, tgid),
    .parent_start_ns = BPF_CORE_READ(parent, start_boottime), .namespace_id = ns};
  if (bpf_map_update_elem(&roles, &number, &role, BPF_NOEXIST)) return 0;
  return number;
}
struct { __uint(type, BPF_MAP_TYPE_HASH); __uint(max_entries, 4096);
  __type(key, __u64); __type(value, struct filter_call); } filter_calls SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_HASH); __uint(max_entries, 4096);
  __type(key, __u64); __type(value, __u64); } network_calls SEC(".maps");
static __always_inline int network_syscall(long nr) {
  return nr == 41 || nr == 42 || nr == 43 || nr == 44 || nr == 46 ||
    nr == 288 || nr == 307 || nr == 425 || nr == 426 || nr == 427;
}
SEC("tracepoint/raw_syscalls/sys_enter")
int syscall_enter(struct trace_event_raw_sys_enter *ctx) {
  if (!own()) return 0;
  long syscall_nr = BPF_CORE_READ(ctx, id);
  struct ledger_metrics *m = counters();
  unsigned long argument_zero = BPF_CORE_READ(ctx, args[0]);
  unsigned long argument_one = BPF_CORE_READ(ctx, args[1]);
  /* Queries are observed without changing the bootstrap policy state. */
  if (syscall_nr == 317 || (syscall_nr == 157 && argument_zero == 22)) {
    __u64 thread = bpf_get_current_pid_tgid();
    struct filter_call call = {.nr = syscall_nr,
      .operation = syscall_nr == 157 ? argument_one : argument_zero,
      .flags = syscall_nr == 317 ? argument_one : 0,
      .mutation = syscall_nr == 157 || argument_zero <= 1};
    int query = syscall_nr == 317 && (argument_zero == 2 || argument_zero == 3);
    if (!call.mutation && !query && m)
      __sync_fetch_and_add(&m->unsupported_filter_change, 1);
    if (call.mutation) {
      __u32 zero = 0;
      struct ledger_bootstrap *boot = bpf_map_lookup_elem(&bootstrap, &zero);
      if (boot) __sync_fetch_and_add(&boot->filter_attempts, 1);
      if (call.nr == 157 && call.operation == 2 && !call.flags)
        call.role = admit_filter_role(bpf_get_current_task_btf());
      if (!call.role && m) __sync_fetch_and_add(&m->unsupported_filter_change, 1);
    }
    if (bpf_map_update_elem(&filter_calls, &thread, &call, BPF_NOEXIST) && m)
      __sync_fetch_and_add(&m->filter_state_create_failure, 1);
    struct ledger_event event = {.kind = query ? FILTER_QUERY : FILTER_ATTEMPT,
      .nr = syscall_nr, .operation = call.operation, .flags = call.flags};
    emit(&event);
  }
  if (!network_syscall(syscall_nr)) return 0;
  __u32 zero = 0; struct ledger_bootstrap *boot = bpf_map_lookup_elem(&bootstrap, &zero);
  if ((!boot || !boot->runtime_execs) && m) __sync_fetch_and_add(&m->bootstrap_network_failure, 1);
  __u64 thread = bpf_get_current_pid_tgid(), number = syscall_nr;
  if (bpf_map_update_elem(&network_calls, &thread, &number, BPF_NOEXIST) && m)
    __sync_fetch_and_add(&m->syscall_state_create_failure, 1);
  struct ledger_event event = {.kind = SYSCALL_ENTER, .nr = syscall_nr};
  if (m) __sync_fetch_and_add(&m->syscall_entries, 1);
  emit(&event); return 0;
}
SEC("tracepoint/raw_syscalls/sys_exit")
int syscall_exit(struct trace_event_raw_sys_exit *ctx) {
  if (!own()) return 0;
  long syscall_nr = BPF_CORE_READ(ctx, id);
  struct ledger_metrics *m = counters();
  if (syscall_nr == 317 || syscall_nr == 157) {
    __u64 thread = bpf_get_current_pid_tgid();
    struct filter_call *call = bpf_map_lookup_elem(&filter_calls, &thread);
    if (call) {
      struct ledger_event filter_event = {.kind = FILTER_SYSCALL_RESULT,
        .nr = call->nr, .operation = call->operation, .flags = call->flags, .captured = call->mutation,
        .result = BPF_CORE_READ(ctx, ret)};
      if (call->role) {
        struct ledger_role *role = bpf_map_lookup_elem(&roles, &call->role);
        if (!role || role->thread != thread || !role->attach_success || filter_event.result ||
            __sync_val_compare_and_swap(&role->syscall_success, 0, 1)) {
          if (m) __sync_fetch_and_add(&m->bootstrap_role_failure, 1);
        }
      }
      emit(&filter_event);
      if (bpf_map_delete_elem(&filter_calls, &thread) && m)
        __sync_fetch_and_add(&m->filter_state_delete_failure, 1);
    } else if (syscall_nr == 317 && m)
      __sync_fetch_and_add(&m->filter_state_read_failure, 1);
  }
  if (!network_syscall(syscall_nr)) return 0;
  __u64 thread = bpf_get_current_pid_tgid();
  __u64 *number = bpf_map_lookup_elem(&network_calls, &thread);
  if ((!number || *number != syscall_nr) && m)
    __sync_fetch_and_add(&m->syscall_state_read_failure, 1);
  if (number && bpf_map_delete_elem(&network_calls, &thread) && m)
    __sync_fetch_and_add(&m->syscall_state_delete_failure, 1);
  struct ledger_event event = {.kind = SYSCALL_EXIT, .nr = syscall_nr, .result = BPF_CORE_READ(ctx, ret)};
  if (m) __sync_fetch_and_add(&m->syscall_exits, 1);
  emit(&event); return 0;
}
SEC("fentry/security_socket_connect")
int BPF_PROG(connect_address, struct socket *socket, void *value, int length) {
  if (!own()) return 0;
  struct ledger_event event = {.kind = CONNECT_ADDRESS};
  address(&event, value, length); emit(&event); return 0;
}
SEC("fexit/__sys_connect")
int BPF_PROG(connect_result, int fd, void *value, int length, int result) {
  if (!own()) return 0;
  struct ledger_event event = {.kind = CONNECT_RESULT, .nr = fd, .result = result};
  emit(&event); return 0;
}
SEC("fentry/____sys_sendmsg")
int BPF_PROG(message_enter, struct socket *socket, struct msghdr *message, unsigned int flags, void *used, unsigned int allowed) {
  if (!own()) return 0;
  struct ledger_event event = {.kind = MESSAGE_ENTER, .flags = flags};
  address(&event, BPF_CORE_READ(message, msg_name), BPF_CORE_READ(message, msg_namelen)); emit(&event); return 0;
}
SEC("fexit/____sys_sendmsg")
int BPF_PROG(message_exit, struct socket *socket, struct msghdr *message, unsigned int flags, void *used, unsigned int allowed, int result) {
  if (!own()) return 0;
  struct ledger_event event = {.kind = MESSAGE_EXIT, .result = result}; emit(&event); return 0;
}
SEC("fentry/sock_sendmsg")
int BPF_PROG(send_enter, struct socket *socket, struct msghdr *message) {
  if (!own()) return 0;
  struct ledger_event event = {.kind = SEND_ENTER, .flags = BPF_CORE_READ(message, msg_flags)};
  address(&event, BPF_CORE_READ(message, msg_name), BPF_CORE_READ(message, msg_namelen)); emit(&event); return 0;
}
SEC("fexit/sock_sendmsg")
int BPF_PROG(send_exit, struct socket *socket, struct msghdr *message, int result) {
  if (!own()) return 0;
  struct ledger_event event = {.kind = SEND_EXIT, .result = result}; emit(&event); return 0;
}
SEC("fentry/security_socket_sendmsg")
int BPF_PROG(send_security, void *socket, struct msghdr *message, int length) {
  if (!own()) return 0;
  struct ledger_event event = {.kind = SEND_SECURITY, .flags = BPF_CORE_READ(message, msg_flags)};
  address(&event, BPF_CORE_READ(message, msg_name), BPF_CORE_READ(message, msg_namelen)); emit(&event); return 0;
}
SEC("fexit/__seccomp_filter")
int BPF_PROG(seccomp_denied, int nr, void *data, bool recheck, int result) {
  if (!own() || result != -1) return 0;
  struct task_struct *task = bpf_get_current_task_btf();
  struct pt_regs *registers = (void *)bpf_task_pt_regs(task);
  struct ledger_event event = {.kind = SECCOMP_DENIED, .nr = nr, .result = BPF_CORE_READ(registers, ax)};
  emit(&event); return 0;
}
SEC("fentry/audit_seccomp")
int BPF_PROG(seccomp_audit, unsigned long nr, long sig, unsigned int action) {
  if (!own()) return 0;
  struct ledger_event event = {.kind = SECCOMP_AUDIT, .nr = nr, .flags = action, .result = sig};
  emit(&event); return 0;
}
SEC("fexit/___sys_sendmsg")
int BPF_PROG(message_copy_result, void *socket, void *user, void *message, unsigned int flags, void *used, unsigned int allowed, int result) {
  if (!own()) return 0;
  struct ledger_event event = {.kind = MESSAGE_COPY_RESULT, .result = result}; emit(&event); return 0;
}
SEC("fexit/__sys_sendmmsg")
int BPF_PROG(batch_result, int fd, void *messages, unsigned int count, unsigned int flags, bool compat, int result) {
  if (!own()) return 0;
  struct ledger_event event = {.kind = BATCH_RESULT, .nr = count, .result = result}; emit(&event); return 0;
}
SEC("fexit/__sys_sendto")
int BPF_PROG(sendto_result, int fd, void *buffer, unsigned long length, unsigned int flags, void *value, int address_length, int result) {
  if (!own()) return 0;
  struct ledger_event event = {.kind = SENDTO_RESULT, .result = result}; emit(&event); return 0;
}
SEC("fentry/inet_stream_connect")
int BPF_PROG(stream_begin, struct socket *socket, void *value, int length, int flags) {
  if (!own()) return 0;
  struct ledger_event event = {.kind = STREAM_BEGIN, .socket_id = identity(BPF_CORE_READ(socket, sk), 1, 1)};
  address(&event, value, length); emit(&event); return 0;
}
SEC("fexit/inet_stream_connect")
int BPF_PROG(stream_result, struct socket *socket, void *value, int length, int flags, int result) {
  if (!own()) return 0;
  struct ledger_event event = {.kind = STREAM_RESULT, .result = result, .socket_id = identity(BPF_CORE_READ(socket, sk), 0, 1)};
  emit(&event); return 0;
}
SEC("fentry/tcp_set_state")
int BPF_PROG(tcp_state, struct sock *socket, int next) {
  __u64 id = identity(socket, 0, 0); if (!id) return 0;
  struct ledger_event event = {.kind = TCP_STATE, .socket_id = id, .nr = BPF_CORE_READ(socket, __sk_common.skc_state), .result = next, .flags = BPF_CORE_READ(socket, sk_err)};
  emit(&event); return 0;
}
SEC("fentry/inet_release")
int BPF_PROG(socket_release, struct socket *socket) {
  __u64 id = identity(BPF_CORE_READ(socket, sk), 0, 0); if (!id) return 0;
  struct ledger_event event = {.kind = SOCKET_RELEASE, .socket_id = id}; emit(&event); return 0;
}
SEC("fentry/__sk_free")
int BPF_PROG(socket_free, struct sock *socket) {
  __u64 key = (__u64)socket, id = identity(socket, 0, 0); if (!id) return 0;
  struct ledger_event event = {.kind = SOCKET_FREE, .socket_id = id}; emit(&event);
  if (bpf_map_delete_elem(&sockets, &key)) {
    struct ledger_metrics *m = counters(); if (m) __sync_fetch_and_add(&m->socket_delete_failure, 1);
  }
  return 0;
}
SEC("fexit/inet_accept")
int BPF_PROG(inbound_accept, struct socket *socket, struct socket *accepted, int flags, bool kernel, int result) {
  if (!own() || result) return 0;
  struct ledger_event event = {.kind = INBOUND_ACCEPT, .socket_id = identity(BPF_CORE_READ(accepted, sk), 1, 1)};
  emit(&event); return 0;
}

SEC("tp_btf/sched_process_exec")
int BPF_PROG(bootstrap_exec, struct task_struct *task, pid_t old_pid, struct linux_binprm *parameters) {
  if (!own()) return 0;
  __u32 zero = 0; struct ledger_bootstrap *boot = bpf_map_lookup_elem(&bootstrap, &zero);
  if (!boot) return 0;
  struct file *file = BPF_CORE_READ(parameters, file);
  struct ledger_event event = {.kind = BOOTSTRAP_EXEC};
  bootstrap_identity(&event, task);
  /* Once the exact initial runtime is admitted, later execs are payload work. */
  if (boot->runtime_execs) return 0;
  if (executable_is(file, ledger_configuration.bwrap_device, ledger_configuration.bwrap_inode) &&
      __sync_val_compare_and_swap(&boot->bwrap_execs, 0, 1) == 0) {
    boot->initial_tgid = BPF_CORE_READ(task, tgid);
    boot->initial_start_ns = event.task_start_ns;
    boot->initial_namespace = event.namespace_id;
    event.flags = 1;
  } else {
    __u32 payload = 2; struct ledger_role *role = bpf_map_lookup_elem(&roles, &payload);
    if (executable_is(file, ledger_configuration.runtime_device, ledger_configuration.runtime_inode) &&
        role && role->thread == bpf_get_current_pid_tgid() && role->start_ns == event.task_start_ns &&
        role->namespace_id == event.namespace_id && event.namespace_pid == 2 &&
        role->parent_tgid == event.parent_thread && role->parent_start_ns == event.parent_start_ns &&
        role->attach_success == 1 && role->syscall_success == 1 &&
        __sync_val_compare_and_swap(&boot->runtime_execs, 0, 1) == 0) event.flags = 2;
    else __sync_fetch_and_add(&boot->unexpected_execs, 1);
  }
  emit(&event); return 0;
}
SEC("fexit/seccomp_attach_filter")
int BPF_PROG(bootstrap_filter, unsigned int flags, struct seccomp_filter *filter, long result) {
  if (!own()) return 0;
  __u32 zero = 0; struct ledger_bootstrap *boot = bpf_map_lookup_elem(&bootstrap, &zero);
  struct ledger_event event = {.kind = FILTER_RESULT, .flags = flags, .result = result};
  struct task_struct *task = bpf_get_current_task_btf();
  bootstrap_identity(&event, task);
  struct sock_fprog_kern *original = BPF_CORE_READ(filter, prog, orig_prog);
  struct ledger_filter_instruction copied[16];
  __u64 thread = bpf_get_current_pid_tgid();
  struct filter_call *call = bpf_map_lookup_elem(&filter_calls, &thread);
  struct ledger_role *role = call && call->role ? bpf_map_lookup_elem(&roles, &call->role) : 0;
  int matched = boot && !flags && !result && boot->bwrap_execs == 1 &&
    role && role->thread == thread && role->start_ns == event.task_start_ns &&
    role->namespace_id == event.namespace_id && !role->attach_success &&
    executable_is(BPF_CORE_READ(task, mm, exe_file), ledger_configuration.bwrap_device, ledger_configuration.bwrap_inode) &&
    original && BPF_CORE_READ(original, len) == 16 && ledger_configuration.policy_length == 16;
  if (matched && bpf_probe_read_kernel(copied, sizeof(copied), BPF_CORE_READ(original, filter))) matched = 0;
#pragma unroll
  for (int index = 0; index < 16; index++) {
    if (matched && (copied[index].code != ledger_configuration.policy[index].code ||
        copied[index].jt != ledger_configuration.policy[index].jt || copied[index].jf != ledger_configuration.policy[index].jf ||
        copied[index].k != ledger_configuration.policy[index].k)) matched = 0;
  }
  if (matched && __sync_val_compare_and_swap(&role->attach_success, 0, 1)) matched = 0;
  if (boot) {
    if (matched) __sync_fetch_and_add(&boot->filter_successes, 1);
    else __sync_fetch_and_add(&boot->filter_mismatches, 1);
  }
  event.captured = matched; emit(&event); return 0;
}

char LICENSE[] SEC("license") = "GPL";
