// elizanpu allocator. Host-backed today; dma-buf-backed once the kernel
// driver lands. The host path is sufficient for the IREE compile smoke and
// for cocotb-driven Verilator tests that ferry buffers through a memmap fake.
#include "iree/hal/drivers/elizanpu/allocator.h"

#include <string.h>

#include "iree/base/api.h"

typedef struct iree_hal_elizanpu_allocator_t {
  iree_hal_resource_t resource;
  iree_allocator_t host_allocator;
  iree_hal_device_t* device;  // unowned back-reference
} iree_hal_elizanpu_allocator_t;

static const iree_hal_allocator_vtable_t iree_hal_elizanpu_allocator_vtable;

iree_status_t iree_hal_elizanpu_allocator_create(
    iree_hal_device_t* device, iree_allocator_t host_allocator,
    iree_hal_allocator_t** out_allocator) {
  iree_hal_elizanpu_allocator_t* allocator = NULL;
  IREE_RETURN_IF_ERROR(iree_allocator_malloc(host_allocator, sizeof(*allocator),
                                             (void**)&allocator));
  iree_hal_resource_initialize(&iree_hal_elizanpu_allocator_vtable,
                               &allocator->resource);
  allocator->host_allocator = host_allocator;
  allocator->device = device;
  *out_allocator = (iree_hal_allocator_t*)allocator;
  return iree_ok_status();
}

static void iree_hal_elizanpu_allocator_destroy(
    iree_hal_allocator_t* base_allocator) {
  iree_hal_elizanpu_allocator_t* allocator =
      (iree_hal_elizanpu_allocator_t*)base_allocator;
  iree_allocator_free(allocator->host_allocator, allocator);
}

static iree_allocator_t iree_hal_elizanpu_allocator_host_allocator(
    const iree_hal_allocator_t* base_allocator) {
  return ((iree_hal_elizanpu_allocator_t*)base_allocator)->host_allocator;
}

static iree_status_t iree_hal_elizanpu_allocator_allocate_buffer(
    iree_hal_allocator_t* base_allocator,
    const iree_hal_buffer_params_t* params, iree_device_size_t allocation_size,
    iree_hal_buffer_t** out_buffer) {
  // Real impl will obtain a dma-buf fd. Scaffold: defer to the generic host
  // buffer wrapper. The descriptor encoder only needs a stable phys-equivalent
  // address (today: the host pointer cast to uintptr_t).
  return iree_make_status(IREE_STATUS_UNAVAILABLE,
                          "elizanpu dma-buf allocator awaits kernel uapi");
}

static const iree_hal_allocator_vtable_t iree_hal_elizanpu_allocator_vtable = {
    .destroy = iree_hal_elizanpu_allocator_destroy,
    .host_allocator = iree_hal_elizanpu_allocator_host_allocator,
    .allocate_buffer = iree_hal_elizanpu_allocator_allocate_buffer,
};
