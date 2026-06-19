/*
 * Eliza E1 — OpenSBI <-> AON Ibex PMC RPMI shared-memory transport layout.
 *
 * This header is the single source of truth for the byte offsets and queue
 * geometry the OpenSBI `riscv,rpmi-shmem-mbox` driver
 * (`external/opensbi/opensbi/lib/utils/mailbox/fdt_mailbox_rpmi_shmem.c`)
 * consumes via the device-tree fragment in `dts/eliza-rocket-pmc.dtsi`, and
 * the layout the AON Ibex PMC server (`fw/pmc/src/rpmi_server.c` +
 * `fw/pmc/src/main.c::pmc_drain_rpmi_a2p_request`) drains.
 *
 * Constraints:
 *   - The PMC AON mailbox aperture is 4 KiB at `0x1005_0000`, set by
 *     `rtl/top/e1_soc_integrated.sv` PMC decode `mmio_addr[31:12] ==
 *     20'h1005_0` and `rtl/power/pmc_top.sv` `PMC_MBOX_AW = 12`.
 *   - Offsets `0x000..0x07F` are already mapped to scalar mailbox registers
 *     (TX_HEAD / TX_DATA / RX_HEAD / RX_DATA / STATUS / CTRL / DROOP_* /
 *     DVFS_BASE).  See `rtl/power/power_pkg.sv`.
 *   - The shared-memory queues live in the upper half of the aperture, from
 *     `0x800` to `0xFFF` (2 KiB), so they never collide with the scalar
 *     register decode.  `pmc_top.sv` routes those MMIO accesses into the
 *     AON SRAM (`aon_sram_q`) that the Ibex data port also reaches.
 *   - OpenSBI's RPMI shmem driver requires a minimum slot size of 64 B
 *     (`RPMI_SLOT_SIZE_MIN`) and 2 header slots per queue.  We use the
 *     minimum.  With 4 slots per queue we get 2 data slots per queue.
 *
 * Layout summary:
 *   +---------------------+-------------+-------------+------------------+
 *   | Region              | Aperture    | Bytes       | OpenSBI reg-name |
 *   +---------------------+-------------+-------------+------------------+
 *   | A2P request queue   | +0x800      | 256         | a2p-req          |
 *   | P2A ack queue       | +0x900      | 256         | p2a-ack          |
 *   | P2A request queue   | +0xA00      | 256         | p2a-req          |
 *   | A2P ack queue       | +0xB00      | 256         | a2p-ack          |
 *   | A2P doorbell        | +0xC00      |   4         | a2p-doorbell     |
 *   +---------------------+-------------+-------------+------------------+
 *
 * Within each 256-byte queue:
 *   +0x00 .. +0x3F  : head slot   (32b head index in first 4 bytes, LE)
 *   +0x40 .. +0x7F  : tail slot   (32b tail index in first 4 bytes, LE)
 *   +0x80 .. +0xBF  : data slot 0 (RPMI message + payload, 64 B)
 *   +0xC0 .. +0xFF  : data slot 1 (RPMI message + payload, 64 B)
 *
 * Slot indexing follows OpenSBI's `fdt_mailbox_rpmi_shmem.c`:
 *
 *     qctx->headptr = base + RPMI_QUEUE_HEAD_SLOT * slot_size;  // slot 0
 *     qctx->tailptr = base + RPMI_QUEUE_TAIL_SLOT * slot_size;  // slot 1
 *     qctx->buffer  = base + RPMI_QUEUE_HEADER_SLOTS * slot_size; // slot 2..
 *
 * Endianness: all multi-byte fields are little-endian on the wire, per the
 * RPMI v1.0 specification.  The Ibex is also little-endian so no swap is
 * required; OpenSBI uses `cpu_to_le32` / `le32_to_cpu` macros explicitly.
 */

#ifndef ELIZA_PMC_RPMI_SHMEM_LAYOUT_H
#define ELIZA_PMC_RPMI_SHMEM_LAYOUT_H

#include <stddef.h>
#include <stdint.h>

/* Base address of the PMC mailbox aperture (matches PMC_BOOT_ADDR-aligned
 * mailbox decode in rtl/top/e1_soc_integrated.sv). */
#define RPMI_SHMEM_PMC_MAILBOX_BASE  0x10050000u

/* Offset of the shared-memory region relative to the mailbox base.  The
 * lower half (0x000..0x07F) is the scalar register file; the shared-memory
 * queues + doorbell occupy 0x800..0xC03. */
#define RPMI_SHMEM_REGION_OFFSET     0x00000800u

/* Absolute base of the shared-memory region (used by OpenSBI device tree). */
#define RPMI_SHMEM_REGION_BASE \
    (RPMI_SHMEM_PMC_MAILBOX_BASE + RPMI_SHMEM_REGION_OFFSET)

/* Queue / slot geometry — must equal OpenSBI's RPMI_SLOT_SIZE_MIN and the
 * minimum 2-header-slot + 2-data-slot layout. */
#define RPMI_SHMEM_SLOT_SIZE_BYTES    64u
#define RPMI_SHMEM_HEADER_SLOTS       2u    /* head + tail */
#define RPMI_SHMEM_DATA_SLOTS         2u    /* minimum data slots per queue */
#define RPMI_SHMEM_SLOTS_PER_QUEUE \
    (RPMI_SHMEM_HEADER_SLOTS + RPMI_SHMEM_DATA_SLOTS)
#define RPMI_SHMEM_QUEUE_SIZE_BYTES \
    (RPMI_SHMEM_SLOTS_PER_QUEUE * RPMI_SHMEM_SLOT_SIZE_BYTES) /* 256 */

/* Per-queue byte offsets within the shared-memory region. */
#define RPMI_SHMEM_OFF_A2P_REQ        0x000u   /* host -> PMC, normal req  */
#define RPMI_SHMEM_OFF_P2A_ACK        0x100u   /* PMC -> host, ack for above */
#define RPMI_SHMEM_OFF_P2A_REQ        0x200u   /* PMC -> host, posted req  */
#define RPMI_SHMEM_OFF_A2P_ACK        0x300u   /* host -> PMC, ack         */
#define RPMI_SHMEM_OFF_A2P_DOORBELL   0x400u   /* host write -> notify PMC */

/* Slot offsets within a single queue. */
#define RPMI_SHMEM_HEAD_SLOT_OFFSET   0x00u
#define RPMI_SHMEM_TAIL_SLOT_OFFSET   0x40u
#define RPMI_SHMEM_DATA0_OFFSET       0x80u
#define RPMI_SHMEM_DATA1_OFFSET       0xC0u

/* Absolute addresses (used by both the Ibex firmware and the cocotb harness). */
#define RPMI_SHMEM_A2P_REQ_BASE       (RPMI_SHMEM_REGION_BASE + RPMI_SHMEM_OFF_A2P_REQ)
#define RPMI_SHMEM_P2A_ACK_BASE       (RPMI_SHMEM_REGION_BASE + RPMI_SHMEM_OFF_P2A_ACK)
#define RPMI_SHMEM_P2A_REQ_BASE       (RPMI_SHMEM_REGION_BASE + RPMI_SHMEM_OFF_P2A_REQ)
#define RPMI_SHMEM_A2P_ACK_BASE       (RPMI_SHMEM_REGION_BASE + RPMI_SHMEM_OFF_A2P_ACK)
#define RPMI_SHMEM_A2P_DOORBELL_ADDR  (RPMI_SHMEM_REGION_BASE + RPMI_SHMEM_OFF_A2P_DOORBELL)

/* Total shared-memory footprint = 4 queues + 1 doorbell word.  Fits inside
 * the 2 KiB upper half of the mailbox aperture. */
#define RPMI_SHMEM_TOTAL_BYTES \
    (4u * RPMI_SHMEM_QUEUE_SIZE_BYTES + 4u)   /* 1028 bytes */

#define RPMI_SHMEM_A2P_DOORBELL_VALUE 0x1u

#endif /* ELIZA_PMC_RPMI_SHMEM_LAYOUT_H */
