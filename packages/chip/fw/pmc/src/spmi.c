/*
 * SPMI v2.0 master skeleton.
 *
 * Bit-bangs against the SCLK / SDATA pins exposed by rtl/power/pmc_top.sv.
 * Final implementation uses a hardware SPMI master accelerator block on
 * AON; this skeleton documents the protocol command set and is exercised by
 * the loopback test in verify/cocotb/power/test_pmc_mailbox.py.
 */

#include "pmc.h"

#include <stdint.h>

#define SPMI_CMD_EXT_WRITEL  0x30u
#define SPMI_CMD_EXT_READL   0x38u

static volatile uint32_t *spmi_ctrl(void)
{
    /* Planning-only mmio base — bound at integration. */
    return (volatile uint32_t *)0x10010100u;
}

int spmi_master_write(uint8_t sid, uint16_t reg, uint8_t value)
{
    volatile uint32_t *ctrl = spmi_ctrl();
    uint32_t pkt = ((uint32_t)SPMI_CMD_EXT_WRITEL << 24) |
                   ((uint32_t)sid << 16) |
                   ((uint32_t)reg << 4) |
                   (uint32_t)value;
    *ctrl = pkt;
    /* Busy-wait on ack; release blocker: replace with hardware IRQ + timeout. */
    for (int i = 0; i < 1024; ++i) {
        if ((*ctrl >> 31) == 0u) {
            return 0;
        }
    }
    return -1;
}

int spmi_master_read(uint8_t sid, uint16_t reg, uint8_t *out)
{
    if (!out) {
        return -1;
    }
    volatile uint32_t *ctrl = spmi_ctrl();
    uint32_t pkt = ((uint32_t)SPMI_CMD_EXT_READL << 24) |
                   ((uint32_t)sid << 16) |
                   ((uint32_t)reg << 4);
    *ctrl = pkt;
    for (int i = 0; i < 1024; ++i) {
        uint32_t state = *ctrl;
        if ((state >> 31) == 0u) {
            *out = (uint8_t)(state & 0xffu);
            return 0;
        }
    }
    return -1;
}
