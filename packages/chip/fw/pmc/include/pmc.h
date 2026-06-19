/*
 * Eliza E1 — Power Management Core firmware shared types.
 *
 * Target: Ibex RV32IMC on AON island.
 * RTL mailbox register map source: rtl/power/power_pkg.sv (PMC_REG_*).
 */

#ifndef ELIZA_PMC_H
#define ELIZA_PMC_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PMC_DVFS_RAIL_COUNT      6u
#define PMC_DVFS_CODE_LSB_UV     6250u   /* 6.25 mV */
#define PMC_AVFS_UPDATE_US       100u    /* in-situ AVFS update period */
#define PMC_SAMPLE_HZ            200000000u

enum pmc_rail {
    PMC_RAIL_CPU_BIG = 0,
    PMC_RAIL_CPU_LITTLE = 1,
    PMC_RAIL_NPU = 2,
    PMC_RAIL_GPU = 3,
    PMC_RAIL_SOC_FABRIC = 4,
    PMC_RAIL_SRAM = 5,
    PMC_RAIL__COUNT = PMC_DVFS_RAIL_COUNT
};

enum pmc_corner {
    PMC_CORNER_SS = 0,
    PMC_CORNER_TT = 1,
    PMC_CORNER_FF = 2,
    PMC_CORNER__COUNT = 3
};

/* Mailbox register map — must match rtl/power/power_pkg.sv. */
#define PMC_REG_BASE             0x10010000u
#define PMC_REG_MBOX_TX_HEAD     (PMC_REG_BASE + 0x000u)
#define PMC_REG_MBOX_TX_DATA     (PMC_REG_BASE + 0x004u)
#define PMC_REG_MBOX_RX_HEAD     (PMC_REG_BASE + 0x008u)
#define PMC_REG_MBOX_RX_DATA     (PMC_REG_BASE + 0x00Cu)
#define PMC_REG_STATUS           (PMC_REG_BASE + 0x010u)
#define PMC_REG_CTRL             (PMC_REG_BASE + 0x014u)
#define PMC_REG_DROOP_COUNT      (PMC_REG_BASE + 0x020u)
#define PMC_REG_AVFS_STATUS      (PMC_REG_BASE + 0x024u)
/* Sticky droop event counter; reads return the running sum since last clear.
 * Writes are write-1-to-clear masks (write 0xFFFFFFFF for a full clear). */
#define PMC_REG_DROOP_STICKY     (PMC_REG_BASE + 0x028u)
#define PMC_REG_DVFS_BASE        (PMC_REG_BASE + 0x040u)

#define PMC_STATUS_TX_FULL       0u
#define PMC_STATUS_RX_VALID      1u
#define PMC_STATUS_BUSY          2u
#define PMC_STATUS_FAULT         3u

struct pmc_dvfs_op {
    uint32_t frequency_hz;
    uint8_t  nominal_code;
    uint8_t  min_code;
    uint8_t  max_code;
};

struct pmc_dvfs_table {
    enum pmc_corner corner;
    uint8_t process_temperature_c;
    struct pmc_dvfs_op *rail_ops[PMC_DVFS_RAIL_COUNT];
    size_t              rail_op_counts[PMC_DVFS_RAIL_COUNT];
};

struct pmc_avfs_state {
    uint8_t  target_code[PMC_DVFS_RAIL_COUNT];
    uint8_t  min_code[PMC_DVFS_RAIL_COUNT];
    uint8_t  max_code[PMC_DVFS_RAIL_COUNT];
    bool     fault[PMC_DVFS_RAIL_COUNT];
};

struct pmc_droop_counters {
    uint32_t per_rail[PMC_DVFS_RAIL_COUNT];
    uint32_t total;
};

/* Public API across the firmware translation units. */
void pmc_main(void);
int  pmc_dvfs_arbiter_init(const struct pmc_dvfs_table *tbl);
int  pmc_dvfs_set_frequency(enum pmc_rail rail, uint32_t frequency_hz);
int  pmc_pmic_power_up(enum pmc_rail rail);
int  pmc_pmic_power_down(enum pmc_rail rail);
int  pmc_pmic_set_code(enum pmc_rail rail, uint8_t code);
void pmc_droop_telemetry_tick(struct pmc_droop_counters *out);
void pmc_thermal_policy_tick(int8_t tj_c);

#endif /* ELIZA_PMC_H */
