/*
 * ABI link probe for libyolo.
 *
 * Confirms the C ABI declared in `include/yolo/yolo.h` links and that
 * the lifecycle / NULL-safety contract holds:
 *   - `yolo_active_backend` reports a non-NULL string.
 *   - `yolo_open` against a nonexistent path returns a negative errno
 *     (`-ENOENT` from the real runtime) and clears the out handle.
 *   - `yolo_close(NULL)` is a no-op that returns 0.
 *   - `yolo_detect` against a NULL handle drains `out_count` to 0 and
 *     returns a negative errno (`-EINVAL` from the real runtime).
 *
 * This test was the Phase 1 ENOSYS probe; the file name is kept for
 * git-history continuity. Phase 2 widens the contract to "the real
 * runtime is now linked and reports the documented errno codes" — the
 * stub-era `-ENOSYS` is no longer the expected value here.
 */

#include "yolo/yolo.h"

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    int failures = 0;

    const char *backend = yolo_active_backend();
    if (backend == NULL || backend[0] == '\0') {
        fprintf(stderr, "[yolo-smoke] active_backend returned empty\n");
        ++failures;
    } else {
        fprintf(stderr, "[yolo-smoke] backend = %s\n", backend);
    }

    /* Missing GGUF path → real runtime returns -ENOENT after open()
     * fails. We accept any negative errno here so the contract isn't
     * brittle against the underlying syscall's return path. */
    yolo_handle handle = (yolo_handle)0x1; /* must be cleared by yolo_open */
    int rc = yolo_open("/nonexistent.gguf", &handle);
    if (rc >= 0) {
        fprintf(stderr, "[yolo-smoke] yolo_open against missing path returned %d, expected negative errno\n",
                rc);
        ++failures;
    }
    if (handle != NULL) {
        fprintf(stderr, "[yolo-smoke] yolo_open did not clear out handle\n");
        ++failures;
    }

    /* Safe with NULL — must not crash and must return 0. */
    rc = yolo_close(NULL);
    if (rc != 0) {
        fprintf(stderr, "[yolo-smoke] yolo_close(NULL) returned %d, expected 0\n",
                rc);
        ++failures;
    }

    /* yolo_detect with NULL handle — runtime returns -EINVAL today. */
    uint8_t pixels[3 * 4 * 4] = {0};
    yolo_image image = {
        .rgb = pixels,
        .w = 4,
        .h = 4,
        .stride = 4 * 3,
    };
    yolo_detection dets[2] = {{0}};
    size_t count = 12345;
    rc = yolo_detect(NULL, &image, 0.25f, 0.45f, dets, 2, &count);
    if (rc >= 0) {
        fprintf(stderr, "[yolo-smoke] yolo_detect with NULL handle returned %d, expected negative\n",
                rc);
        ++failures;
    }
    if (count != 0) {
        fprintf(stderr, "[yolo-smoke] yolo_detect did not zero out_count (%zu)\n",
                count);
        ++failures;
    }

    printf("[yolo-smoke] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
