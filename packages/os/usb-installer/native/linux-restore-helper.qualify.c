/* Qualification-only access to the exact private helpers, never linked into
 * the shipped binary or installed outside the disposable VM. */
#define main elizaos_disabled_helper_main
#include "linux-restore-helper.c"
#undef main

int elizaos_qualify_consume(const char *plan_id, const char *binding) {
  struct request request = {0};
  if (!is_lower_hex(plan_id, 32U) || !is_lower_hex(binding, 64U)) return -3;
  memcpy(request.plan_id, plan_id, 33U);
  memcpy(request.plan_binding, binding, 65U);
  struct retained_authorization grant;
  int directory = -1;
  int result = validate_authorized_plan(&request, &directory, &grant);
  if (result != 0) return result;
  result = consume_authorized_plan(&request, directory, &grant);
  const int closed_grant = close_authorization(&grant);
  if (close(directory) != 0 || closed_grant != 0) return -1;
  return result;
}

int elizaos_qualify_partition(int whole_fd, const char *path,
                              uint32_t major_number, uint32_t minor_number,
                              uint64_t diskseq, uint64_t size_bytes) {
  struct request request = {.expected_major = major_number,
                            .expected_minor = minor_number,
                            .expected_diskseq = diskseq,
                            .expected_size_bytes = size_bytes};
  if (!valid_device_path(path) || strlen(path) >= sizeof(request.device_path))
    return -1;
  memcpy(request.device_path, path, strlen(path) + 1U);
  return open_verified_partition(&request, whole_fd);
}
