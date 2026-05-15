/*
 * Build-only smoke test for the yolo-cpp ENOSYS stub.
 *
 * Confirms the C ABI declared in `include/yolo/yolo.h` links and that
 * every graph-backed entry point reports the expected `-ENOSYS`. This
 * is intentionally not a behavioural test — once the real ggml-backed
 * implementation lands, the parity / quality tests will live next to
 * it and this smoke test stays as a "the ABI still compiles" guard.
 *
 * `yolo_close` is a NULL-safe lifecycle release; it returns 0 even on
 * the stub. `yolo_active_backend` reports `"stub"` until Phase 2.
 */

#include "yolo/yolo.h"

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    int failures = 0;

    if (strcmp(yolo_active_backend(), "stub") != 0) {
        fprintf(stderr, "[yolo-stub-smoke] unexpected backend: %s\n",
                yolo_active_backend());
        ++failures;
    }

    yolo_handle handle = (yolo_handle)0x1; /* clobbered by yolo_open */
    int rc = yolo_open("/nonexistent.gguf", &handle);
    if (rc != -ENOSYS) {
        fprintf(stderr, "[yolo-stub-smoke] yolo_open returned %d, expected %d\n",
                rc, -ENOSYS);
        ++failures;
    }
    if (handle != NULL) {
        fprintf(stderr, "[yolo-stub-smoke] yolo_open did not clear out handle\n");
        ++failures;
    }

    /* Safe with NULL — must not crash and must return 0. */
    rc = yolo_close(NULL);
    if (rc != 0) {
        fprintf(stderr, "[yolo-stub-smoke] yolo_close(NULL) returned %d, expected 0\n",
                rc);
        ++failures;
    }

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
    if (rc != -ENOSYS) {
        fprintf(stderr, "[yolo-stub-smoke] yolo_detect returned %d, expected %d\n",
                rc, -ENOSYS);
        ++failures;
    }
    if (count != 0) {
        fprintf(stderr, "[yolo-stub-smoke] yolo_detect did not zero out_count (%zu)\n",
                count);
        ++failures;
    }

    printf("[yolo-stub-smoke] failures=%d\n", failures);
    return failures == 0 ? 0 : 1;
}
