/*
 * Aggregates per-rail droop counters from the PMC mailbox into the
 * pmc_droop_counters structure. The hardware DROOP_REG_COUNT register
 * returns the total; per-rail counters are exposed in future mailbox
 * extensions (PMC_REG_DROOP_BASE; not yet allocated).
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
    /* Per-rail counters are aggregated on hardware; placeholder split. */
    uint32_t equal = out->total / PMC_DVFS_RAIL_COUNT;
    for (unsigned int i = 0; i < PMC_DVFS_RAIL_COUNT; ++i) {
        out->per_rail[i] = equal;
    }
}
