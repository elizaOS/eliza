"""Mirror of rtl/power/power_pkg.sv constants for cocotb tests.

Any change here must also update rtl/power/power_pkg.sv. Cocotb cannot read
SystemVerilog packages directly across simulators, so the test harness keeps
a small mirror. The contract is enforced by docs/pd/droop-detection.md and
docs/pd/avfs.md.
"""

DVFS_CODE_WIDTH = 8
DVFS_STEP_UV = 6250
DVFS_RAIL_COUNT = 6

DROOP_RO_STAGES = 31
DROOP_COUNTER_WIDTH = 16
DROOP_SAMPLE_HZ = 200_000_000
DROOP_DEFAULT_THRESHOLD = 2048
DROOP_CONFIRM_SAMPLES = 2

CLKSTRETCH_PHASE_TAPS = 16
CLKSTRETCH_SELECT_WIDTH = 4
CLKSTRETCH_CYCLES = 1

DLDO_SLICE_COUNT = 32
DLDO_RESPONSE_NS = 20
DLDO_DROP_PCT_X100 = 500

AVFS_UPDATE_CYCLES = 20_000
AVFS_CANARY_COUNT = 16

PMC_MBOX_AW = 12
PMC_MBOX_DW = 32

PMC_REG_MBOX_TX_HEAD = 0x000
PMC_REG_MBOX_TX_DATA = 0x004
PMC_REG_MBOX_RX_HEAD = 0x008
PMC_REG_MBOX_RX_DATA = 0x00C
PMC_REG_STATUS = 0x010
PMC_REG_CTRL = 0x014
PMC_REG_DROOP_COUNT = 0x020
PMC_REG_AVFS_STATUS = 0x024
PMC_REG_DROOP_STICKY = 0x028
PMC_REG_DVFS_BASE = 0x040
