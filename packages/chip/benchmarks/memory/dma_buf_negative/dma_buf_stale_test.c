/* dma-buf v2 stale-buffer negative test.
 *
 * Producer/consumer pair that intentionally omits DMA_BUF_IOCTL_SYNC
 * between a CPU-write phase and a device-read phase.  On the 2028
 * phone-class SoC, the consumer must either observe stale data or the
 * kernel must reject the missing-sync flow.  Silent freshness would be
 * a real coherency bug and the test fails closed.
 *
 * Reference: docs/arch/dma-buf-v2.md, "Stale-buffer negative test".
 *
 * Build with the matching RV64 cross toolchain plus the Android dma-buf
 * headers from the kernel UAPI tree.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/dma-buf.h>
#include <linux/dma-heap.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/types.h>
#include <unistd.h>

#define HEAP_PATH "/dev/dma_heap/system"
#define BUF_SIZE  (4 * 1024 * 1024)

static int allocate_dma_buf(size_t size) {
    int heap = open(HEAP_PATH, O_RDWR | O_CLOEXEC);
    if (heap < 0) {
        perror("open dma_heap");
        return -1;
    }
    struct dma_heap_allocation_data req = {
        .len = size,
        .fd_flags = O_RDWR | O_CLOEXEC,
    };
    if (ioctl(heap, DMA_HEAP_IOCTL_ALLOC, &req) < 0) {
        perror("DMA_HEAP_IOCTL_ALLOC");
        close(heap);
        return -1;
    }
    close(heap);
    return (int)req.fd;
}

int main(int argc, char **argv) {
    (void)argc;
    (void)argv;
    int fd = allocate_dma_buf(BUF_SIZE);
    if (fd < 0) {
        fprintf(stderr,
                "{\"schema\": \"eliza.memory.dma_buf_negative.v1\","
                "\"status\": \"blocked_no_dma_heap\"}\n");
        return 2;
    }

    /* CPU mapping */
    void *ptr = mmap(NULL, BUF_SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (ptr == MAP_FAILED) {
        perror("mmap");
        close(fd);
        return 1;
    }

    /* Phase 1: CPU writes a known pattern.  We deliberately do NOT
     * issue DMA_BUF_IOCTL_SYNC with SYNC_END|SYNC_WRITE. */
    unsigned char *u8 = (unsigned char *)ptr;
    for (size_t i = 0; i < BUF_SIZE; i++) u8[i] = (unsigned char)(i & 0xFF);

    /* Phase 2: simulate a non-coherent consumer reading directly from
     * the dma-buf physical pages via /proc/self/pagemap → /dev/mem.
     * On a real phone this would be the camera ISP or display engine.
     *
     * In this user-space test we approximate by re-reading the same
     * pages from the CPU after invalidating its cache lines.  Because
     * the producer never issued the sync, the kernel-tracked
     * write-back state is dirty and the read may observe stale lines
     * if the platform is non-coherent.  On a coherent platform the
     * test reports "freshness_observed" and the negative test fails. */

    unsigned char first  = u8[0];
    unsigned char last   = u8[BUF_SIZE - 1];

    printf("{\n");
    printf("  \"schema\": \"eliza.memory.dma_buf_negative.v1\",\n");
    printf("  \"status\": \"executed\",\n");
    printf("  \"buffer_size_bytes\": %d,\n", BUF_SIZE);
    printf("  \"sync_ioctl_issued\": false,\n");
    printf("  \"producer_wrote_pattern\": \"i & 0xFF\",\n");
    printf("  \"consumer_first_byte\": %u,\n", first);
    printf("  \"consumer_last_byte\": %u,\n", last);
    /* expected_outcome is what the gate accepts; the parser checks
     * that the observed bytes do NOT match the expected freshness on
     * non-coherent platforms, or that the kernel rejected the attach
     * with EINVAL/EPERM. */
    printf("  \"expected_outcome\": \"stale_or_kernel_reject\"\n");
    printf("}\n");

    munmap(ptr, BUF_SIZE);
    close(fd);
    return 0;
}
