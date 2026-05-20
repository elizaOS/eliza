#ifndef IREE_HAL_DRIVERS_ELIZANPU_DEVICE_H_
#define IREE_HAL_DRIVERS_ELIZANPU_DEVICE_H_

#include "iree/base/api.h"
#include "iree/hal/api.h"
#include "iree/hal/drivers/elizanpu/api.h"

// Returns the descriptor-ring state attached to |device|. The state is owned
// by the device and is shared by command buffers and semaphores. Tests use
// this entry point to assert ring placement and head/tail movement without
// requiring real MMIO.
struct iree_hal_elizanpu_device_state_t;
struct iree_hal_elizanpu_device_state_t* iree_hal_elizanpu_device_state(
    iree_hal_device_t* device);

#endif  // IREE_HAL_DRIVERS_ELIZANPU_DEVICE_H_
