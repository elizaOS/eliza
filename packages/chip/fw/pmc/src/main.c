/*
 * PMC firmware entry point.
 *
 * Boot sequence:
 *   1. Init AVFS state (max code from DVFS table TT corner placeholder).
 *   2. Bring up AON + PMC + SoC fabric + SRAM rails via PMIC.
 *   3. Enter scheduler loop:
 *        - drain RPMI mailbox
 *        - tick AVFS / DVFS arbiter every PMC_AVFS_UPDATE_US
 *        - tick thermal policy every 10 ms
 *        - update droop telemetry counters
 */

#include "pmc.h"
#include "rpmi.h"
#include "dvfs.h"

static struct pmc_avfs_state g_avfs;
static struct pmc_droop_counters g_droop;

static volatile uint32_t *mmio32(uintptr_t addr)
{
    return (volatile uint32_t *)addr;
}

static uint32_t pmc_mbox_status(void)
{
    return *mmio32(PMC_REG_STATUS);
}

static void pmc_boot_rails(void)
{
    /* Order matters: AON + PMC are already alive; SoC fabric first, then SRAM,
     * then the CPU/NPU/GPU clusters. */
    pmc_pmic_power_up(PMC_RAIL_SOC_FABRIC);
    pmc_pmic_power_up(PMC_RAIL_SRAM);
    pmc_pmic_power_up(PMC_RAIL_CPU_BIG);
    pmc_pmic_power_up(PMC_RAIL_CPU_LITTLE);
    pmc_pmic_power_up(PMC_RAIL_NPU);
    pmc_pmic_power_up(PMC_RAIL_GPU);
}

void pmc_main(void)
{
    const struct pmc_dvfs_table *tt = pmc_dvfs_table_for_corner(PMC_CORNER_TT);
    pmc_dvfs_arbiter_init(tt);
    pmc_boot_rails();

    while (1) {
        uint32_t status = pmc_mbox_status();
        if (status & (1u << PMC_STATUS_RX_VALID)) {
            uint8_t req_buf[RPMI_MAX_FRAME_BYTES];
            uint8_t resp_buf[RPMI_MAX_FRAME_BYTES];
            struct rpmi_frame req;
            struct rpmi_frame resp;
            size_t length = 0;

            /* Mailbox frame ingest is left to the RPMI server unit, which
             * uses the MBOX_RX_DATA register sequence. */
            if (rpmi_parse(req_buf, sizeof req_buf, &req)) {
                enum rpmi_status rs = rpmi_dispatch(&req, &resp);
                (void)rs;
                length = rpmi_serialize(&resp, resp_buf, sizeof resp_buf);
                (void)length;
                /* Write response back to MBOX_TX_DATA. */
            }
        }

        pmc_droop_telemetry_tick(&g_droop);
        pmc_thermal_policy_tick(/* tj_c = */ 25);
        /* AVFS update tick is driven by hardware AVFS_UPDATE_CYCLES; the
         * firmware only observes target_code via the mailbox. */
        (void)g_avfs;
    }
}
