/*
 * E1X bare-metal boot entry that programs the mesh route tables from the
 * repair-ROM fuse region at power-on.
 *
 * Address map (E1X tile-local, this firmware's contract):
 *   - Repair-ROM fuse window base: read-only 64-bit words holding the
 *     eliza.e1x.repair_rom.v1 image burned at wafer sort. Big-endian per the
 *     image schema; each word is materialised here from two 32-bit halves so
 *     the read path is endian-explicit and independent of CPU byte order.
 *   - Repair MMIO programmer base: the e1x_repair_mmio_programmer.sv register
 *     file (CTRL/STATUS/DATA_LO/DATA_HI/PUSH/COUNT).
 *
 * SILICON BOUNDARY: the fuse window is a silicon OTP read port; this firmware
 * proves the boot-time read + parse + MMIO-program sequence. Burning fuses and
 * the OTP controller itself are silicon concerns out of scope for this routine.
 *
 * The completion status is published to a result MMIO scratch word and the
 * routine then parks. A non-OK status is a fail-closed park, never an unsigned
 * or partial route-table programming.
 */
#include <stdint.h>

#include "e1x_repair_boot.h"

#ifndef E1X_REPAIR_ROM_FUSE_BASE
#define E1X_REPAIR_ROM_FUSE_BASE 0x10040000ULL
#endif
#ifndef E1X_REPAIR_PROG_BASE
#define E1X_REPAIR_PROG_BASE 0x10050000ULL
#endif
#ifndef E1X_REPAIR_RESULT_ADDR
#define E1X_REPAIR_RESULT_ADDR 0x10051000ULL
#endif

/*
 * Number of 64-bit words exposed by the fuse read port. On silicon this is a
 * fixed OTP geometry constant; here it bounds the read so a malformed/oversized
 * header cannot walk off the window.
 */
#ifndef E1X_REPAIR_ROM_FUSE_WORDS
#define E1X_REPAIR_ROM_FUSE_WORDS 4096u
#endif

static inline uint32_t mmio_read32(uint64_t addr) {
    return *(volatile uint32_t *)(uintptr_t)addr;
}

static inline void mmio_write32(uint64_t addr, uint32_t value) {
    *(volatile uint32_t *)(uintptr_t)addr = value;
}

/*
 * Read the index-th 64-bit ROM word from the fuse window. The image is
 * big-endian: the fuse port exposes consecutive 32-bit cells with the high
 * half first, so reassemble explicitly rather than punning a 64-bit load.
 */
static uint64_t fuse_read_rom_word(void *ctx, uint32_t index) {
    (void)ctx;
    uint64_t cell = E1X_REPAIR_ROM_FUSE_BASE + (uint64_t)index * 8ull;
    uint32_t hi = mmio_read32(cell);
    uint32_t lo = mmio_read32(cell + 4ull);
    return ((uint64_t)hi << 32) | (uint64_t)lo;
}

static uint32_t fuse_rom_word_count(void *ctx) {
    (void)ctx;
    return E1X_REPAIR_ROM_FUSE_WORDS;
}

static void prog_mmio_write(void *ctx, uint32_t offset, uint32_t value) {
    (void)ctx;
    mmio_write32(E1X_REPAIR_PROG_BASE + offset, value);
}

static uint32_t prog_mmio_read(void *ctx, uint32_t offset) {
    (void)ctx;
    return mmio_read32(E1X_REPAIR_PROG_BASE + offset);
}

void main(void) {
    e1x_repair_bus_t bus = {
        .read_rom_word = fuse_read_rom_word,
        .rom_word_count = fuse_rom_word_count,
        .mmio_write = prog_mmio_write,
        .mmio_read = prog_mmio_read,
        .ctx = 0,
    };
    e1x_repair_result_t result;
    e1x_repair_status_t status = e1x_repair_program_from_rom(&bus, &result);

    /* Publish a deterministic completion word: {programmer_count, status}. */
    mmio_write32(E1X_REPAIR_RESULT_ADDR, (uint32_t)status);
    mmio_write32(E1X_REPAIR_RESULT_ADDR + 4u, result.words_streamed);
    mmio_write32(E1X_REPAIR_RESULT_ADDR + 8u, result.programmer_count);

    for (;;) {
        __asm__ volatile("wfi");
    }
}
