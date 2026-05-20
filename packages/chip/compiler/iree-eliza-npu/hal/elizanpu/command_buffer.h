#ifndef IREE_HAL_DRIVERS_ELIZANPU_COMMAND_BUFFER_H_
#define IREE_HAL_DRIVERS_ELIZANPU_COMMAND_BUFFER_H_

#include "iree/base/api.h"
#include "iree/hal/api.h"

// Creates an elizanpu command buffer. Dispatches into `elizanpu.gemm_s8` and
// the other 4-bit opcodes from eliza_npu_runtime.h are translated into
// ring-bound descriptor words at record time (host-side encode) and submitted
// at queue_execute time (UNAVAILABLE today; succeeds end-to-end once a kernel
// uapi attaches MMIO callbacks to the device).
iree_status_t iree_hal_elizanpu_command_buffer_create(
    iree_hal_device_t* device, iree_hal_command_buffer_mode_t mode,
    iree_hal_command_category_t command_categories,
    iree_hal_queue_affinity_t queue_affinity, iree_host_size_t binding_capacity,
    iree_hal_command_buffer_t** out_command_buffer);

#endif  // IREE_HAL_DRIVERS_ELIZANPU_COMMAND_BUFFER_H_
