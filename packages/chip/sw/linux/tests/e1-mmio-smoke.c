// SPDX-License-Identifier: MIT
/*
 * User-space smoke source for an external Linux build.
 *
 * This probes the public BSP surface created by eliza,e1-npu,
 * eliza,e1-dma, and eliza,e1-display device tree nodes.
 */

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define E1_DMA_BASE 0x10010000u
#define E1_NPU_BASE 0x10020000u
#define E1_DISPLAY_BASE 0x10030000u

static int require_path(const char *path)
{
	int fd = open(path, O_RDONLY | O_CLOEXEC);

	if (fd < 0) {
		fprintf(stderr, "%s: %s\n", path, strerror(errno));
		return 1;
	}

	close(fd);
	return 0;
}

int main(void)
{
	int failed = 0;

	printf("E1_DMA_BASE=0x%08x\n", E1_DMA_BASE);
	printf("E1_NPU_BASE=0x%08x\n", E1_NPU_BASE);
	printf("E1_DISPLAY_BASE=0x%08x\n", E1_DISPLAY_BASE);
	failed |= require_path("/dev/e1-npu");
	failed |= require_path("/sys/bus/platform/drivers/eliza-e1-dma");

	return failed;
}
