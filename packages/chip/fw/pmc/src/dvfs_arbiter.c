/*
 * DVFS arbiter: per-rail operating-point lookup. The TT characterization seed
 * table is compiled in; SS/FF tables are absent until generated from
 * docs/pd/dvfs-tables/.
 */

#include "dvfs.h"
#include "pmc.h"

#include <string.h>

static struct pmc_dvfs_op tt_cpu_big[] = {
    { 800000000u,  0x60, 0x58, 0x68 },
    { 1600000000u, 0x78, 0x70, 0x80 },
    { 2400000000u, 0x90, 0x88, 0x98 },
    { 3200000000u, 0xB0, 0xA8, 0xC0 }
};

static struct pmc_dvfs_op tt_cpu_little[] = {
    { 600000000u,  0x50, 0x48, 0x58 },
    { 1200000000u, 0x68, 0x60, 0x70 },
    { 1800000000u, 0x80, 0x78, 0x88 }
};

static struct pmc_dvfs_op tt_npu[] = {
    { 800000000u,  0x60, 0x58, 0x68 },
    { 1200000000u, 0x80, 0x78, 0x88 },
    { 1600000000u, 0x98, 0x90, 0xA0 }
};

static struct pmc_dvfs_op tt_gpu[] = {
    { 600000000u,  0x60, 0x58, 0x68 },
    { 1000000000u, 0x80, 0x78, 0x88 }
};

static struct pmc_dvfs_op tt_soc_fabric[] = {
    { 1000000000u, 0x78, 0x70, 0x80 },
    { 1500000000u, 0x88, 0x80, 0x90 }
};

static struct pmc_dvfs_op tt_sram[] = {
    { 1600000000u, 0x90, 0x80, 0x98 },
    { 2400000000u, 0xA0, 0x98, 0xA8 }
};

static const struct pmc_dvfs_table tt_table = {
    .corner = PMC_CORNER_TT,
    .process_temperature_c = 25,
    .rail_ops = {
        tt_cpu_big, tt_cpu_little, tt_npu, tt_gpu, tt_soc_fabric, tt_sram
    },
    .rail_op_counts = {
        sizeof(tt_cpu_big) / sizeof(tt_cpu_big[0]),
        sizeof(tt_cpu_little) / sizeof(tt_cpu_little[0]),
        sizeof(tt_npu) / sizeof(tt_npu[0]),
        sizeof(tt_gpu) / sizeof(tt_gpu[0]),
        sizeof(tt_soc_fabric) / sizeof(tt_soc_fabric[0]),
        sizeof(tt_sram) / sizeof(tt_sram[0])
    }
};

static const struct pmc_dvfs_table *g_active_table;

const struct pmc_dvfs_table *pmc_dvfs_table_for_corner(enum pmc_corner corner)
{
    switch (corner) {
    case PMC_CORNER_TT:
        return &tt_table;
    case PMC_CORNER_SS:
    case PMC_CORNER_FF:
    case PMC_CORNER__COUNT:
    default:
        return NULL;
    }
}

int pmc_dvfs_arbiter_init(const struct pmc_dvfs_table *tbl)
{
    if (!tbl) {
        g_active_table = NULL;
        return -1;
    }
    g_active_table = tbl;
    return 0;
}

int pmc_dvfs_set_frequency(enum pmc_rail rail, uint32_t frequency_hz)
{
    if (!g_active_table || rail >= PMC_RAIL__COUNT) {
        return -1;
    }
    const struct pmc_dvfs_op *ops = g_active_table->rail_ops[rail];
    size_t count = g_active_table->rail_op_counts[rail];
    const struct pmc_dvfs_op *match = NULL;
    for (size_t i = 0; i < count; ++i) {
        if (ops[i].frequency_hz == frequency_hz) {
            match = &ops[i];
            break;
        }
    }
    if (!match) {
        return -2;
    }
    return pmc_pmic_set_code(rail, match->nominal_code);
}
