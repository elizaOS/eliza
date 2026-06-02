/*
 * Aggregates per-rail droop counters from the PMC mailbox into the
 * pmc_droop_counters structure. The hardware PMC_REG_DROOP_COUNT register
 * returns the total. Current RTL does not expose per-rail readable counters,
 * so firmware clears the per-rail fields instead of inventing a split.
 */

#include "pmc.h"

static volatile uint32_t *droop_reg(void)
{
    return (volatile uint32_t *)PMC_REG_DROOP_COUNT;
}

void pmc_droop_telemetry_tick(struct pmc_droop_counters *out)
{
    if (!out) {
        return;
    }
    out->total = *droop_reg();
    for (unsigned int i = 0; i < PMC_DVFS_RAIL_COUNT; ++i) {
        out->per_rail[i] = 0u;
    }
}
