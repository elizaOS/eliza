"""cocotb tests for the e1 OTP controller (rtl/security/otp/e1_otp_map.sv, W4).

The DUT models three redundant physical rows per 32-bit word, shadow-loaded at
reset from the otp_row{0,1,2}_init_i provisioning buses. Tests exercise the
2-of-3 majority read, single-/double-row fault behavior, the lifecycle write
controller, rollback advance-only, and the after-LOCKED write lock — the
behavior specified by docs/security/otp-fuse-map.md §2-§4 over the partition
layout in docs/spec-db/tee-otp-fuse-map.json.
"""

import json
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

REPO = Path(__file__).resolve().parents[3]
FUSE_MAP = json.loads((REPO / "docs/spec-db/tee-otp-fuse-map.json").read_text())
PARTITIONS = {p["id"]: p for p in FUSE_MAP["partitions"]}

WORD_BITS = 32
OTP_WORDS = 32

# Lifecycle one-hot bit positions (otp-fuse-map.md §2).
LC_BLANK = 0
LC_DEV = 1
LC_MFG = 2
LC_LOCKED = 3
LC_RMA = 4
LC_SCRAP = 5

LIFECYCLE_OFF = PARTITIONS["lifecycle_state"]["offset"]
ROLLBACK_OFF = PARTITIONS["rollback_index"]["offset"]
CREATOR_OFF = PARTITIONS["creator_root_key"]["offset"]
DEBUG_AUTH_OFF = PARTITIONS["debug_auth_pubkey_hash"]["offset"]


def pack_rows(words: dict[int, int]) -> int:
    """Pack a {word_index: value} dict into the flat init-bus literal."""
    bus = 0
    for idx, value in words.items():
        bus |= (value & 0xFFFF_FFFF) << (idx * WORD_BITS)
    return bus


async def load(dut, row0, row1=None, row2=None):
    """Drive the three init buses and pulse reset to shadow-load them."""
    if row1 is None:
        row1 = row0
    if row2 is None:
        row2 = row0
    dut.otp_row0_init_i.value = pack_rows(row0)
    dut.otp_row1_init_i.value = pack_rows(row1)
    dut.otp_row2_init_i.value = pack_rows(row2)
    dut.auth_ok_i.value = 0
    dut.valid.value = 0
    dut.write.value = 0
    dut.addr.value = 0
    dut.wdata.value = 0
    dut.rst_n.value = 0
    await Timer(1, units="ns")
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def read_word(dut, addr):
    dut.addr.value = addr
    dut.write.value = 0
    dut.valid.value = 1
    await Timer(1, units="ns")
    value = int(dut.rdata.value)
    await RisingEdge(dut.clk)
    dut.valid.value = 0
    await Timer(1, units="ns")
    return value


async def write_word(dut, addr, data, auth=0):
    dut.addr.value = addr
    dut.wdata.value = data
    dut.auth_ok_i.value = auth
    dut.write.value = 1
    dut.valid.value = 1
    await RisingEdge(dut.clk)
    dut.valid.value = 0
    dut.write.value = 0
    dut.auth_ok_i.value = 0
    await Timer(1, units="ns")


@cocotb.test()
async def reset_shadow_load(dut):
    """At reset the shadow rows load the macro image and reads return it."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    image = {CREATOR_OFF: 0xDEAD_BEEF, CREATOR_OFF + 1: 0x1234_5678, DEBUG_AUTH_OFF: 0xCAFE_F00D}
    await load(dut, image)
    assert await read_word(dut, CREATOR_OFF) == 0xDEAD_BEEF
    assert await read_word(dut, CREATOR_OFF + 1) == 0x1234_5678
    assert await read_word(dut, DEBUG_AUTH_OFF) == 0xCAFE_F00D
    assert int(dut.otp_parity_fault_o.value) == 0


@cocotb.test()
async def majority_vote_unanimous(dut):
    """Three identical rows produce the exact value with no fault."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await load(dut, {CREATOR_OFF: 0xA5A5_5A5A})
    assert await read_word(dut, CREATOR_OFF) == 0xA5A5_5A5A
    assert int(dut.otp_parity_fault_o.value) == 0


@cocotb.test()
async def single_row_fault_tolerated(dut):
    """One corrupt row is corrected by majority; no parity fault."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    good = 0x0F0F_0F0F
    await load(
        dut,
        {CREATOR_OFF: good},
        {CREATOR_OFF: good},
        {CREATOR_OFF: 0xFFFF_FFFF},  # row2 corrupt
    )
    assert await read_word(dut, CREATOR_OFF) == good
    assert int(dut.otp_parity_fault_o.value) == 0


@cocotb.test()
async def double_row_fault_raises_parity(dut):
    """Two corrupt rows defeat the majority and raise the hard fault."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    # Three mutually disagreeing rows: each deviates from the bitwise majority,
    # so two-or-more rows are corrupt and the majority is untrustworthy.
    await load(
        dut,
        {CREATOR_OFF: 0x0000_00FF},
        {CREATOR_OFF: 0x0000_FF00},
        {CREATOR_OFF: 0x00FF_0000},
    )
    await Timer(1, units="ns")
    assert int(dut.otp_parity_fault_o.value) == 1


@cocotb.test()
async def legal_lifecycle_transition_accepted(dut):
    """BLANK->MFG->LOCKED is accepted and reflected in the decoded state."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    # BLANK = unprogrammed (all-zero) lifecycle word.
    await load(dut, {LIFECYCLE_OFF: 0x0000_0000})
    assert int(dut.lifecycle_state_o.value) == 0

    # BLANK -> MFG. Writes carry the full intended (OR-accumulated) value.
    await write_word(dut, LIFECYCLE_OFF, 1 << LC_MFG)
    assert int(dut.tamper_event_o.value) == 0
    assert int(dut.lifecycle_state_o.value) & (1 << LC_MFG)

    # MFG -> LOCKED: keep the MFG bit set (monotonic OR).
    await write_word(dut, LIFECYCLE_OFF, (1 << LC_MFG) | (1 << LC_LOCKED))
    assert int(dut.tamper_event_o.value) == 0
    assert int(dut.lifecycle_state_o.value) & (1 << LC_LOCKED)


@cocotb.test()
async def illegal_lifecycle_transition_dropped_with_tamper(dut):
    """A forbidden DEV->LOCKED transition is dropped and pulses tamper."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await load(dut, {LIFECYCLE_OFF: 1 << LC_DEV})

    # DEV->LOCKED forbidden (only MFG->LOCKED is legal). Keep DEV bit set.
    await write_word(dut, LIFECYCLE_OFF, (1 << LC_DEV) | (1 << LC_LOCKED))
    assert int(dut.tamper_event_o.value) == 1
    assert not (int(dut.lifecycle_state_o.value) & (1 << LC_LOCKED))
    # State unchanged: still DEV.
    assert int(dut.lifecycle_state_o.value) == (1 << LC_DEV)


@cocotb.test()
async def locked_to_rma_requires_auth(dut):
    """LOCKED->RMA is dropped without auth and accepted with auth."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    locked = (1 << LC_MFG) | (1 << LC_LOCKED)
    await load(dut, {LIFECYCLE_OFF: locked})

    await write_word(dut, LIFECYCLE_OFF, locked | (1 << LC_RMA), auth=0)
    assert int(dut.tamper_event_o.value) == 1
    assert not (int(dut.lifecycle_state_o.value) & (1 << LC_RMA))

    await write_word(dut, LIFECYCLE_OFF, locked | (1 << LC_RMA), auth=1)
    assert int(dut.tamper_event_o.value) == 0
    assert int(dut.lifecycle_state_o.value) & (1 << LC_RMA)


@cocotb.test()
async def scrap_allowed_from_any_state(dut):
    """*->SCRAP is always allowed (here from DEV)."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await load(dut, {LIFECYCLE_OFF: 1 << LC_DEV})
    await write_word(dut, LIFECYCLE_OFF, (1 << LC_DEV) | (1 << LC_SCRAP))
    assert int(dut.tamper_event_o.value) == 0
    assert int(dut.lifecycle_state_o.value) & (1 << LC_SCRAP)


@cocotb.test()
async def rollback_advance_only(dut):
    """Rollback unary counter advances (OR) but cannot be un-set."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await load(dut, {ROLLBACK_OFF: 0x0000_0003})  # two fuses blown

    # Advance: set another unary bit.
    await write_word(dut, ROLLBACK_OFF, 0x0000_0007)
    assert int(dut.tamper_event_o.value) == 0
    assert await read_word(dut, ROLLBACK_OFF) == 0x0000_0007

    # Attempt to clear a programmed bit: dropped + tamper, value unchanged.
    await write_word(dut, ROLLBACK_OFF, 0x0000_0001)
    assert int(dut.tamper_event_o.value) == 1
    assert await read_word(dut, ROLLBACK_OFF) == 0x0000_0007


@cocotb.test()
async def root_key_write_locked_after_locked(dut):
    """root_key_hash is programmable in MFG and locked once LOCKED."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())

    # MFG window open: creator root key programmable.
    await load(dut, {LIFECYCLE_OFF: 1 << LC_MFG, CREATOR_OFF: 0x0000_0000})
    await write_word(dut, CREATOR_OFF, 0xABCD_0000)
    assert int(dut.tamper_event_o.value) == 0
    assert await read_word(dut, CREATOR_OFF) == 0xABCD_0000

    # LOCKED: write to root key dropped (no auth), value unchanged.
    await load(dut, {LIFECYCLE_OFF: 1 << LC_LOCKED, CREATOR_OFF: 0xABCD_0000})
    await write_word(dut, CREATOR_OFF, 0xABCD_FFFF, auth=0)
    assert int(dut.tamper_event_o.value) == 1
    assert await read_word(dut, CREATOR_OFF) == 0xABCD_0000

    # LOCKED with signed auth: root rotation permitted (OR-only).
    await write_word(dut, CREATOR_OFF, 0xABCD_FFFF, auth=1)
    assert int(dut.tamper_event_o.value) == 0
    assert await read_word(dut, CREATOR_OFF) == 0xABCD_FFFF
