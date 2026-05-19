/*
 * Thermal throttle ladder.
 *
 * Steps based on docs/architecture-optimization/soc-optimized-operating-point.yaml
 * worst modeled die temperature target of 95 C and sub-report Section A.5
 * mobile-class peer envelope.
 */

#include "pmc.h"

#define TJ_NOMINAL_C    25
#define TJ_WARN_C       85
#define TJ_THROTTLE_C   95
#define TJ_CRITICAL_C  105

static enum {
    POL_NOMINAL = 0,
    POL_WARN,
    POL_THROTTLE,
    POL_CRITICAL
} g_state = POL_NOMINAL;

void pmc_thermal_policy_tick(int8_t tj_c)
{
    if (tj_c >= TJ_CRITICAL_C) {
        if (g_state != POL_CRITICAL) {
            g_state = POL_CRITICAL;
            /* Emergency: force CPU big + NPU + GPU to min DVFS code. */
            pmc_pmic_set_code(PMC_RAIL_CPU_BIG, 0x58);
            pmc_pmic_set_code(PMC_RAIL_NPU,     0x58);
            pmc_pmic_set_code(PMC_RAIL_GPU,     0x58);
        }
    } else if (tj_c >= TJ_THROTTLE_C) {
        if (g_state != POL_THROTTLE) {
            g_state = POL_THROTTLE;
            /* Cap to mid-tier operating point. */
            pmc_dvfs_set_frequency(PMC_RAIL_CPU_BIG, 1600000000u);
            pmc_dvfs_set_frequency(PMC_RAIL_NPU,     1200000000u);
        }
    } else if (tj_c >= TJ_WARN_C) {
        g_state = POL_WARN;
    } else {
        g_state = POL_NOMINAL;
    }
}
