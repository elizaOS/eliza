#ifndef IREE_HAL_DRIVERS_ELIZANPU_ALLOCATOR_H_
#define IREE_HAL_DRIVERS_ELIZANPU_ALLOCATOR_H_

#include "iree/base/api.h"
#include "iree/hal/api.h"

// DMA-buf-style allocator stub.
//
// The real allocator will:
//  - Open the `/dev/eliza_npu` chardev,
//  - Issue ELIZA_NPU_IOCTL_DMABUF_ALLOC with the requested size + alignment,
//  - Mmap the returned dma-buf fd into host space for staging.
//
// Today it just wraps iree_allocator_t host allocations and tags the buffer
// with the descriptor metadata fields needed for tile_dma encoding.
iree_status_t iree_hal_elizanpu_allocator_create(
    iree_hal_device_t* device, iree_allocator_t host_allocator,
    iree_hal_allocator_t** out_allocator);

#endif  // IREE_HAL_DRIVERS_ELIZANPU_ALLOCATOR_H_
