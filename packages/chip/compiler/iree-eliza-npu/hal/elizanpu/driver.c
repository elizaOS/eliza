// elizanpu HAL driver factory.
//
// Single-device driver: enumeration always returns the default e1 NPU.
// Multi-instance support is gated on a uapi extension that does not exist
// yet; until then the driver behaves like the `null` skeleton driver but
// with our identifier.
#include "iree/hal/drivers/elizanpu/driver.h"

#include <string.h>

#include "iree/base/api.h"
#include "iree/hal/api.h"
#include "iree/hal/drivers/elizanpu/api.h"

#define IREE_HAL_ELIZANPU_DEVICE_ID_DEFAULT 0

typedef struct iree_hal_elizanpu_driver_t {
  iree_hal_resource_t resource;
  iree_allocator_t host_allocator;
  iree_string_view_t identifier;
  iree_hal_elizanpu_driver_options_t options;
} iree_hal_elizanpu_driver_t;

static const iree_hal_driver_vtable_t iree_hal_elizanpu_driver_vtable;

static iree_hal_elizanpu_driver_t* iree_hal_elizanpu_driver_cast(
    iree_hal_driver_t* base_value) {
  IREE_HAL_ASSERT_TYPE(base_value, &iree_hal_elizanpu_driver_vtable);
  return (iree_hal_elizanpu_driver_t*)base_value;
}

IREE_API_EXPORT void iree_hal_elizanpu_driver_options_initialize(
    iree_hal_elizanpu_driver_options_t* out_options) {
  memset(out_options, 0, sizeof(*out_options));
  iree_hal_elizanpu_device_options_initialize(
      &out_options->default_device_options);
}

IREE_API_EXPORT iree_status_t iree_hal_elizanpu_driver_create(
    iree_string_view_t identifier,
    const iree_hal_elizanpu_driver_options_t* options,
    iree_allocator_t host_allocator, iree_hal_driver_t** out_driver) {
  IREE_ASSERT_ARGUMENT(options);
  IREE_ASSERT_ARGUMENT(out_driver);
  *out_driver = NULL;

  iree_hal_elizanpu_driver_t* driver = NULL;
  iree_host_size_t total_size = sizeof(*driver) + identifier.size;
  IREE_RETURN_IF_ERROR(
      iree_allocator_malloc(host_allocator, total_size, (void**)&driver));
  iree_hal_resource_initialize(&iree_hal_elizanpu_driver_vtable,
                               &driver->resource);
  driver->host_allocator = host_allocator;
  uint8_t* buffer_ptr = (uint8_t*)driver + sizeof(*driver);
  driver->identifier = iree_make_string_view(
      (const char*)memcpy(buffer_ptr, identifier.data, identifier.size),
      identifier.size);
  driver->options = *options;

  *out_driver = (iree_hal_driver_t*)driver;
  return iree_ok_status();
}

static void iree_hal_elizanpu_driver_destroy(iree_hal_driver_t* base_driver) {
  iree_hal_elizanpu_driver_t* driver =
      iree_hal_elizanpu_driver_cast(base_driver);
  iree_allocator_free(driver->host_allocator, driver);
}

static iree_status_t iree_hal_elizanpu_driver_query_available_devices(
    iree_hal_driver_t* base_driver, iree_allocator_t host_allocator,
    iree_host_size_t* out_device_info_count,
    iree_hal_device_info_t** out_device_infos) {
  static const iree_hal_device_info_t default_device_info = {
      .device_id = IREE_HAL_ELIZANPU_DEVICE_ID_DEFAULT,
      .name = IREE_SVL("elizanpu0"),
  };
  iree_hal_device_info_t* device_infos = NULL;
  IREE_RETURN_IF_ERROR(iree_allocator_malloc(
      host_allocator, sizeof(default_device_info), (void**)&device_infos));
  *device_infos = default_device_info;
  *out_device_info_count = 1;
  *out_device_infos = device_infos;
  return iree_ok_status();
}

static iree_status_t iree_hal_elizanpu_driver_dump_device_info(
    iree_hal_driver_t* base_driver, iree_hal_device_id_t device_id,
    iree_string_builder_t* builder) {
  return iree_ok_status();
}

static iree_status_t iree_hal_elizanpu_driver_create_device_by_id(
    iree_hal_driver_t* base_driver, iree_hal_device_id_t device_id,
    iree_host_size_t param_count, const iree_string_pair_t* params,
    const iree_hal_device_create_params_t* create_params,
    iree_allocator_t host_allocator, iree_hal_device_t** out_device) {
  iree_hal_elizanpu_driver_t* driver =
      iree_hal_elizanpu_driver_cast(base_driver);
  return iree_hal_elizanpu_device_create(
      driver->identifier, &driver->options.default_device_options,
      create_params, host_allocator, out_device);
}

static iree_status_t iree_hal_elizanpu_driver_create_device_by_path(
    iree_hal_driver_t* base_driver, iree_string_view_t driver_name,
    iree_string_view_t device_path, iree_host_size_t param_count,
    const iree_string_pair_t* params,
    const iree_hal_device_create_params_t* create_params,
    iree_allocator_t host_allocator, iree_hal_device_t** out_device) {
  return iree_hal_elizanpu_driver_create_device_by_id(
      base_driver, IREE_HAL_ELIZANPU_DEVICE_ID_DEFAULT, param_count, params,
      create_params, host_allocator, out_device);
}

static const iree_hal_driver_vtable_t iree_hal_elizanpu_driver_vtable = {
    .destroy = iree_hal_elizanpu_driver_destroy,
    .query_available_devices = iree_hal_elizanpu_driver_query_available_devices,
    .dump_device_info = iree_hal_elizanpu_driver_dump_device_info,
    .create_device_by_id = iree_hal_elizanpu_driver_create_device_by_id,
    .create_device_by_path = iree_hal_elizanpu_driver_create_device_by_path,
};
