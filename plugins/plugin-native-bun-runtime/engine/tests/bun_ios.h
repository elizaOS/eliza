/* Test stand-in for Bun's iOS embedding header; shim_harness.c supplies
 * bun_start with a fake ios-bridge. */
#ifndef ELIZA_TEST_BUN_IOS_H
#define ELIZA_TEST_BUN_IOS_H

#include <stdint.h>

int bun_start(
    int argc,
    const char **argv,
    int stdin_fd,
    int stdout_fd,
    int stderr_fd,
    void (*exit_callback)(uint32_t code));

#endif
