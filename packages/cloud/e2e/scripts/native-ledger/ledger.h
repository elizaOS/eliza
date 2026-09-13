/** Defines payload-free kernel records and independent completeness counters. */
#ifndef ELIZA_NATIVE_LEDGER_H
#define ELIZA_NATIVE_LEDGER_H
#define LEDGER_SCHEMA 1
struct ledger_filter_instruction {
  unsigned short code; unsigned char jt, jf; unsigned int k;
};
struct ledger_config {
  unsigned int target_uid, policy_length;
  struct ledger_filter_instruction policy[16];
  unsigned long long bwrap_device, bwrap_inode, runtime_device, runtime_inode;
};
struct ledger_bootstrap {
  unsigned long long bwrap_execs, runtime_execs, filter_attempts;
  unsigned long long filter_successes, filter_mismatches, unexpected_execs;
  unsigned long long initial_tgid, initial_start_ns, initial_namespace, sandbox_namespace;
};
struct ledger_role {
  unsigned long long thread, start_ns, parent_tgid, parent_start_ns, namespace_id;
  unsigned long long attach_success, syscall_success;
};
struct ledger_event {
  unsigned long long sequence, monotonic_ns, thread, socket_id;
  long long result;
  unsigned long long task_start_ns, parent_start_ns, parent_thread, namespace_id;
  unsigned int namespace_pid, parent_namespace_pid;
  unsigned int kind, nr, family, port, addr[4], flags, captured, operation;
};
struct ledger_metrics {
  unsigned long long emitted, ring_loss, socket_create_failure;
  unsigned long long socket_read_failure, socket_delete_failure;
  unsigned long long kernel_read_failure, unsupported_filter_change;
  unsigned long long syscall_entries, syscall_exits;
  unsigned long long filter_state_create_failure, filter_state_read_failure, filter_state_delete_failure;
  unsigned long long syscall_state_create_failure, syscall_state_read_failure, syscall_state_delete_failure;
  unsigned long long bootstrap_role_failure, bootstrap_network_failure;
};
enum ledger_kind {
  SYSCALL_ENTER = 1, SYSCALL_EXIT, CONNECT_ADDRESS, CONNECT_RESULT,
  MESSAGE_ENTER, MESSAGE_EXIT, SEND_ENTER, SEND_EXIT, SEND_SECURITY,
  SECCOMP_DENIED, SECCOMP_AUDIT, MESSAGE_COPY_RESULT, BATCH_RESULT,
  SENDTO_RESULT, STREAM_BEGIN, STREAM_RESULT, TCP_STATE, SOCKET_RELEASE,
  SOCKET_FREE, INBOUND_ACCEPT, BOOTSTRAP_EXEC, FILTER_ATTEMPT, FILTER_RESULT, FILTER_QUERY, FILTER_SYSCALL_RESULT
};
#endif
