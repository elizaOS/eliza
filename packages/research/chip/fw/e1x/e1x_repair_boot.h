/*
 * E1X boot-time repair-ROM programming: platform-agnostic core.
 *
 * At power-on the boot firmware locates the wafer-sort repair-ROM image in the
 * tile-local fuse/ROM region, validates the `eliza.e1x.repair_rom.v1` header,
 * and streams every 64-bit remap and route word through the repair MMIO
 * programmer register interface (e1x_repair_mmio_programmer.sv). The programmer
 * latches each word as a low/high 32-bit pair and pushes it into the route
 * table loader, applying valid/ready backpressure on the PUSH register.
 *
 * SILICON BOUNDARY: real fuse storage and burning require silicon and the OTP
 * controller. This module proves the boot-time *programming logic* against the
 * real ROM image format. The ROM source and the MMIO register file are abstracted
 * behind the e1x_repair_bus interface so the identical routine runs bare-metal
 * (against real MMIO) and in simulation/native (against a software model of the
 * programmer and an in-memory copy of the generated ROM image).
 */
#ifndef E1X_REPAIR_BOOT_H
#define E1X_REPAIR_BOOT_H

#include <stdint.h>

/*
 * Repair MMIO programmer register map. Byte offsets relative to the programmer
 * base, matching e1x_repair_mmio_programmer.sv exactly. All registers are
 * 32-bit. The E1X MMIO request interface only decodes addr[7:0].
 */
#define E1X_REPAIR_PROG_CTRL     0x00u /* W: bit0 = clear/reset, bit1 = clear error */
#define E1X_REPAIR_PROG_STATUS   0x04u /* R: {.., pending, error, word_ready, pending} */
#define E1X_REPAIR_PROG_DATA_LO  0x08u /* W: low 32 bits of the next 64-bit word */
#define E1X_REPAIR_PROG_DATA_HI  0x0cu /* W: high 32 bits of the next 64-bit word */
#define E1X_REPAIR_PROG_PUSH     0x10u /* W: commit {DATA_HI,DATA_LO}; ready gates on backpressure */
#define E1X_REPAIR_PROG_COUNT    0x14u /* R: words pushed so far */

/* STATUS register bit fields (e1x_repair_mmio_programmer.sv ADDR_STATUS). */
#define E1X_REPAIR_STATUS_PENDING_LO  (1u << 0) /* a word is staged and not yet accepted */
#define E1X_REPAIR_STATUS_WORD_READY  (1u << 1) /* downstream loader ready to accept */
#define E1X_REPAIR_STATUS_ERROR       (1u << 2) /* invalid programmer access latched */
#define E1X_REPAIR_STATUS_PENDING_HI  (1u << 3) /* mirror of pending (busy) */

/*
 * eliza.e1x.repair_rom.v1 image layout (64-bit big-endian words). Mirrors
 * compiler/runtime/e1x_wafer_model.py repair_rom_artifact() and the RTL decode
 * in e1x_repair_rom_loader.sv.
 *
 *   word 0: magic  "E1XREPAI" = 0x4531585245504149
 *   word 1: (logical_rows  << 32) | logical_cols
 *   word 2: (physical_rows << 32) | physical_cols
 *   word 3: spare_cores
 *   word 4: remap_word_count  (low 32 bits significant)
 *   word 5: route_word_count  (low 32 bits significant)
 *   word 6: source defect-map sha256[:16] (first 8 bytes)
 *   word 7: source repair-manifest sha256[:16] (first 8 bytes)
 *   then remap_word_count remap words, then route_word_count route words.
 */
#define E1X_REPAIR_ROM_MAGIC      0x4531585245504149ull
#define E1X_REPAIR_ROM_HEADER_WORDS 8u

/* Deterministic completion status returned by the boot routine. */
typedef enum {
    E1X_REPAIR_OK = 0,            /* all words programmed, counts match header */
    E1X_REPAIR_ERR_NULL_BUS = 1,  /* missing bus/source callback */
    E1X_REPAIR_ERR_BAD_MAGIC = 2, /* header magic mismatch */
    E1X_REPAIR_ERR_SHORT_IMAGE = 3, /* image smaller than declared word count */
    E1X_REPAIR_ERR_COUNT_OVERFLOW = 4, /* declared counts overflow word index */
    E1X_REPAIR_ERR_PROGRAMMER = 5, /* programmer latched an error during push */
    E1X_REPAIR_ERR_PUSH_TIMEOUT = 6, /* backpressure never cleared within budget */
    E1X_REPAIR_ERR_COUNT_MISMATCH = 7 /* programmer pushed-count != words streamed */
} e1x_repair_status_t;

/*
 * Hardware bus abstraction. Bare-metal binds these to volatile MMIO accesses at
 * the programmer base; the native harness binds them to the software model.
 *
 *   read_rom_word(ctx, index): returns the index-th 64-bit ROM word.
 *   rom_word_count(ctx): total words available in the ROM region.
 *   mmio_write/mmio_read: 32-bit programmer register accesses (byte offset).
 */
typedef struct e1x_repair_bus {
    uint64_t (*read_rom_word)(void *ctx, uint32_t index);
    uint32_t (*rom_word_count)(void *ctx);
    void (*mmio_write)(void *ctx, uint32_t offset, uint32_t value);
    uint32_t (*mmio_read)(void *ctx, uint32_t offset);
    void *ctx;
} e1x_repair_bus_t;

/* Result detail filled in by the boot routine for deterministic reporting. */
typedef struct e1x_repair_result {
    e1x_repair_status_t status;
    uint32_t remap_word_count;   /* from header */
    uint32_t route_word_count;   /* from header */
    uint32_t words_streamed;     /* words this routine pushed (remap + route) */
    uint32_t programmer_count;   /* programmer COUNT register after the stream */
} e1x_repair_result_t;

/*
 * Per-PUSH backpressure budget. The programmer accepts a staged word as soon as
 * the downstream loader is ready; one polled spin per cycle is ample headroom
 * for the single-deep handshake. Exceeding it is a fail-closed timeout, never a
 * silent skip.
 */
#define E1X_REPAIR_PUSH_SPIN_BUDGET 4096u

/*
 * Program the mesh route tables from the repair ROM via the MMIO programmer.
 * Returns E1X_REPAIR_OK only if the full image streamed and the programmer's
 * pushed-word count matches the words this routine emitted. Any inconsistency
 * fails closed with a specific status code; nothing is silently skipped.
 */
e1x_repair_status_t e1x_repair_program_from_rom(const e1x_repair_bus_t *bus,
                                                e1x_repair_result_t *out);

#endif /* E1X_REPAIR_BOOT_H */
