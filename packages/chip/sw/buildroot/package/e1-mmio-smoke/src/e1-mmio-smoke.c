// SPDX-License-Identifier: GPL-2.0-only
/*
 * e1-mmio-smoke: mmap /dev/mem and read the NPU + DMA scratch registers
 * from the Eliza e1 platform contract.
 *
 * Exits 0 if every required register read returned a non-bus-error value.
 * Exits 2 if /dev/mem cannot be opened (e.g. CONFIG_DEVMEM=n or root missing).
 * Exits 3 if any read returned E1_UNMAPPED_READ_VALUE.
 *
 * This is a pre-driver smoke. After CONFIG_ELIZA_E1_* is enabled,
 * userspace should instead use /dev/e1-npu and the DMA sysfs nodes.
 */

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#define E1_DMA_BASE        0x10010000u
#define E1_NPU_BASE        0x10020000u
#define E1_REGION_SIZE     0x1000u
#define E1_UNMAPPED_VALUE  0xDEADBEEFu

#define E1_NPU_RESULT_OFFSET       0x08u
#define E1_NPU_CTRL_STATUS_OFFSET  0x0Cu
#define E1_DMA_CTRL_STATUS_OFFSET  0x0Cu
#define E1_DMA_BYTES_DONE_OFFSET   0x14u

static uint32_t read_reg(volatile void *base, unsigned int off)
{
	return *(volatile uint32_t *)((volatile uint8_t *)base + off);
}

static int probe(int fd, uint32_t base, const char *label,
		 const unsigned int *offsets, size_t n)
{
	volatile void *map;
	int rc = 0;
	size_t i;

	map = mmap(NULL, E1_REGION_SIZE, PROT_READ, MAP_SHARED, fd, base);
	if (map == MAP_FAILED) {
		fprintf(stderr, "%s mmap(0x%08x): %s\n", label, base,
			strerror(errno));
		return 2;
	}

	printf("%s base=0x%08x\n", label, base);
	for (i = 0; i < n; i++) {
		uint32_t v = read_reg(map, offsets[i]);
		printf("  +0x%02x = 0x%08x\n", offsets[i], v);
		if (v == E1_UNMAPPED_VALUE)
			rc = 3;
	}

	munmap((void *)map, E1_REGION_SIZE);
	return rc;
}

int main(void)
{
	static const unsigned int npu_offs[] = {
		E1_NPU_RESULT_OFFSET,
		E1_NPU_CTRL_STATUS_OFFSET,
	};
	static const unsigned int dma_offs[] = {
		E1_DMA_CTRL_STATUS_OFFSET,
		E1_DMA_BYTES_DONE_OFFSET,
	};
	int fd, rc, worst = 0;

	fd = open("/dev/mem", O_RDONLY | O_CLOEXEC);
	if (fd < 0) {
		fprintf(stderr, "/dev/mem: %s\n", strerror(errno));
		return 2;
	}

	rc = probe(fd, E1_NPU_BASE, "NPU", npu_offs,
		   sizeof(npu_offs) / sizeof(npu_offs[0]));
	if (rc > worst)
		worst = rc;

	rc = probe(fd, E1_DMA_BASE, "DMA", dma_offs,
		   sizeof(dma_offs) / sizeof(dma_offs[0]));
	if (rc > worst)
		worst = rc;

	close(fd);
	return worst;
}
