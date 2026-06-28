/*
 * I2C-FM-plus (1 MHz) fallback master for bring-up board.
 *
 * Selected only when the daughtercard fuse / PMC ctrl bit forces I2C mode.
 */

#include "pmc.h"

#include <stdint.h>

static volatile uint32_t *i2c_ctrl(void)
{
    return (volatile uint32_t *)0x10010200u;
}

int i2c_master_write(uint8_t addr, uint8_t reg, uint8_t value)
{
    volatile uint32_t *ctrl = i2c_ctrl();
    uint32_t pkt = ((uint32_t)addr << 16) | ((uint32_t)reg << 8) | (uint32_t)value;
    *ctrl = pkt | (1u << 31);
    for (int i = 0; i < 4096; ++i) {
        if ((*ctrl >> 31) == 0u) {
            return ((*ctrl >> 30) & 1u) ? -1 : 0;
        }
    }
    return -1;
}

int i2c_master_read(uint8_t addr, uint8_t reg, uint8_t *out)
{
    if (!out) {
        return -1;
    }
    volatile uint32_t *ctrl = i2c_ctrl();
    uint32_t pkt = ((uint32_t)addr << 16) | ((uint32_t)reg << 8) | (1u << 31) | (1u << 29);
    *ctrl = pkt;
    for (int i = 0; i < 4096; ++i) {
        uint32_t state = *ctrl;
        if ((state >> 31) == 0u) {
            if ((state >> 30) & 1u) {
                return -1;
            }
            *out = (uint8_t)(state & 0xffu);
            return 0;
        }
    }
    return -1;
}
