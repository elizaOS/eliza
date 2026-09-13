/** Watches exact native-loader trampoline images through the kernel's final work callback.
 * The loader arms this monitor after attaching its own links. Address reuse gets
 * a distinct generation; untracked callbacks never become foreign records.
 */
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>
#include "retirement.h"
struct { __uint(type, BPF_MAP_TYPE_ARRAY); __uint(max_entries, 1);
 __type(key, __u32); __type(value, struct retirement_control); } control SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_ARRAY); __uint(max_entries, 1);
 __type(key, __u32); __type(value, struct retirement_counters); } counters SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_HASH); __uint(max_entries, 256);
 __type(key, __u64); __type(value, __u64); } images SEC(".maps");
struct { __uint(type, BPF_MAP_TYPE_HASH); __uint(max_entries, 256);
 __type(key, __u64); __type(value, struct retirement_generation); } generations SEC(".maps");
SEC("fexit/bpf_trampoline_update")
int BPF_PROG(image_installed, struct bpf_trampoline *trampoline, bool lock_direct_mutex, int result) {
 __u32 zero = 0; struct retirement_control *admission = bpf_map_lookup_elem(&control, &zero);
 if (!admission || !admission->armed || admission->owner_thread != bpf_get_current_pid_tgid()) return 0;
 struct retirement_counters *m = bpf_map_lookup_elem(&counters, &zero); if (!m) return 0;
 struct bpf_tramp_image *image = 0;
 if (result || bpf_core_read(&image, sizeof(image), &trampoline->cur_image)) {
  __sync_fetch_and_add(&m->allocation_failure, 1); return 0;
 }
 /* A successful last-link removal installs no replacement image. */
 if (!image) return 0;
 __u64 address = (__u64)image;
 if (address >= (__u64)-4095) { __sync_fetch_and_add(&m->allocation_failure, 1); return 0; }
 __u64 generation = __sync_fetch_and_add(&m->allocated, 1) + 1;
 struct retirement_generation record = {.allocated_ns = bpf_ktime_get_ns()};
 if (bpf_map_update_elem(&generations, &generation, &record, BPF_NOEXIST))
  __sync_fetch_and_add(&m->history_failure, 1);
 if (bpf_map_update_elem(&images, &address, &generation, BPF_NOEXIST))
  __sync_fetch_and_add(&m->image_collision, 1);
 return 0;
}
SEC("fentry/__bpf_tramp_image_put_deferred")
int BPF_PROG(image_retired, struct work_struct *work) {
 __u64 address = (__u64)work - bpf_core_field_offset(struct bpf_tramp_image, work);
 __u64 *found = bpf_map_lookup_elem(&images, &address);
 if (!found) return 0;
 __u64 generation = *found; __u32 zero = 0;
 struct retirement_counters *m = bpf_map_lookup_elem(&counters, &zero); if (!m) return 0;
 struct retirement_generation *record = bpf_map_lookup_elem(&generations, &generation);
 if (!record) __sync_fetch_and_add(&m->lookup_failure, 1);
 else if (__sync_val_compare_and_swap(&record->retired_ns, 0, bpf_ktime_get_ns()))
  __sync_fetch_and_add(&m->duplicate_retirement, 1);
 else __sync_fetch_and_add(&m->retired, 1);
 if (bpf_map_delete_elem(&images, &address)) __sync_fetch_and_add(&m->delete_failure, 1);
 return 0;
}
char LICENSE[] SEC("license") = "GPL";
