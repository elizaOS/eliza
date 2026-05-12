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

ELIZA_BUN_ENGINE_EXPORT int32_t eliza_bun_engine_start(
    const char *bundle_path,
    const char *argv_json,
    const char *env_json,
    const char *app_support_dir);

ELIZA_BUN_ENGINE_EXPORT int32_t eliza_bun_engine_stop(void);

ELIZA_BUN_ENGINE_EXPORT char *eliza_bun_engine_call(
    const char *method,
    const char *payload_json);

ELIZA_BUN_ENGINE_EXPORT void eliza_bun_engine_free(void *ptr);

#ifdef __cplusplus
}
#endif

#endif
