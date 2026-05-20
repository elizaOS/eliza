// elizanpu HAL device.
//
// The device owns:
//   - the host-side mirror of the 8-entry descriptor ring (per the
//     ELIZA_NPU_DESC_RING_ENTRIES contract in eliza_npu_runtime.h),
//   - an MMIO callback pair installed by the kernel uapi (today a no-op set
//     that returns UNAVAILABLE on submission, so compile/load can complete
//     even on a host with no NPU),
//   - the allocator that hands out DMA-buf-style buffers.
//
// Execution paths are deliberately stubbed: this driver is a scaffold so the
// IREE compile path (`--iree-hal-target-backends=elizanpu`) can produce a
// .vmfb that loads, even though no real hardware exists yet.
#include "iree/hal/drivers/elizanpu/device.h"

#include <string.h>

#include "../../runtime/eliza_npu_runtime.h"
#include "iree/base/api.h"
#include "iree/hal/api.h"
#include "iree/hal/drivers/elizanpu/allocator.h"
#include "iree/hal/drivers/elizanpu/command_buffer.h"
#include "iree/hal/drivers/elizanpu/event.h"
#include "iree/hal/drivers/elizanpu/executable_cache.h"
#include "iree/hal/drivers/elizanpu/semaphore.h"

typedef struct iree_hal_elizanpu_device_state_t {
  // Host-side ring mirror. Head/tail advance via command-buffer submit.
  eliza_npu_descriptor_words_t ring[ELIZA_NPU_DESC_RING_ENTRIES];
  uint32_t head;
  uint32_t tail;
  // MMIO callbacks; null until the kernel driver attaches.
  eliza_npu_mmio_t mmio;
  uint64_t mmio_base;
  uint32_t completion_timeout_polls;
} iree_hal_elizanpu_device_state_t;

typedef struct iree_hal_elizanpu_device_t {
  iree_hal_resource_t resource;
  iree_string_view_t identifier;
  iree_allocator_t host_allocator;
  iree_hal_allocator_t* device_allocator;
  iree_hal_elizanpu_device_state_t state;
} iree_hal_elizanpu_device_t;

static const iree_hal_device_vtable_t iree_hal_elizanpu_device_vtable;

static iree_hal_elizanpu_device_t* iree_hal_elizanpu_device_cast(
    iree_hal_device_t* base_value) {
  IREE_HAL_ASSERT_TYPE(base_value, &iree_hal_elizanpu_device_vtable);
  return (iree_hal_elizanpu_device_t*)base_value;
}

IREE_API_EXPORT void iree_hal_elizanpu_device_options_initialize(
    iree_hal_elizanpu_device_options_t* out_options) {
  memset(out_options, 0, sizeof(*out_options));
  out_options->mmio_base_override = 0;
  out_options->ring_entries = ELIZA_NPU_DESC_RING_ENTRIES;
  out_options->completion_timeout_polls = 1u << 20;  // ~1M polls
}

IREE_API_EXPORT iree_status_t iree_hal_elizanpu_device_create(
    iree_string_view_t identifier,
    const iree_hal_elizanpu_device_options_t* options,
    const iree_hal_device_create_params_t* create_params,
    iree_allocator_t host_allocator, iree_hal_device_t** out_device) {
  IREE_ASSERT_ARGUMENT(options);
  IREE_ASSERT_ARGUMENT(out_device);
  *out_device = NULL;

  if (options->ring_entries != ELIZA_NPU_DESC_RING_ENTRIES) {
    return iree_make_status(IREE_STATUS_INVALID_ARGUMENT,
                            "elizanpu ring_entries=%u; contract requires %d",
                            options->ring_entries,
                            ELIZA_NPU_DESC_RING_ENTRIES);
  }

  iree_hal_elizanpu_device_t* device = NULL;
  iree_host_size_t total_size = sizeof(*device) + identifier.size;
  IREE_RETURN_IF_ERROR(
      iree_allocator_malloc(host_allocator, total_size, (void**)&device));
  iree_hal_resource_initialize(&iree_hal_elizanpu_device_vtable,
                               &device->resource);
  device->host_allocator = host_allocator;
  uint8_t* buffer_ptr = (uint8_t*)device + sizeof(*device);
  device->identifier = iree_make_string_view(
      (const char*)memcpy(buffer_ptr, identifier.data, identifier.size),
      identifier.size);

  device->state.head = 0;
  device->state.tail = 0;
  memset(&device->state.ring, 0, sizeof(device->state.ring));
  memset(&device->state.mmio, 0, sizeof(device->state.mmio));
  device->state.mmio_base = options->mmio_base_override
                                ? options->mmio_base_override
                                : (uint64_t)ELIZA_NPU_MMIO_BASE;
  device->state.completion_timeout_polls = options->completion_timeout_polls;

  iree_status_t status = iree_hal_elizanpu_allocator_create(
      (iree_hal_device_t*)device, host_allocator, &device->device_allocator);

  if (iree_status_is_ok(status)) {
    *out_device = (iree_hal_device_t*)device;
  } else {
    iree_allocator_free(host_allocator, device);
  }
  return status;
}

struct iree_hal_elizanpu_device_state_t* iree_hal_elizanpu_device_state(
    iree_hal_device_t* base_device) {
  iree_hal_elizanpu_device_t* device =
      iree_hal_elizanpu_device_cast(base_device);
  return &device->state;
}

static void iree_hal_elizanpu_device_destroy(iree_hal_device_t* base_device) {
  iree_hal_elizanpu_device_t* device =
      iree_hal_elizanpu_device_cast(base_device);
  iree_hal_allocator_release(device->device_allocator);
  iree_allocator_free(device->host_allocator, device);
}

static iree_string_view_t iree_hal_elizanpu_device_id(
    iree_hal_device_t* base_device) {
  return iree_hal_elizanpu_device_cast(base_device)->identifier;
}

static iree_allocator_t iree_hal_elizanpu_device_host_allocator(
    iree_hal_device_t* base_device) {
  return iree_hal_elizanpu_device_cast(base_device)->host_allocator;
}

static iree_hal_allocator_t* iree_hal_elizanpu_device_allocator(
    iree_hal_device_t* base_device) {
  return iree_hal_elizanpu_device_cast(base_device)->device_allocator;
}

// All execution entry points report UNAVAILABLE until the kernel uapi binding
// installs real MMIO callbacks. This is intentional: scaffold today,
// fail-closed at runtime, but compile+load paths succeed.
#define ELIZANPU_UNAVAILABLE \
  iree_make_status(IREE_STATUS_UNAVAILABLE, \
                   "elizanpu hardware binding not yet attached")

static iree_status_t iree_hal_elizanpu_device_create_command_buffer(
    iree_hal_device_t* base_device, iree_hal_command_buffer_mode_t mode,
    iree_hal_command_category_t command_categories,
    iree_hal_queue_affinity_t queue_affinity, iree_host_size_t binding_capacity,
    iree_hal_command_buffer_t** out_command_buffer) {
  return iree_hal_elizanpu_command_buffer_create(
      base_device, mode, command_categories, queue_affinity, binding_capacity,
      out_command_buffer);
}

static iree_status_t iree_hal_elizanpu_device_create_executable_cache(
    iree_hal_device_t* base_device, iree_string_view_t identifier,
    iree_loop_t loop, iree_hal_executable_cache_t** out_executable_cache) {
  return iree_hal_elizanpu_executable_cache_create(
      base_device, identifier, out_executable_cache);
}

static iree_status_t iree_hal_elizanpu_device_create_semaphore(
    iree_hal_device_t* base_device, uint64_t initial_value,
    iree_hal_semaphore_flags_t flags, iree_hal_semaphore_t** out_semaphore) {
  return iree_hal_elizanpu_semaphore_create(base_device, initial_value, flags,
                                            out_semaphore);
}

static iree_status_t iree_hal_elizanpu_device_create_event(
    iree_hal_device_t* base_device, iree_hal_event_flags_t flags,
    iree_hal_event_t** out_event) {
  return iree_hal_elizanpu_event_create(base_device, flags, out_event);
}

static iree_status_t iree_hal_elizanpu_device_queue_execute(
    iree_hal_device_t* base_device, iree_hal_queue_affinity_t queue_affinity,
    const iree_hal_semaphore_list_t wait_semaphore_list,
    const iree_hal_semaphore_list_t signal_semaphore_list,
    iree_hal_command_buffer_t* command_buffer,
    iree_hal_buffer_binding_table_t binding_table) {
  return ELIZANPU_UNAVAILABLE;
}

static const iree_hal_device_vtable_t iree_hal_elizanpu_device_vtable = {
    .destroy = iree_hal_elizanpu_device_destroy,
    .id = iree_hal_elizanpu_device_id,
    .host_allocator = iree_hal_elizanpu_device_host_allocator,
    .device_allocator = iree_hal_elizanpu_device_allocator,
    .create_command_buffer = iree_hal_elizanpu_device_create_command_buffer,
    .create_executable_cache = iree_hal_elizanpu_device_create_executable_cache,
    .create_semaphore = iree_hal_elizanpu_device_create_semaphore,
    .create_event = iree_hal_elizanpu_device_create_event,
    .queue_execute = iree_hal_elizanpu_device_queue_execute,
};

#undef ELIZANPU_UNAVAILABLE
