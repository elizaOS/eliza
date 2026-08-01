/**
 * Stable C ABI between the embedded Bun engine and its iOS host. Model-adjacent
 * calls are owner-cancellable and deliberately carry no wall-clock deadline;
 * the reserved callback argument remains only to preserve ABI 3 compatibility.
 */
#ifndef ELIZA_BUN_ENGINE_H
#define ELIZA_BUN_ENGINE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(__GNUC__)
#define ELIZA_BUN_ENGINE_EXPORT __attribute__((visibility("default")))
#else
#define ELIZA_BUN_ENGINE_EXPORT
#endif

ELIZA_BUN_ENGINE_EXPORT const char *eliza_bun_engine_abi_version(void);

ELIZA_BUN_ENGINE_EXPORT const char *eliza_bun_engine_last_error(void);

typedef char *(*eliza_bun_engine_host_call_callback)(
    const char *method,
    const char *payload_json,
    int32_t reserved);

ELIZA_BUN_ENGINE_EXPORT int32_t eliza_bun_engine_set_host_callback(
    eliza_bun_engine_host_call_callback callback);

ELIZA_BUN_ENGINE_EXPORT int32_t eliza_bun_engine_start(
    const char *bundle_path,
    const char *argv_json,
    const char *env_json,
    const char *app_support_dir);

ELIZA_BUN_ENGINE_EXPORT int32_t eliza_bun_engine_stop(void);

ELIZA_BUN_ENGINE_EXPORT int32_t eliza_bun_engine_is_running(void);

ELIZA_BUN_ENGINE_EXPORT char *eliza_bun_engine_call(
    const char *method,
    const char *payload_json);

ELIZA_BUN_ENGINE_EXPORT void eliza_bun_engine_free(void *ptr);

#ifdef __cplusplus
}
#endif

#endif
