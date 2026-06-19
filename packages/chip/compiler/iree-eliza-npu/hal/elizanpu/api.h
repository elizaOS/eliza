// elizanpu HAL driver public C ABI.
//
// Mirrors the pattern of `runtime/src/iree/hal/drivers/null/api.h` from IREE.
// Real driver/device options remain intentionally small until the kernel
// driver uapi is published.
#ifndef IREE_HAL_DRIVERS_ELIZANPU_API_H_
#define IREE_HAL_DRIVERS_ELIZANPU_API_H_

#include "iree/base/api.h"
#include "iree/hal/api.h"

#ifdef __cplusplus
extern "C" {
#endif

// MMIO base override for non-default platforms (Verilator, FPGA bring-up,
// hypothetical multi-instance silicon). Zero means "use the value from
// eliza_npu_runtime.h".
typedef struct iree_hal_elizanpu_device_options_t {
  uint64_t mmio_base_override;
  // Descriptor ring entries used by this device. Must equal
  // ELIZA_NPU_DESC_RING_ENTRIES (8); exposed only so future silicon revisions
  // can grow the ring without changing the public ABI.
  uint32_t ring_entries;
  // Polling budget for descriptor completion before reporting timeout.
  uint32_t completion_timeout_polls;
} iree_hal_elizanpu_device_options_t;

IREE_API_EXPORT void iree_hal_elizanpu_device_options_initialize(
    iree_hal_elizanpu_device_options_t* out_options);

IREE_API_EXPORT iree_status_t iree_hal_elizanpu_device_create(
    iree_string_view_t identifier,
    const iree_hal_elizanpu_device_options_t* options,
    const iree_hal_device_create_params_t* create_params,
    iree_allocator_t host_allocator, iree_hal_device_t** out_device);

typedef struct iree_hal_elizanpu_driver_options_t {
  iree_hal_elizanpu_device_options_t default_device_options;
} iree_hal_elizanpu_driver_options_t;

IREE_API_EXPORT void iree_hal_elizanpu_driver_options_initialize(
    iree_hal_elizanpu_driver_options_t* out_options);

IREE_API_EXPORT iree_status_t iree_hal_elizanpu_driver_create(
    iree_string_view_t identifier,
    const iree_hal_elizanpu_driver_options_t* options,
    iree_allocator_t host_allocator, iree_hal_driver_t** out_driver);

#ifdef __cplusplus
}
#endif

#endif  // IREE_HAL_DRIVERS_ELIZANPU_API_H_
