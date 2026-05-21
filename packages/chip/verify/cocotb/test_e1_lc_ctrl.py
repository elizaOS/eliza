"""cocotb suite for rtl/security/lc/e1_lc_ctrl.sv (W5).

Exercises the 6-state one-hot lifecycle controller and the signed debug-auth
interface that replaced the retired 2-bit e1_lifecycle.sv. Coverage:

  - legal transitions (BLANK->DEV, BLANK->MFG, MFG->LOCKED, LOCKED->RMA with
    signed auth, *->SCRAP) and illegal-transition drop + tamper pulse;
  - per-state per-port debug gating (jtag/swd/etm/rom_uart) including the
    debug_disable kill switch and LOCKED/SCRAP lockdown;
  - debug grant ONLY on the verifier pass strobe (never via XOR/comparison),
    bound to a CSRNG nonce and boot_counter;
  - SCRAP total lockdown;
  - RMA gated by signed auth and rma_wipe_done.

The DUT is elaborated as the cocotb TOPLEVEL; signal names match its ports.
"""

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

# One-hot lifecycle states (otp-fuse-map.md §2, boot-image-format.md §5).
ST_BLANK = 0x01
ST_DEV = 0x02
ST_MFG = 0x04
ST_LOCKED = 0x08
ST_RMA = 0x10
ST_SCRAP = 0x20

# DEBUG_ENABLES read word bit layout: bit0=jtag bit1=swd bit2=etm bit3=rom_uart.
ADDR_LIFECYCLE = 0x00
ADDR_DEBUG_ENABLES = 0x01
ADDR_DEBUG_DISABLE = 0x02
ADDR_AUTH_NONCE = 0x03
ADDR_AUTH_STATUS = 0x04
ADDR_BOOT_COUNTER = 0x05

# debug_disable per-port kill switch bit positions.
DIS_JTAG = 1 << 0
DIS_SWD = 1 << 1
DIS_ETM = 1 << 2
DIS_ROM_UART = 1 << 3


def _idle(dut):
    dut.valid.value = 0
    dut.write.value = 0
    dut.addr.value = 0
    dut.wdata.value = 0
    dut.debug_disable_i.value = 0
    dut.boot_counter_i.value = 0
    dut.rma_wipe_done_i.value = 0
    dut.lc_trans_req_i.value = 0
    dut.lc_trans_target_i.value = 0
    dut.rma_auth_valid_i.value = 0
    dut.csrng_nonce_i.value = 0
    dut.csrng_nonce_valid_i.value = 0
    dut.dbg_auth_req_i.value = 0
    dut.dbg_auth_verified_i.value = 0


async def reset(dut, fuse_state=ST_BLANK):
    """Hold reset, drive the lifecycle fuse, then release."""
    dut.rst_n.value = 0
    _idle(dut)
    dut.lifecycle_fuse_i.value = fuse_state
    await Timer(1, units="ns")
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    # The local state register tracks the fuse one cycle after release.
    await RisingEdge(dut.clk)
    await RisingEdge(dut.clk)


async def read32(dut, addr):
    dut.addr.value = addr
    dut.write.value = 0
    dut.valid.value = 1
    await Timer(1, units="ns")
    value = int(dut.rdata.value)
    await RisingEdge(dut.clk)
    dut.valid.value = 0
    await Timer(1, units="ns")
    return value


async def request_transition(dut, target, *, rma_auth=0):
    """Pulse a one-cycle transition request and return the captured outputs."""
    dut.lc_trans_target_i.value = target
    dut.rma_auth_valid_i.value = rma_auth
    dut.lc_trans_req_i.value = 1
    await Timer(1, units="ns")
    accept = int(dut.lc_trans_accept_o.value)
    tamper = int(dut.tamper_event_o.value)
    await RisingEdge(dut.clk)
    dut.lc_trans_req_i.value = 0
    dut.rma_auth_valid_i.value = 0
    await RisingEdge(dut.clk)
    return accept, tamper


async def grant_debug(dut, nonce=0xABCD_1234):
    """Run the signed challenge handshake; returns the granted strobe."""
    # Offer fresh entropy and request the auth window.
    dut.csrng_nonce_i.value = nonce
    dut.csrng_nonce_valid_i.value = 1
    dut.dbg_auth_req_i.value = 1
    await RisingEdge(dut.clk)
    dut.dbg_auth_req_i.value = 0
    # Window should now be open with the latched nonce.
    await Timer(1, units="ns")
    window = int(dut.dbg_auth_window_o.value)
    latched_nonce = int(dut.dbg_auth_nonce_o.value)
    # Pulse the verifier pass strobe for one cycle.
    dut.dbg_auth_verified_i.value = 1
    await RisingEdge(dut.clk)
    dut.dbg_auth_verified_i.value = 0
    dut.csrng_nonce_valid_i.value = 0
    await RisingEdge(dut.clk)
    granted = int(dut.debug_auth_granted_o.value)
    return window, latched_nonce, granted


# ---------------------------------------------------------------------------
# Lifecycle transition coverage
# ---------------------------------------------------------------------------


@cocotb.test()
async def legal_transitions_accepted(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())

    for start, target in (
        (ST_BLANK, ST_DEV),
        (ST_BLANK, ST_MFG),
        (ST_MFG, ST_LOCKED),
        (ST_DEV, ST_SCRAP),
        (ST_LOCKED, ST_SCRAP),
    ):
        await reset(dut, fuse_state=start)
        accept, tamper = await request_transition(dut, target)
        assert accept == 1, f"{start:#x}->{target:#x} should be accepted"
        assert tamper == 0, f"{start:#x}->{target:#x} should not tamper"
        assert int(dut.lifecycle_state_o.value) == target
        assert int(dut.lc_trans_accept_o.value) == 0  # pulse de-asserted


@cocotb.test()
async def locked_to_rma_requires_signed_auth(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())

    # Without RMA authorization the transition is dropped and tamper pulses.
    await reset(dut, fuse_state=ST_LOCKED)
    accept, tamper = await request_transition(dut, ST_RMA, rma_auth=0)
    assert accept == 0
    assert tamper == 1
    assert int(dut.lifecycle_state_o.value) == ST_LOCKED

    # With signed RMA authorization the transition is accepted.
    await reset(dut, fuse_state=ST_LOCKED)
    accept, tamper = await request_transition(dut, ST_RMA, rma_auth=1)
    assert accept == 1
    assert tamper == 0
    assert int(dut.lifecycle_state_o.value) == ST_RMA


@cocotb.test()
async def illegal_transitions_dropped_and_tamper(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())

    illegal = (
        (ST_DEV, ST_MFG),       # DEV->MFG forbidden
        (ST_DEV, ST_LOCKED),    # DEV->LOCKED forbidden
        (ST_LOCKED, ST_DEV),    # backward
        (ST_RMA, ST_LOCKED),    # RMA->LOCKED forbidden
        (ST_DEV, ST_BLANK),     # anything->BLANK forbidden
        (ST_MFG, 0x06),         # non-one-hot target
        (ST_MFG, 0x00),         # null target
    )
    for start, target in illegal:
        await reset(dut, fuse_state=start)
        accept, tamper = await request_transition(dut, target)
        assert accept == 0, f"{start:#x}->{target:#x} must be dropped"
        assert tamper == 1, f"{start:#x}->{target:#x} must raise tamper"
        assert int(dut.lifecycle_state_o.value) == start


# ---------------------------------------------------------------------------
# Per-state debug gating
# ---------------------------------------------------------------------------


def _enables(dut):
    return (
        int(dut.jtag_enable_o.value),
        int(dut.swd_enable_o.value),
        int(dut.etm_enable_o.value),
        int(dut.rom_uart_full_o.value),
    )


@cocotb.test()
async def debug_open_in_blank_and_dev(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    for state in (ST_BLANK, ST_DEV):
        await reset(dut, fuse_state=state)
        assert _enables(dut) == (1, 1, 1, 1), f"state {state:#x} should be open"


@cocotb.test()
async def debug_disabled_in_locked(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut, fuse_state=ST_LOCKED)
    assert _enables(dut) == (0, 0, 0, 0), "LOCKED disables direct debug"
    # A verifier strobe must NOT grant debug in LOCKED.
    _, _, granted = await grant_debug(dut)
    assert granted == 0
    assert _enables(dut) == (0, 0, 0, 0)


@cocotb.test()
async def debug_disable_kill_switch(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut, fuse_state=ST_DEV)
    dut.debug_disable_i.value = DIS_JTAG | DIS_ETM
    await Timer(1, units="ns")
    jtag, swd, etm, uart = _enables(dut)
    assert jtag == 0 and etm == 0, "killed ports forced off"
    assert swd == 1 and uart == 1, "un-killed ports stay open"


# ---------------------------------------------------------------------------
# Signed debug-auth grant
# ---------------------------------------------------------------------------


@cocotb.test()
async def mfg_debug_requires_verified_strobe(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut, fuse_state=ST_MFG)

    # Before auth, gated ports are closed.
    assert _enables(dut) == (0, 0, 0, 0)

    # Open the window without ever asserting the verifier strobe: no grant.
    dut.csrng_nonce_i.value = 0xCAFE_F00D
    dut.csrng_nonce_valid_i.value = 1
    dut.dbg_auth_req_i.value = 1
    await RisingEdge(dut.clk)
    dut.dbg_auth_req_i.value = 0
    await RisingEdge(dut.clk)
    assert int(dut.dbg_auth_window_o.value) == 1
    assert int(dut.debug_auth_granted_o.value) == 0, "no grant without strobe"
    assert _enables(dut) == (0, 0, 0, 0)

    # Now pulse the verifier strobe -> grant.
    dut.dbg_auth_verified_i.value = 1
    await RisingEdge(dut.clk)
    dut.dbg_auth_verified_i.value = 0
    await RisingEdge(dut.clk)
    assert int(dut.debug_auth_granted_o.value) == 1
    # jtag/swd/etm now open; rom_uart stays gated (verbose only in BLANK/DEV).
    jtag, swd, etm, uart = _enables(dut)
    assert (jtag, swd, etm) == (1, 1, 1)
    assert uart == 0


@cocotb.test()
async def nonce_is_boot_bound_csrng(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut, fuse_state=ST_MFG)
    dut.boot_counter_i.value = 0x0000_002A
    await Timer(1, units="ns")

    window, latched_nonce, granted = await grant_debug(dut, nonce=0x1357_9BDF)
    assert window == 1
    assert latched_nonce == 0x1357_9BDF, "nonce comes from CSRNG entropy"
    assert granted == 1
    # The boot_counter the nonce is bound to is exposed for message rebuild.
    assert await read32(dut, ADDR_BOOT_COUNTER) == 0x0000_002A
    assert await read32(dut, ADDR_AUTH_NONCE) == 0x1357_9BDF


# ---------------------------------------------------------------------------
# SCRAP lockdown and RMA gating
# ---------------------------------------------------------------------------


@cocotb.test()
async def scrap_locks_everything(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut, fuse_state=ST_SCRAP)
    assert _enables(dut) == (0, 0, 0, 0)
    # No auth can revive a scrapped device.
    _, _, granted = await grant_debug(dut)
    assert granted == 0
    assert _enables(dut) == (0, 0, 0, 0)


@cocotb.test()
async def rma_debug_gated_by_wipe_done(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())

    # RMA without wipe_done: auth cannot be granted, debug stays closed.
    await reset(dut, fuse_state=ST_RMA)
    dut.rma_wipe_done_i.value = 0
    await Timer(1, units="ns")
    _, _, granted = await grant_debug(dut)
    assert granted == 0, "RMA debug must wait for rma_wipe_done"
    assert _enables(dut) == (0, 0, 0, 0)

    # RMA with wipe_done: signed auth grants gated debug.
    await reset(dut, fuse_state=ST_RMA)
    dut.rma_wipe_done_i.value = 1
    await Timer(1, units="ns")
    _, _, granted = await grant_debug(dut)
    assert granted == 1
    jtag, swd, etm, uart = _enables(dut)
    assert (jtag, swd, etm) == (1, 1, 1)
    assert uart == 0


# ---------------------------------------------------------------------------
# MMIO status window is read-only
# ---------------------------------------------------------------------------


@cocotb.test()
async def status_window_read_only(dut):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut, fuse_state=ST_DEV)

    assert await read32(dut, ADDR_LIFECYCLE) == ST_DEV
    assert await read32(dut, ADDR_DEBUG_ENABLES) == 0b1111

    # A write to the status window must not change lifecycle or grant debug.
    dut.addr.value = ADDR_LIFECYCLE
    dut.wdata.value = ST_SCRAP
    dut.write.value = 1
    dut.valid.value = 1
    await RisingEdge(dut.clk)
    dut.valid.value = 0
    dut.write.value = 0
    await RisingEdge(dut.clk)
    assert int(dut.lifecycle_state_o.value) == ST_DEV
    assert await read32(dut, ADDR_LIFECYCLE) == ST_DEV
