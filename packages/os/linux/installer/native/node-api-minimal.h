#ifndef ELIZAOS_NODE_API_MINIMAL_H
#define ELIZAOS_NODE_API_MINIMAL_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef struct napi_ref__ *napi_ref;

typedef enum {
  napi_ok = 0,
} napi_status;

typedef enum {
  napi_default = 0,
} napi_property_attributes;

typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);
typedef void (*napi_finalize)(napi_env env, void *finalize_data,
                              void *finalize_hint);

typedef struct {
  const char *utf8name;
  napi_value name;
  napi_callback method;
  napi_callback getter;
  napi_callback setter;
  napi_value value;
  napi_property_attributes attributes;
  void *data;
} napi_property_descriptor;

typedef struct { uint64_t lower; uint64_t upper; } napi_type_tag;
extern napi_status napi_type_tag_object(napi_env env, napi_value object, const napi_type_tag *tag);
extern napi_status napi_check_object_type_tag(napi_env env, napi_value object, const napi_type_tag *tag, bool *result);
extern napi_status napi_is_buffer(napi_env env, napi_value value, bool *result);
extern napi_status napi_get_buffer_info(napi_env env, napi_value value, void **data, size_t *length);
extern napi_status napi_create_buffer_copy(napi_env env, size_t length, const void *data, void **result_data, napi_value *result);
extern napi_status napi_get_value_string_utf8(napi_env env, napi_value value, char *buffer, size_t size, size_t *result);

extern napi_status napi_create_int32(napi_env env, int32_t value,
                                     napi_value *result);
extern napi_status napi_create_uint32(napi_env env, uint32_t value,
                                      napi_value *result);
extern napi_status napi_create_object(napi_env env, napi_value *result);
extern napi_status napi_define_properties(
    napi_env env, napi_value object, size_t property_count,
    const napi_property_descriptor *properties);
extern napi_status napi_get_boolean(napi_env env, bool value,
                                    napi_value *result);
extern napi_status napi_get_cb_info(napi_env env, napi_callback_info info,
                                    size_t *argc, napi_value *argv,
                                    napi_value *this_arg, void **data);
extern napi_status napi_get_undefined(napi_env env, napi_value *result);
extern napi_status napi_get_value_int32(napi_env env, napi_value value,
                                        int32_t *result);
extern napi_status napi_set_named_property(napi_env env, napi_value object,
                                           const char *utf8name,
                                           napi_value value);
extern napi_status napi_throw_error(napi_env env, const char *code,
                                    const char *message);
extern napi_status napi_throw_type_error(napi_env env, const char *code,
                                         const char *message);
extern napi_status napi_unwrap(napi_env env, napi_value js_object,
                               void **result);
extern napi_status napi_wrap(napi_env env, napi_value js_object,
                             void *native_object, napi_finalize finalize_cb,
                             void *finalize_hint, napi_ref *result);

typedef struct napi_async_work__ *napi_async_work;
typedef struct napi_deferred__ *napi_deferred;
typedef void (*napi_async_execute_callback)(napi_env env, void *data);
typedef void (*napi_async_complete_callback)(napi_env env, napi_status status, void *data);
extern napi_status napi_create_string_utf8(napi_env env, const char *str, size_t length, napi_value *result);
extern napi_status napi_create_error(napi_env env, napi_value code, napi_value msg, napi_value *result);
extern napi_status napi_create_reference(napi_env env, napi_value value, uint32_t count, napi_ref *result);
extern napi_status napi_delete_reference(napi_env env, napi_ref ref);
extern napi_status napi_create_promise(napi_env env, napi_deferred *deferred, napi_value *promise);
extern napi_status napi_resolve_deferred(napi_env env, napi_deferred deferred, napi_value value);
extern napi_status napi_reject_deferred(napi_env env, napi_deferred deferred, napi_value error);
extern napi_status napi_create_async_work(napi_env env, napi_value resource, napi_value name,
    napi_async_execute_callback execute, napi_async_complete_callback complete, void *data, napi_async_work *result);
extern napi_status napi_queue_async_work(napi_env env, napi_async_work work);
extern napi_status napi_delete_async_work(napi_env env, napi_async_work work);
extern void napi_fatal_error(const char *location, size_t location_length, const char *message, size_t message_length);

#if defined(__GNUC__)
#define NAPI_EXPORT __attribute__((visibility("default")))
#else
#define NAPI_EXPORT
#endif

#endif
