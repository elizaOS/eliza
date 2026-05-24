"""cocotb suite for the E1 IOPMP (rtl/iommu/e1_iopmp.sv).

The IOPMP is the source-ID-gated region permission layer of the secure-I/O lane
(docs/security/tee-plan/03-secure-io-iommu-npu.md S1, work item P1.3). It
enforces, per DMA source ID, an address-range + R/W/X permission with
default-deny, programmed and locked by the RoT before the platform is released.

The policy under test is driven from docs/spec-db/tee-iopmp-source-id-map.json
so the RTL and the policy model agree on the per-master source IDs and on which
shared regions each master may reach. The JSON declares masters (source IDs) and
the shared regions each may touch; this test assigns each shared region a
deterministic NAPOT address range and programs one IOPMP entry per region with
the SRCMD membership = the masters whose allowedSharedRegions include it.

Contracts:
  * program entries during the unlocked RoT window, then lock;
  * a permitted (source ID, addr, op) passes;
  * a non-matching source ID is denied (default-deny);
  * a write to a read-only region is denied (wrong permission);
  * an out-of-range address is denied;
  * a programming write after lock is dropped;
  * the first violation is latched (source ID, addr, type) for the RoT to read;
  * policy_ready_o / locked_o drive the RoT reset sequencer handshake.
"""

from __future__ import annotations

import json
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

REPO = Path(__file__).resolve().parents[3]
POLICY = json.loads((REPO / "docs/spec-db/tee-iopmp-source-id-map.json").read_text())

# ---------------------------------------------------------------------------
# Register map (mirrors rtl/iommu/e1_iopmp_pkg.sv).
# ---------------------------------------------------------------------------
OFFS_CTRL = 0x000
OFFS_STATUS = 0x004
OFFS_ERR_INFO = 0x008
OFFS_ERR_SRCID = 0x00C
OFFS_ERR_ADDR_LO = 0x010
OFFS_ERR_ADDR_HI = 0x014
OFFS_ENTRY_BASE = 0x100
ENTRY_STRIDE_WORDS = 8
ENTRY_STRIDE_BYTES = ENTRY_STRIDE_WORDS * 4

# Entry sub-word byte offsets.
E_ADDR_LO = 0x0
E_ADDR_HI = 0x4
E_CFG = 0x8
E_SRCMD_LO = 0xC
E_SRCMD_HI = 0x10

# CTRL bits.
CTRL_ENABLE = 1 << 0
CTRL_LOCK = 1 << 1

# STATUS bits.
STATUS_LOCKED = 1 << 0
STATUS_ENABLE = 1 << 1
STATUS_POLICY_READY = 1 << 2

# ERR_INFO bits.
ERR_VALID = 1 << 0

# CFG bits.
A_OFF = 0
A_NAPOT = 1
CFG_R = 1 << 2
CFG_W = 1 << 3
CFG_X = 1 << 4

# Request types.
REQ_READ = 0
REQ_WRITE = 1
REQ_EXEC = 2

# Violation types.
VIOL_NONE = 0
VIOL_NO_MATCH = 1
VIOL_PERMISSION = 2


def entry_offset(idx: int, sub: int) -> int:
    return OFFS_ENTRY_BASE + idx * ENTRY_STRIDE_BYTES + sub


def napot_encode(base: int, size: int) -> int:
    """PMP-NAPOT encode a (base, size) into the stored addr register value.

    The stored value is the word-granule (>>2) base with the size-run of 1s
    appended below the base bits: addr = (base | (size/2 - 1)) >> 2.
    The DUT reconstructs the mask from the value, exactly as RISC-V PMP.
    """
    assert size >= 8 and (size & (size - 1)) == 0, "NAPOT size must be a power of two >= 8"
    assert base % size == 0, "NAPOT base must be size-aligned"
    return (base | (size // 2 - 1)) >> 2


# ---------------------------------------------------------------------------
# Build the entry table from the policy JSON.
#
# Each shared region is given a deterministic 4 KiB NAPOT window starting at
# REGION_BASE; each master keeps its declared sourceId. One entry per region
# admits exactly the masters whose allowedSharedRegions include it. All regions
# are R+W permit regions; we additionally carve one region read-only to exercise
# the wrong-permission path.
# ---------------------------------------------------------------------------
REGION_BASE = 0x8000_0000
REGION_SIZE = 0x1000  # 4 KiB NAPOT

MASTERS = {m["id"]: m["sourceId"] for m in POLICY["masters"]}
REGION_IDS = [r["id"] for r in POLICY["sharedRegions"]]
REGION_ADDR = {rid: REGION_BASE + i * REGION_SIZE for i, rid in enumerate(REGION_IDS)}

# Region -> set of source IDs allowed (derived from each master's allowedSharedRegions).
REGION_SRCIDS: dict[str, set[int]] = {rid: set() for rid in REGION_IDS}
for m in POLICY["masters"]:
    for rid in m["allowedSharedRegions"]:
        REGION_SRCIDS[rid].add(m["sourceId"])

# Make the display-scanout region read-only to exercise the W-denied case;
# every other region is R+W. (display is allowed display-scanout per JSON.)
RO_REGION = "display-scanout"


def srcmd_mask(src_ids: set[int]) -> int:
    mask = 0
    for sid in src_ids:
        mask |= 1 << sid
    return mask


async def reset(dut):
    dut.rst_n.value = 0
    dut.reg_valid.value = 0
    dut.reg_write.value = 0
    dut.reg_addr.value = 0
    dut.reg_wdata.value = 0
    dut.chk_valid.value = 0
    dut.chk_src_id.value = 0
    dut.chk_addr.value = 0
    dut.chk_type.value = 0
    await Timer(1, units="ns")
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def reg_write(dut, byte_addr: int, data: int):
    dut.reg_addr.value = byte_addr
    dut.reg_wdata.value = data & 0xFFFF_FFFF
    dut.reg_write.value = 1
    dut.reg_valid.value = 1
    await RisingEdge(dut.clk)
    dut.reg_valid.value = 0
    dut.reg_write.value = 0
    await Timer(1, units="ns")


async def reg_read(dut, byte_addr: int) -> int:
    dut.reg_addr.value = byte_addr
    dut.reg_write.value = 0
    dut.reg_valid.value = 1
    await Timer(1, units="ns")
    value = int(dut.reg_rdata.value)
    await RisingEdge(dut.clk)
    dut.reg_valid.value = 0
    await Timer(1, units="ns")
    return value


async def check(dut, src_id: int, addr: int, req_type: int) -> tuple[int, int]:
    """Present a transaction and return (allow, deny) after a settle delay."""
    dut.chk_src_id.value = src_id
    dut.chk_addr.value = addr
    dut.chk_type.value = req_type
    dut.chk_valid.value = 1
    await Timer(1, units="ns")
    allow = int(dut.chk_allow.value)
    deny = int(dut.chk_deny.value)
    return allow, deny


async def latch_violation(dut, src_id: int, addr: int, req_type: int):
    """Drive a denied transaction across a clock edge so the record latches."""
    dut.chk_src_id.value = src_id
    dut.chk_addr.value = addr
    dut.chk_type.value = req_type
    dut.chk_valid.value = 1
    await RisingEdge(dut.clk)
    dut.chk_valid.value = 0
    await Timer(1, units="ns")


async def program_policy(dut, *, lock: bool = True):
    """Program one IOPMP entry per shared region, then optionally lock."""
    for idx, rid in enumerate(REGION_IDS):
        base = REGION_ADDR[rid]
        perm = CFG_R if rid == RO_REGION else (CFG_R | CFG_W)
        await reg_write(dut, entry_offset(idx, E_ADDR_LO), napot_encode(base, REGION_SIZE) & 0xFFFF_FFFF)
        await reg_write(dut, entry_offset(idx, E_ADDR_HI), napot_encode(base, REGION_SIZE) >> 32)
        await reg_write(dut, entry_offset(idx, E_CFG), A_NAPOT | perm)
        mask = srcmd_mask(REGION_SRCIDS[rid])
        await reg_write(dut, entry_offset(idx, E_SRCMD_LO), mask & 0xFFFF_FFFF)
        await reg_write(dut, entry_offset(idx, E_SRCMD_HI), (mask >> 32) & 0xFFFF_FFFF)
    # Enable, then (optionally) lock. lock is a separate W1S so we can prove the
    # programming window closes on lock.
    await reg_write(dut, OFFS_CTRL, CTRL_ENABLE)
    if lock:
        await reg_write(dut, OFFS_CTRL, CTRL_ENABLE | CTRL_LOCK)


async def setup(dut, *, lock: bool = True):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    await program_policy(dut, lock=lock)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
@cocotb.test()
async def default_deny_before_programming(dut):
    """Out of reset (disabled, empty table) every transaction is denied."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    allow, deny = await check(dut, MASTERS["usb"], REGION_ADDR["usb-bounce"], REQ_READ)
    assert allow == 0 and deny == 1
    assert int(dut.policy_ready_o.value) == 0
    assert int(dut.locked_o.value) == 0


@cocotb.test()
async def lock_and_policy_ready(dut):
    """After program+lock the IOPMP reports locked and policy-ready (RoT gate)."""
    await setup(dut, lock=True)
    assert int(dut.locked_o.value) == 1
    assert int(dut.policy_ready_o.value) == 1
    status = await reg_read(dut, OFFS_STATUS)
    assert status & STATUS_LOCKED
    assert status & STATUS_ENABLE
    assert status & STATUS_POLICY_READY


@cocotb.test()
async def enabled_unlocked_not_policy_ready(dut):
    """Enabled but unlocked is NOT policy-ready: the host could still widen it."""
    await setup(dut, lock=False)
    assert int(dut.locked_o.value) == 0
    assert int(dut.policy_ready_o.value) == 0


@cocotb.test()
async def permitted_source_passes(dut):
    """A master reading/writing a region in its allowedSharedRegions passes."""
    await setup(dut)
    # usb may reach usb-bounce (R+W).
    allow, deny = await check(dut, MASTERS["usb"], REGION_ADDR["usb-bounce"], REQ_READ)
    assert allow == 1 and deny == 0
    allow, deny = await check(dut, MASTERS["usb"], REGION_ADDR["usb-bounce"] + 0x40, REQ_WRITE)
    assert allow == 1 and deny == 0
    # emmc-ufs may reach storage-bounce.
    allow, deny = await check(dut, MASTERS["emmc-ufs"], REGION_ADDR["storage-bounce"], REQ_WRITE)
    assert allow == 1 and deny == 0


@cocotb.test()
async def non_matching_source_denied(dut):
    """A master NOT in a region's SRCMD is denied (default-deny)."""
    await setup(dut)
    # usb is not allowed storage-bounce (only emmc-ufs is).
    allow, deny = await check(dut, MASTERS["usb"], REGION_ADDR["storage-bounce"], REQ_READ)
    assert allow == 0 and deny == 1
    # debug-transport has NO allowed regions at all -> denied everywhere.
    allow, deny = await check(dut, MASTERS["debug-transport"], REGION_ADDR["usb-bounce"], REQ_READ)
    assert allow == 0 and deny == 1


@cocotb.test()
async def write_to_readonly_region_denied(dut):
    """A write to a read-only region is denied even for an admitted source."""
    await setup(dut)
    # display may reach display-scanout, but it is RO: read passes, write denied.
    allow, deny = await check(dut, MASTERS["display"], REGION_ADDR["display-scanout"], REQ_READ)
    assert allow == 1 and deny == 0
    allow, deny = await check(dut, MASTERS["display"], REGION_ADDR["display-scanout"], REQ_WRITE)
    assert allow == 0 and deny == 1


@cocotb.test()
async def out_of_range_denied(dut):
    """An admitted source at an address outside all entries is denied."""
    await setup(dut)
    # usb at an address far outside any region window.
    allow, deny = await check(dut, MASTERS["usb"], 0x1_0000_0000, REQ_READ)
    assert allow == 0 and deny == 1
    # Just past the end of usb-bounce's 4 KiB window.
    allow, deny = await check(dut, MASTERS["usb"], REGION_ADDR["usb-bounce"] + REGION_SIZE, REQ_READ)
    assert allow == 0 and deny == 1


@cocotb.test()
async def write_after_lock_dropped(dut):
    """Programming writes are dropped after lock; the policy cannot be widened."""
    await setup(dut, lock=True)
    # storage-bounce is entry index for that region; try to add usb to its SRCMD.
    sb_idx = REGION_IDS.index("storage-bounce")
    before = await reg_read(dut, entry_offset(sb_idx, E_SRCMD_LO))
    await reg_write(dut, entry_offset(sb_idx, E_SRCMD_LO), 0xFFFF_FFFF)
    after = await reg_read(dut, entry_offset(sb_idx, E_SRCMD_LO))
    assert after == before, "SRCMD widened after lock"
    # The widening attempt must not have admitted usb to storage-bounce.
    allow, deny = await check(dut, MASTERS["usb"], REGION_ADDR["storage-bounce"], REQ_READ)
    assert allow == 0 and deny == 1
    # Attempt to clear the lock bit must also be dropped.
    await reg_write(dut, OFFS_CTRL, CTRL_ENABLE)  # lock bit = 0 in wdata
    assert int(dut.locked_o.value) == 1


@cocotb.test()
async def violation_record_latched(dut):
    """The first denied transaction latches src/addr/type for the RoT to read."""
    await setup(dut)
    # No violation yet.
    info = await reg_read(dut, OFFS_ERR_INFO)
    assert (info & ERR_VALID) == 0

    # Non-matching source -> NO_MATCH violation latched.
    viol_src = MASTERS["debug-transport"]
    viol_addr = REGION_ADDR["usb-bounce"]
    await latch_violation(dut, viol_src, viol_addr, REQ_READ)

    info = await reg_read(dut, OFFS_ERR_INFO)
    assert info & ERR_VALID
    assert ((info >> 1) & 0x3) == VIOL_NO_MATCH
    assert await reg_read(dut, OFFS_ERR_SRCID) == viol_src
    assert await reg_read(dut, OFFS_ERR_ADDR_LO) == (viol_addr & 0xFFFF_FFFF)
    assert await reg_read(dut, OFFS_ERR_ADDR_HI) == (viol_addr >> 32)

    # The record holds the FIRST violation: a second, different violation does
    # not overwrite it until the RoT clears ERR_INFO.valid (W1C).
    await latch_violation(dut, MASTERS["usb"], REGION_ADDR["storage-bounce"], REQ_READ)
    assert await reg_read(dut, OFFS_ERR_SRCID) == viol_src

    # Clear and re-arm.
    await reg_write(dut, OFFS_ERR_INFO, ERR_VALID)
    info = await reg_read(dut, OFFS_ERR_INFO)
    assert (info & ERR_VALID) == 0


@cocotb.test()
async def permission_violation_type_latched(dut):
    """A wrong-permission denial latches VIOL_PERMISSION, distinct from NO_MATCH."""
    await setup(dut)
    await latch_violation(dut, MASTERS["display"], REGION_ADDR["display-scanout"], REQ_WRITE)
    info = await reg_read(dut, OFFS_ERR_INFO)
    assert info & ERR_VALID
    assert ((info >> 1) & 0x3) == VIOL_PERMISSION
    assert await reg_read(dut, OFFS_ERR_SRCID) == MASTERS["display"]
