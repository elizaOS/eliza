/*
 * SPMI v2.0 master interface for the Eliza E1 PMC firmware.
 *
 * The translation unit at fw/pmc/src/spmi.c carries the FSM implementation
 * and binds a single static `struct spmi_master` instance to the AON MMIO
 * address documented in rtl/power/pmc_top.sv. Unit tests instantiate their
 * own master with a software loopback peripheral; see fw/pmc/tests.
 */

#ifndef ELIZA_PMC_SPMI_H
#define ELIZA_PMC_SPMI_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* FSM phase, surfaced for unit-test assertions. */
enum spmi_state {
    SPMI_STATE_IDLE = 0,
    SPMI_STATE_ARBITRATE,
    SPMI_STATE_SEND_CMD,
    SPMI_STATE_XFER_DATA,
    SPMI_STATE_COMPLETE,
    SPMI_STATE_ERROR
};

/* Caller-supplied I/O hooks. The production driver binds these to a
 * memory-mapped control register; the unit test binds them to a software
 * peripheral so the same FSM can run under host gcc.
 *
 *   read  : returns the controller ctrl word (data + status bits).
 *   write : posts the ctrl word (SID + register + data + BUSY).
 *   cmd   : optional opcode strobe issued before each transfer. NULL is
 *           accepted (production accelerator ties the opcode into the ctrl
 *           word) and the FSM degrades gracefully. */
struct spmi_master_ops {
    uint32_t (*read)(void *ctx);
    void     (*write)(void *ctx, uint32_t value);
    void     (*cmd)(void *ctx, uint8_t opcode);
};

struct spmi_master {
    struct spmi_master_ops ops;
    void                  *ctx;
    int                    last_state;
};

void spmi_master_init(struct spmi_master *m, const struct spmi_master_ops *ops, void *ctx);

int  spmi_master_write(struct spmi_master *m, uint8_t sid, uint16_t reg, uint8_t value);
int  spmi_master_read (struct spmi_master *m, uint8_t sid, uint16_t reg, uint8_t *out);
int  spmi_master_write_burst(struct spmi_master *m,
                             uint8_t sid,
                             uint16_t reg_base,
                             const uint8_t *bytes,
                             size_t count);
int  spmi_slave_trigger(struct spmi_master *m, uint8_t sid);

enum spmi_state spmi_last_state(const struct spmi_master *m);

/* Production helpers — single static SPMI master bound at AON MMIO. */
void pmc_spmi_init(void);
int  pmc_spmi_write_byte(uint8_t sid, uint16_t reg, uint8_t value);
int  pmc_spmi_read_byte(uint8_t sid, uint16_t reg, uint8_t *out);
int  pmc_spmi_write_burst(uint8_t sid, uint16_t reg_base, const uint8_t *bytes, size_t count);
int  pmc_spmi_slave_trigger(uint8_t sid);

#endif /* ELIZA_PMC_SPMI_H */
