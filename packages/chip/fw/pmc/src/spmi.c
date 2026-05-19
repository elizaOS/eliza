/*
 * SPMI v2.0 master FSM for the Eliza E1 PMC.
 *
 * SPMI v2.0 reference: MIPI Alliance SPMI v2.0 (2014). The PMC always acts as
 * the bus controller / master. The protocol carries 9-bit symbols framed by a
 * single SCLK; on the wire each symbol is a parity-protected byte. This driver
 * encapsulates the byte sequence and host-visible state of a master transfer
 * without taking a position on whether the underlying physical layer is a
 * future hardware accelerator (memory-mapped registers exposed through the AON
 * SPMI mux) or the bit-bang fall-back path used during bring-up.
 *
 * The functions in this translation unit operate against a host-supplied
 * `struct spmi_master` instance; the production wrapper at the bottom of the
 * file binds a single static instance to the hardware MMIO addresses declared
 * in rtl/power/pmc_top.sv. Unit tests under tests/test_spmi.c bind a software
 * loopback peripheral instead, which lets the same FSM run under host gcc.
 *
 * Supported sequences (SPMI v2 master-initiated):
 *   - master_write     : send EXT_WRITEL command + data byte to a slave reg.
 *   - master_read      : send EXT_READL  command, capture slave-asserted data.
 *   - master_write_burst: chain N EXT_WRITEL frames against incrementing
 *                         register addresses; aborts on first NACK.
 *   - slave_trigger    : broadcast a TRANSFER_BUS_OWNERSHIP command so the
 *                         addressed slave can issue a follow-on master cycle.
 *
 * All public entry points are reentrant only with respect to distinct
 * `struct spmi_master` instances. Concurrent use on the same instance is a
 * caller bug; the PMC runs the SPMI scheduler on a single thread on the AON
 * Ibex.
 */

#include "pmc.h"
#include "spmi.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifndef SPMI_BUSY_POLL_LIMIT
#define SPMI_BUSY_POLL_LIMIT 1024u
#endif

/* SPMI v2.0 command opcodes (master-issued). Encoded in the top 6/8 bits of
 * the command symbol. */
#define SPMI_CMD_EXT_WRITEL          0x30u  /* extended write, long address */
#define SPMI_CMD_EXT_READL           0x38u  /* extended read,  long address */
#define SPMI_CMD_TRANSFER_BUS_OWNER  0x1Au  /* slave-trigger handoff        */

/* Master control / status bit positions inside the MMIO ctrl word.
 * Layout (LSB first):
 *   [7:0]   data byte (write: payload; read: returned byte)
 *   [23:8]  register address
 *   [27:24] slave-id (SID) — SPMI supports up to 16 unique slaves
 *   [29:28] reserved (must be 0)
 *   [30]    parity error sticky bit (read-only from FSM)
 *   [31]    busy: 1 while the FSM owns the bus, 0 when idle.
 *
 * The command opcode does not live in the ctrl word; it is conveyed in a
 * separate `cmd` symbol issued before the address/data. The MMIO accelerator
 * implements that as a second register write, but for the host-test loopback
 * we collapse the two operations into a single struct field
 * (`pending_cmd`) populated by the caller before each transfer.
 */
#define SPMI_CTRL_BUSY               (1u << 31)
#define SPMI_CTRL_PARITY_ERR         (1u << 30)
#define SPMI_CTRL_SID_SHIFT          24u
#define SPMI_CTRL_REG_SHIFT          8u
#define SPMI_CTRL_DATA_MASK          0xFFu

/* FSM phases are declared in include/spmi.h so unit tests can assert against
 * the same constants. */

static uint32_t spmi_pack(uint8_t sid, uint16_t reg, uint8_t data)
{
    return ((uint32_t)data & SPMI_CTRL_DATA_MASK)
         | (((uint32_t)reg & 0xFFFFu) << SPMI_CTRL_REG_SHIFT)
         | (((uint32_t)sid & 0xFu) << SPMI_CTRL_SID_SHIFT);
}

static int spmi_busy_wait(struct spmi_master *m)
{
    for (uint32_t i = 0; i < SPMI_BUSY_POLL_LIMIT; ++i) {
        uint32_t state = m->ops.read(m->ctx);
        if ((state & SPMI_CTRL_BUSY) == 0u) {
            if (state & SPMI_CTRL_PARITY_ERR) {
                m->last_state = SPMI_STATE_ERROR;
                return -1;
            }
            m->last_state = SPMI_STATE_COMPLETE;
            return 0;
        }
    }
    m->last_state = SPMI_STATE_ERROR;
    return -1;
}

static int spmi_issue(struct spmi_master *m, uint8_t opcode, uint32_t pkt)
{
    if (m == NULL || m->ops.read == NULL || m->ops.write == NULL) {
        return -1;
    }
    /* Arbitration phase: the FSM stalls if the bus is busy from a previous
     * transfer. SPMI v2 does not permit interleaving frames from the master,
     * so we simply wait for BUSY=0 before pushing the new command. */
    m->last_state = SPMI_STATE_ARBITRATE;
    for (uint32_t i = 0; i < SPMI_BUSY_POLL_LIMIT; ++i) {
        uint32_t state = m->ops.read(m->ctx);
        if ((state & SPMI_CTRL_BUSY) == 0u) {
            break;
        }
        if (i + 1u == SPMI_BUSY_POLL_LIMIT) {
            m->last_state = SPMI_STATE_ERROR;
            return -1;
        }
    }

    m->last_state = SPMI_STATE_SEND_CMD;
    if (m->ops.cmd != NULL) {
        m->ops.cmd(m->ctx, opcode);
    }
    /* SPMI master controller latches the BUSY bit on write. */
    m->ops.write(m->ctx, pkt | SPMI_CTRL_BUSY);
    m->last_state = SPMI_STATE_XFER_DATA;
    return spmi_busy_wait(m);
}

void spmi_master_init(struct spmi_master *m, const struct spmi_master_ops *ops, void *ctx)
{
    m->ops       = *ops;
    m->ctx       = ctx;
    m->last_state = SPMI_STATE_IDLE;
}

int spmi_master_write(struct spmi_master *m, uint8_t sid, uint16_t reg, uint8_t value)
{
    return spmi_issue(m, SPMI_CMD_EXT_WRITEL, spmi_pack(sid, reg, value));
}

int spmi_master_read(struct spmi_master *m, uint8_t sid, uint16_t reg, uint8_t *out)
{
    if (out == NULL) {
        return -1;
    }
    int rc = spmi_issue(m, SPMI_CMD_EXT_READL, spmi_pack(sid, reg, 0u));
    if (rc == 0) {
        *out = (uint8_t)(m->ops.read(m->ctx) & SPMI_CTRL_DATA_MASK);
    }
    return rc;
}

int spmi_master_write_burst(struct spmi_master *m,
                            uint8_t sid,
                            uint16_t reg_base,
                            const uint8_t *bytes,
                            size_t count)
{
    if (bytes == NULL && count != 0u) {
        return -1;
    }
    for (size_t i = 0; i < count; ++i) {
        int rc = spmi_master_write(m, sid, (uint16_t)(reg_base + i), bytes[i]);
        if (rc != 0) {
            return -1;
        }
    }
    return 0;
}

int spmi_slave_trigger(struct spmi_master *m, uint8_t sid)
{
    return spmi_issue(m, SPMI_CMD_TRANSFER_BUS_OWNER, spmi_pack(sid, 0u, 0u));
}

enum spmi_state spmi_last_state(const struct spmi_master *m)
{
    return m->last_state;
}

/* -------------------------------------------------------------------------
 * Production bind point: a single AON SPMI master backed by a memory-mapped
 * control register. Until the hardware accelerator is bound, the address
 * matches the planning offset documented in rtl/power/pmc_top.sv.
 * ------------------------------------------------------------------------- */
#ifndef SPMI_PMC_CTRL_MMIO
#define SPMI_PMC_CTRL_MMIO  0x10010100u
#endif

#ifndef SPMI_HOSTED_UNIT_TEST
static uint32_t spmi_mmio_read(void *ctx)
{
    volatile uint32_t *p = (volatile uint32_t *)(uintptr_t)SPMI_PMC_CTRL_MMIO;
    (void)ctx;
    return *p;
}

static void spmi_mmio_write(void *ctx, uint32_t value)
{
    volatile uint32_t *p = (volatile uint32_t *)(uintptr_t)SPMI_PMC_CTRL_MMIO;
    (void)ctx;
    *p = value;
}

static struct spmi_master g_spmi_master;

void pmc_spmi_init(void)
{
    static const struct spmi_master_ops ops = {
        .read  = spmi_mmio_read,
        .write = spmi_mmio_write,
    };
    spmi_master_init(&g_spmi_master, &ops, NULL);
}

int pmc_spmi_write_byte(uint8_t sid, uint16_t reg, uint8_t value)
{
    return spmi_master_write(&g_spmi_master, sid, reg, value);
}

int pmc_spmi_read_byte(uint8_t sid, uint16_t reg, uint8_t *out)
{
    return spmi_master_read(&g_spmi_master, sid, reg, out);
}

int pmc_spmi_write_burst(uint8_t sid, uint16_t reg_base, const uint8_t *bytes, size_t count)
{
    return spmi_master_write_burst(&g_spmi_master, sid, reg_base, bytes, count);
}

int pmc_spmi_slave_trigger(uint8_t sid)
{
    return spmi_slave_trigger(&g_spmi_master, sid);
}
#endif /* !SPMI_HOSTED_UNIT_TEST */
