/*
 * External PMIC power-up / down sequencer.
 *
 * Per-rail enable + voltage code commands are routed over SPMI v2.0 (primary)
 * or I2C-FM-plus (fallback). The catalog daughtercard contains 6-8 buck/LDO
 * ICs; per-rail addressing is set in board/kicad/.
 */

#include "pmc.h"
#include "spmi.h"

int i2c_master_write(uint8_t addr, uint8_t reg, uint8_t value);

/*
 * Planning-only SPMI sid + register addressing. Replaced when the
 * daughtercard schematic owner picks specific catalog parts.
 */
struct pmic_rail_map {
    uint8_t spmi_sid;
    uint8_t enable_reg;
    uint8_t voltage_reg;
};

static const struct pmic_rail_map g_rail_map[PMC_RAIL__COUNT] = {
    [PMC_RAIL_CPU_BIG]    = { .spmi_sid = 0x01, .enable_reg = 0x40, .voltage_reg = 0x41 },
    [PMC_RAIL_CPU_LITTLE] = { .spmi_sid = 0x01, .enable_reg = 0x50, .voltage_reg = 0x51 },
    [PMC_RAIL_NPU]        = { .spmi_sid = 0x01, .enable_reg = 0x60, .voltage_reg = 0x61 },
    [PMC_RAIL_GPU]        = { .spmi_sid = 0x02, .enable_reg = 0x40, .voltage_reg = 0x41 },
    [PMC_RAIL_SOC_FABRIC] = { .spmi_sid = 0x02, .enable_reg = 0x50, .voltage_reg = 0x51 },
    [PMC_RAIL_SRAM]       = { .spmi_sid = 0x02, .enable_reg = 0x60, .voltage_reg = 0x61 },
};

int pmc_pmic_power_up(enum pmc_rail rail)
{
    if (rail >= PMC_RAIL__COUNT) {
        return -1;
    }
    const struct pmic_rail_map *map = &g_rail_map[rail];
    /* Default to nominal mid-code at power-up; AVFS narrows from there. */
    int r = pmc_spmi_write_byte(map->spmi_sid, map->voltage_reg, 0x60);
    if (r != 0) {
        return r;
    }
    return pmc_spmi_write_byte(map->spmi_sid, map->enable_reg, 0x01);
}

int pmc_pmic_power_down(enum pmc_rail rail)
{
    if (rail >= PMC_RAIL__COUNT) {
        return -1;
    }
    const struct pmic_rail_map *map = &g_rail_map[rail];
    return pmc_spmi_write_byte(map->spmi_sid, map->enable_reg, 0x00);
}

int pmc_pmic_set_code(enum pmc_rail rail, uint8_t code)
{
    if (rail >= PMC_RAIL__COUNT) {
        return -1;
    }
    const struct pmic_rail_map *map = &g_rail_map[rail];
    return pmc_spmi_write_byte(map->spmi_sid, map->voltage_reg, code);
}
