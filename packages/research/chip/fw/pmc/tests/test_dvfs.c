#include "dvfs.h"
#include "pmc.h"

#include <assert.h>
#include <stdint.h>
#include <stdio.h>

static enum pmc_rail last_rail;
static uint8_t last_code;
static unsigned int pmic_set_code_calls;

int pmc_pmic_set_code(enum pmc_rail rail, uint8_t code)
{
    last_rail = rail;
    last_code = code;
    pmic_set_code_calls++;
    return 0;
}

static void test_only_tt_corner_is_available(void)
{
    const struct pmc_dvfs_table *tt = pmc_dvfs_table_for_corner(PMC_CORNER_TT);
    assert(tt != NULL);
    assert(tt->corner == PMC_CORNER_TT);
    assert(tt->rail_op_counts[PMC_RAIL_CPU_BIG] > 0u);

    assert(pmc_dvfs_table_for_corner(PMC_CORNER_SS) == NULL);
    assert(pmc_dvfs_table_for_corner(PMC_CORNER_FF) == NULL);
    assert(pmc_dvfs_table_for_corner(PMC_CORNER__COUNT) == NULL);
}

static void test_null_table_fails_closed(void)
{
    assert(pmc_dvfs_arbiter_init(NULL) == -1);
    assert(pmc_dvfs_set_frequency(PMC_RAIL_CPU_BIG, 800000000u) == -1);
    assert(pmic_set_code_calls == 0u);
}

static void test_tt_table_drives_matching_frequency(void)
{
    const struct pmc_dvfs_table *tt = pmc_dvfs_table_for_corner(PMC_CORNER_TT);
    assert(pmc_dvfs_arbiter_init(tt) == 0);

    assert(pmc_dvfs_set_frequency(PMC_RAIL_CPU_BIG, 800000000u) == 0);
    assert(pmic_set_code_calls == 1u);
    assert(last_rail == PMC_RAIL_CPU_BIG);
    assert(last_code == 0x60u);

    assert(pmc_dvfs_set_frequency(PMC_RAIL_CPU_BIG, 123u) == -2);
    assert(pmc_dvfs_set_frequency(PMC_RAIL__COUNT, 800000000u) == -1);
    assert(pmic_set_code_calls == 1u);
}

int main(void)
{
    test_only_tt_corner_is_available();
    test_null_table_fails_closed();
    test_tt_table_drives_matching_frequency();
    puts("fw/pmc/tests/test_dvfs: 3 cases passed");
    return 0;
}
