"""CLINT timer interrupt entry contract scaffold.

The v0 contract fabric (e1_linux_soc_contract) does not yet instantiate
a CLINT. This file pins the future contract so the test lights up when the
Chipyard Rocket wrapper drops in (docs/rtl/cpu-config-selection.md).

CLINT register map target (matches Chipyard/SiFive convention):
    base = 0x0200_0000
    +0x0000  msip[0]                (RW32)
    +0x4000  mtimecmp[0]            (RW64)
    +0xBFF8  mtime                  (RO64)

Until a CLINT lands in the SoC RTL, these tests are skipped but elaborate
cleanly. A reviewer flipping the skip flag should also wire the DUT.
"""

import cocotb

CLINT_BASE = 0x0200_0000
CLINT_MSIP = CLINT_BASE + 0x0000
CLINT_MTIMECMP = CLINT_BASE + 0x4000
CLINT_MTIME = CLINT_BASE + 0xBFF8


@cocotb.test(skip=True)
async def clint_timer_irq_fires_when_mtime_ge_mtimecmp(dut):
    """Set mtimecmp = mtime + N, wait, assert mtip rises on cpu_timer_irq."""
    raise NotImplementedError("Wire after CLINT lands in e1_linux_soc_contract via Rocket wrapper.")


@cocotb.test(skip=True)
async def clint_msip_software_interrupt(dut):
    """Write 1 to msip[0], assert cpu_software_irq rises within one cycle."""
    raise NotImplementedError("Wire after CLINT msip port appears on e1_linux_soc_contract.")


@cocotb.test(skip=True)
async def clint_mtime_monotonic(dut):
    """Read mtime twice with cycles between, second value must exceed first."""
    raise NotImplementedError("Wire after CLINT lands.")
