"""cocotb suite for the E1 MTT/Smmtt checker (rtl/security/mtt/e1_mtt_checker.sv).

The MTT is the whole-OS memory-isolation spine of the TEE-native confidential
VM (docs/security/tee-plan/01-tee-core-architecture.md S2). It walks a
memory-resident, monitor-owned table that maps each host-physical page to a
{page state, owner domain} and permits/denies each access per the page state and
the confidential-domain.md I/O rule, default-deny on unmapped.

This testbench:
  * implements a backing-memory read-only AXI4 responder so the DUT can walk a
    real two-level table built in Python;
  * derives the page-state numbering DIRECTLY from
    docs/spec-db/tee-page-state-transitions.json so the RTL and the pure-Python
    page_state_model (scripts/tee/page_state_model.py) agree on the six states;
  * programs the root pointer through the TSM MMIO window, then locks it;
  * asserts the deny-host-to-confidential proof and the other KATs.

Contracts proven:
  * confidential-domain access to a private page is PERMITTED;
  * host/untrusted access to a private page is DENIED + fault record latched
    (the core I/O-rule proof);
  * a shared/bounce page is accessible to BOTH worlds (the only cross-world path);
  * an unmapped page is default-deny;
  * a state transition (assign private -> measured-launch -> reclaim/scrub) is
    enforced page-by-page exactly as the JSON model declares;
  * a programming write after lock (and a non-TSM write) is dropped.
"""

from __future__ import annotations

import json
from pathlib import Path

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer

REPO = Path(__file__).resolve().parents[3]
POLICY = json.loads((REPO / "docs/spec-db/tee-page-state-transitions.json").read_text())

# ---------------------------------------------------------------------------
# Page-state numbering: the order of POLICY["states"] IS the RTL encoding
# (e1_mtt_pkg.sv PS_*). Asserting it here keeps RTL/model/JSON in lockstep.
# ---------------------------------------------------------------------------
STATES = POLICY["states"]
PS = {name: idx for idx, name in enumerate(STATES)}
assert STATES == [
    "free",
    "measured",
    "private",
    "shared",
    "device-assigned",
    "scrub-pending",
], f"unexpected page-state order in JSON: {STATES}"

# ---------------------------------------------------------------------------
# Architectural constants (mirror rtl/security/mtt/e1_mtt_pkg.sv).
# ---------------------------------------------------------------------------
PADDR_BITS = 40
PAGE_SHIFT = 12
PAGE_SIZE = 1 << PAGE_SHIFT  # 4 KiB
PPN_BITS = PADDR_BITS - PAGE_SHIFT  # 28
LEAF_IDX_BITS = PPN_BITS // 2  # 14
ROOT_IDX_BITS = PPN_BITS - LEAF_IDX_BITS  # 14
ENTRY_BYTES = 8  # 64-bit MTT entry
LEAF_TABLE_BYTES = (1 << LEAF_IDX_BITS) * ENTRY_BYTES
SUPERPAGE_SIZE = 1 << (LEAF_IDX_BITS + PAGE_SHIFT)  # 64 MiB

DOMAIN_HOST = 0  # untrusted host/hypervisor (fixed reserved id)

# Entry bit layout.
E_VALID = 0
E_LEAF = 1
E_STATE_LSB = 2
E_OWNER_LSB = 5
E_DEVOK = 9
E_NEXTPPN_LSB = 10

# MMIO register byte offsets.
OFFS_CTRL = 0x000
OFFS_STATUS = 0x004
OFFS_ROOT_LO = 0x008
OFFS_ROOT_HI = 0x00C
OFFS_FAULT_INFO = 0x010
OFFS_FAULT_DOM = 0x014
OFFS_FAULT_ADDR_LO = 0x018
OFFS_FAULT_ADDR_HI = 0x01C

CTRL_ENABLE = 1 << 0
CTRL_LOCK = 1 << 1

STATUS_LOCKED = 1 << 0
STATUS_ENABLE = 1 << 1
STATUS_READY = 1 << 2

FAULT_VALID = 1 << 0
FAULT_STATE_LSB = 1
FAULT_WRITE = 1 << 4
FAULT_KIND_LSB = 5

V_ALLOW = 0
V_DENY_UNMAP = 1
V_DENY_STATE = 2

# Request directions.
READ = 0
WRITE = 1


# ---------------------------------------------------------------------------
# A backing-memory MTT builder. The table lives in a Python dict of 64-bit
# words keyed by physical address; the AXI responder serves it to the DUT.
# Layout: root table at ROOT_BASE; leaf tables packed after it.
# ---------------------------------------------------------------------------
ROOT_BASE = 0x4000_0000


def leaf_entry(state: int, owner: int, dev_ok: bool = False) -> int:
    word = (1 << E_VALID) | (1 << E_LEAF)
    word |= (state & 0x7) << E_STATE_LSB
    word |= (owner & 0xF) << E_OWNER_LSB
    if dev_ok:
        word |= 1 << E_DEVOK
    return word


def pointer_entry(next_ppn: int) -> int:
    return (1 << E_VALID) | (next_ppn << E_NEXTPPN_LSB)


def superpage_entry(state: int, owner: int) -> int:
    """A root-level LEAF entry covering an entire 2 MiB superpage."""
    return leaf_entry(state, owner)


class Mtt:
    """Two-level MTT in a backing-memory word dict.

    map_page(addr, state, owner) installs a 4 KiB leaf entry (creating the leaf
    table on demand). map_superpage(addr, state, owner) installs a root-level
    LEAF that covers the whole 2 MiB region in one walk step.
    """

    def __init__(self) -> None:
        self.mem: dict[int, int] = {}
        self._next_leaf = ROOT_BASE + (1 << ROOT_IDX_BITS) * ENTRY_BYTES
        self._leaf_base: dict[int, int] = {}  # root_idx -> leaf table phys base

    def _ppn(self, addr: int) -> int:
        return addr >> PAGE_SHIFT

    def _root_idx(self, addr: int) -> int:
        return (self._ppn(addr) >> LEAF_IDX_BITS) & ((1 << ROOT_IDX_BITS) - 1)

    def _leaf_idx(self, addr: int) -> int:
        return self._ppn(addr) & ((1 << LEAF_IDX_BITS) - 1)

    def _root_word_addr(self, root_idx: int) -> int:
        return ROOT_BASE + root_idx * ENTRY_BYTES

    def _ensure_leaf(self, root_idx: int) -> int:
        if root_idx not in self._leaf_base:
            base = self._next_leaf
            self._next_leaf += LEAF_TABLE_BYTES
            self._leaf_base[root_idx] = base
            self.mem[self._root_word_addr(root_idx)] = pointer_entry(base >> PAGE_SHIFT)
        return self._leaf_base[root_idx]

    def map_page(self, addr: int, state: int, owner: int, dev_ok: bool = False) -> None:
        root_idx = self._root_idx(addr)
        leaf_base = self._ensure_leaf(root_idx)
        word_addr = leaf_base + self._leaf_idx(addr) * ENTRY_BYTES
        self.mem[word_addr] = leaf_entry(state, owner, dev_ok)

    def map_superpage(self, addr: int, state: int, owner: int) -> None:
        assert addr % SUPERPAGE_SIZE == 0, "superpage base must be 2 MiB aligned"
        root_idx = self._root_idx(addr)
        self.mem[self._root_word_addr(root_idx)] = superpage_entry(state, owner)

    def read_word(self, addr: int) -> int:
        # An unmapped table slot reads as all-zero -> entry invalid (default-deny).
        return self.mem.get(addr & ~(ENTRY_BYTES - 1), 0)


# ---------------------------------------------------------------------------
# AXI4 read-only responder driving the DUT walk port. Single outstanding beat:
# accept AR, then drive one R beat with the backing-memory word.
# ---------------------------------------------------------------------------
async def axi_read_responder(dut, mtt: Mtt):
    dut.w_arready.value = 1
    dut.w_rvalid.value = 0
    dut.w_rdata.value = 0
    dut.w_rresp.value = 0
    while True:
        await RisingEdge(dut.clk)
        if int(dut.w_arvalid.value) and int(dut.w_arready.value):
            addr = int(dut.w_araddr.value)
            await RisingEdge(dut.clk)
            dut.w_rdata.value = mtt.read_word(addr)
            dut.w_rresp.value = 0  # OKAY
            dut.w_rvalid.value = 1
            # Hold R until the DUT accepts it.
            while True:
                await RisingEdge(dut.clk)
                if int(dut.w_rready.value):
                    break
            dut.w_rvalid.value = 0


async def reset(dut):
    dut.rst_n.value = 0
    dut.reg_valid.value = 0
    dut.reg_write.value = 0
    dut.prog_unlock_i.value = 0
    dut.reg_addr.value = 0
    dut.reg_wdata.value = 0
    dut.chk_valid.value = 0
    dut.chk_domain.value = 0
    dut.chk_addr.value = 0
    dut.chk_write.value = 0
    dut.scrub_done_i.value = 0
    dut.w_arready.value = 1
    dut.w_rvalid.value = 0
    dut.w_rdata.value = 0
    dut.w_rresp.value = 0
    await Timer(1, units="ns")
    for _ in range(4):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def reg_write(dut, byte_addr: int, data: int, *, tsm: bool = True):
    dut.reg_addr.value = byte_addr
    dut.reg_wdata.value = data & 0xFFFF_FFFF
    dut.reg_write.value = 1
    dut.reg_valid.value = 1
    dut.prog_unlock_i.value = 1 if tsm else 0
    await RisingEdge(dut.clk)
    dut.reg_valid.value = 0
    dut.reg_write.value = 0
    dut.prog_unlock_i.value = 0
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


async def program_root(dut, *, lock: bool = True):
    """TSM programs the root pointer + enable, then (optionally) locks."""
    await reg_write(dut, OFFS_ROOT_LO, ROOT_BASE & 0xFFFF_FFFF)
    await reg_write(dut, OFFS_ROOT_HI, ROOT_BASE >> 32)
    await reg_write(dut, OFFS_CTRL, CTRL_ENABLE)
    if lock:
        await reg_write(dut, OFFS_CTRL, CTRL_ENABLE | CTRL_LOCK)


async def do_check(dut, domain: int, addr: int, write: int) -> tuple[int, int]:
    """Run one access check to completion; return (allow, deny)."""
    dut.chk_domain.value = domain
    dut.chk_addr.value = addr
    dut.chk_write.value = write
    dut.chk_valid.value = 1
    await RisingEdge(dut.clk)
    dut.chk_valid.value = 0
    # Walk to DONE.
    for _ in range(64):
        await Timer(1, units="ns")
        if int(dut.chk_done.value):
            allow = int(dut.chk_allow.value)
            deny = int(dut.chk_deny.value)
            await RisingEdge(dut.clk)
            return allow, deny
        await RisingEdge(dut.clk)
    raise AssertionError("walk did not complete")


# Domain ids used across tests.
GUEST = 1   # the confidential guest domain that owns its private pages
GUEST2 = 2  # a different confidential domain (non-owner)
DEVICE = 3  # a measured device domain (device-assigned)

# A fixed address plan (distinct 4 KiB pages, plus one 2 MiB superpage region).
ADDR_PRIVATE = 0x8000_0000
ADDR_MEASURED = 0x8000_1000
ADDR_SHARED = 0x8000_2000
ADDR_FREE = 0x8000_3000
ADDR_DEVASSIGN = 0x8000_4000
ADDR_SCRUB = 0x8000_5000
ADDR_UNMAPPED = 0x8000_6000
ADDR_SUPERPAGE = 0x9000_0000  # 64 MiB aligned, distinct root slot (root-level leaf)


def build_mtt() -> Mtt:
    mtt = Mtt()
    mtt.map_page(ADDR_PRIVATE, PS["private"], GUEST)
    mtt.map_page(ADDR_MEASURED, PS["measured"], GUEST)
    mtt.map_page(ADDR_SHARED, PS["shared"], GUEST)
    mtt.map_page(ADDR_FREE, PS["free"], DOMAIN_HOST)
    mtt.map_page(ADDR_DEVASSIGN, PS["device-assigned"], GUEST, dev_ok=True)
    mtt.map_page(ADDR_SCRUB, PS["scrub-pending"], GUEST)
    # ADDR_UNMAPPED deliberately left out -> default-deny.
    mtt.map_superpage(ADDR_SUPERPAGE, PS["private"], GUEST)
    return mtt


async def setup(dut, mtt: Mtt, *, lock: bool = True):
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    cocotb.start_soon(axi_read_responder(dut, mtt))
    await program_root(dut, lock=lock)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
@cocotb.test()
async def default_deny_before_programming(dut):
    """Out of reset (disabled, no root) every access is denied."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    cocotb.start_soon(axi_read_responder(dut, build_mtt()))
    allow, deny = await do_check(dut, GUEST, ADDR_PRIVATE, READ)
    assert allow == 0 and deny == 1
    assert int(dut.ready_o.value) == 0
    assert int(dut.locked_o.value) == 0


@cocotb.test()
async def lock_and_ready(dut):
    """After program+lock the checker is locked and ready (platform-release gate)."""
    await setup(dut, build_mtt(), lock=True)
    assert int(dut.locked_o.value) == 1
    assert int(dut.ready_o.value) == 1
    status = await reg_read(dut, OFFS_STATUS)
    assert status & STATUS_LOCKED
    assert status & STATUS_ENABLE
    assert status & STATUS_READY


@cocotb.test()
async def enabled_unlocked_not_ready(dut):
    """Enabled but unlocked is NOT ready: the host could still reprogram it."""
    await setup(dut, build_mtt(), lock=False)
    assert int(dut.locked_o.value) == 0
    assert int(dut.ready_o.value) == 0


@cocotb.test()
async def confidential_access_to_private_permitted(dut):
    """The owning confidential domain may read AND write its private page."""
    await setup(dut, build_mtt())
    allow, deny = await do_check(dut, GUEST, ADDR_PRIVATE, READ)
    assert allow == 1 and deny == 0
    allow, deny = await do_check(dut, GUEST, ADDR_PRIVATE, WRITE)
    assert allow == 1 and deny == 0


@cocotb.test()
async def host_access_to_private_denied_and_faulted(dut):
    """THE I/O-rule proof: the untrusted host is DENIED a confidential page and
    the fault record latches {requester domain, addr, state, write}."""
    await setup(dut, build_mtt())
    # No fault yet.
    assert (await reg_read(dut, OFFS_FAULT_INFO)) & FAULT_VALID == 0

    allow, deny = await do_check(dut, DOMAIN_HOST, ADDR_PRIVATE, WRITE)
    assert allow == 0 and deny == 1, "host write to private page must be DENIED"

    info = await reg_read(dut, OFFS_FAULT_INFO)
    assert info & FAULT_VALID, "fault record must latch the denial"
    assert ((info >> FAULT_STATE_LSB) & 0x7) == PS["private"]
    assert info & FAULT_WRITE, "the faulting op was a write"
    assert ((info >> FAULT_KIND_LSB) & 0x3) == V_DENY_STATE
    assert (await reg_read(dut, OFFS_FAULT_DOM)) == DOMAIN_HOST
    assert (await reg_read(dut, OFFS_FAULT_ADDR_LO)) == (ADDR_PRIVATE & 0xFFFF_FFFF)
    assert (await reg_read(dut, OFFS_FAULT_ADDR_HI)) == (ADDR_PRIVATE >> 32)

    # A non-owner confidential domain is ALSO denied a private page it does not own.
    allow, deny = await do_check(dut, GUEST2, ADDR_PRIVATE, READ)
    assert allow == 0 and deny == 1, "non-owner domain must be denied"

    # The record holds the FIRST fault until the TSM clears it (W1C).
    assert (await reg_read(dut, OFFS_FAULT_DOM)) == DOMAIN_HOST
    await reg_write(dut, OFFS_FAULT_INFO, FAULT_VALID)
    assert (await reg_read(dut, OFFS_FAULT_INFO)) & FAULT_VALID == 0


@cocotb.test()
async def host_access_to_measured_denied(dut):
    """A measured (launch-frozen) page denies the host outright; even the owner
    cannot WRITE it, but the owner may READ it."""
    await setup(dut, build_mtt())
    allow, deny = await do_check(dut, DOMAIN_HOST, ADDR_MEASURED, READ)
    assert allow == 0 and deny == 1
    # Owner read OK, owner write DENIED (launch-frozen immutability).
    allow, deny = await do_check(dut, GUEST, ADDR_MEASURED, READ)
    assert allow == 1 and deny == 0
    allow, deny = await do_check(dut, GUEST, ADDR_MEASURED, WRITE)
    assert allow == 0 and deny == 1, "write to measured page must be denied"


@cocotb.test()
async def shared_page_accessible_per_io_rule(dut):
    """A shared/bounce page is the only cross-world path: both the owner and the
    untrusted host may read and write it."""
    await setup(dut, build_mtt())
    for dom in (GUEST, DOMAIN_HOST):
        allow, deny = await do_check(dut, dom, ADDR_SHARED, READ)
        assert allow == 1 and deny == 0
        allow, deny = await do_check(dut, dom, ADDR_SHARED, WRITE)
        assert allow == 1 and deny == 0


@cocotb.test()
async def free_page_host_only(dut):
    """A free page is host scratch: host OK, a confidential domain has no claim."""
    await setup(dut, build_mtt())
    allow, deny = await do_check(dut, DOMAIN_HOST, ADDR_FREE, WRITE)
    assert allow == 1 and deny == 0
    allow, deny = await do_check(dut, GUEST, ADDR_FREE, READ)
    assert allow == 0 and deny == 1


@cocotb.test()
async def device_assigned_gated_by_dev_ok(dut):
    """A device-assigned page admits the owner and a measured device (dev_ok),
    but DENIES the host."""
    await setup(dut, build_mtt())
    allow, deny = await do_check(dut, GUEST, ADDR_DEVASSIGN, READ)
    assert allow == 1 and deny == 0
    allow, deny = await do_check(dut, DEVICE, ADDR_DEVASSIGN, WRITE)
    assert allow == 1 and deny == 0, "measured device (dev_ok) may access"
    allow, deny = await do_check(dut, DOMAIN_HOST, ADDR_DEVASSIGN, READ)
    assert allow == 0 and deny == 1, "host must be denied a device-assigned page"


@cocotb.test()
async def scrub_pending_denies_all(dut):
    """A scrub-pending page denies ALL worlds until zeroized (deny-all)."""
    await setup(dut, build_mtt())
    for dom in (GUEST, DOMAIN_HOST, DEVICE):
        allow, deny = await do_check(dut, dom, ADDR_SCRUB, READ)
        assert allow == 0 and deny == 1


@cocotb.test()
async def unmapped_default_deny(dut):
    """An unmapped page (no leaf entry) is default-deny for every requester."""
    await setup(dut, build_mtt())
    for dom in (GUEST, DOMAIN_HOST):
        allow, deny = await do_check(dut, dom, ADDR_UNMAPPED, READ)
        assert allow == 0 and deny == 1
    # And the latched fault kind is UNMAP, distinct from a state denial.
    info = await reg_read(dut, OFFS_FAULT_INFO)
    assert info & FAULT_VALID
    assert ((info >> FAULT_KIND_LSB) & 0x3) == V_DENY_UNMAP


@cocotb.test()
async def superpage_walk_one_step(dut):
    """A root-level LEAF (superpage) entry resolves a 2 MiB region in one step:
    the owner is permitted, the host denied, anywhere inside the superpage."""
    await setup(dut, build_mtt())
    for off in (0, PAGE_SIZE, SUPERPAGE_SIZE - PAGE_SIZE):
        allow, deny = await do_check(dut, GUEST, ADDR_SUPERPAGE + off, READ)
        assert allow == 1 and deny == 0
        allow, deny = await do_check(dut, DOMAIN_HOST, ADDR_SUPERPAGE + off, READ)
        assert allow == 0 and deny == 1


@cocotb.test()
async def state_transition_enforced(dut):
    """Drive the JSON-declared chain free -> measured -> private (finalize) ->
    scrub-pending and confirm the per-state access verdict tracks the table.

    The TSM owns transition legality; the checker enforces the per-state access
    invariant. We rebuild the same page through the lifecycle and assert the
    host is denied at every confidential state and the page is deny-all while
    scrub-pending -- the hardware half of the model the python checker proves.
    """
    page = ADDR_PRIVATE
    # Sanity: the legal chain we exercise exists in the JSON model.
    edges = {(t["from"], t["to"]) for t in POLICY["transitions"]}
    assert ("free", "measured") in edges
    assert ("measured", "private") in edges
    assert ("private", "scrub-pending") in edges
    assert ("scrub-pending", "free") in edges
    # And the forbidden direct private->free edge is NOT present.
    assert ("private", "free") not in edges

    for state_name, owner, host_denied, owner_read_ok in [
        ("free", DOMAIN_HOST, False, False),       # host owns free scratch
        ("measured", GUEST, True, True),           # frozen: owner reads, host denied
        ("private", GUEST, True, True),            # owner only
        ("scrub-pending", GUEST, True, False),     # deny-all
    ]:
        mtt = build_mtt()
        mtt.map_page(page, PS[state_name], owner)
        cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
        await reset(dut)
        cocotb.start_soon(axi_read_responder(dut, mtt))
        await program_root(dut, lock=True)

        # Host verdict.
        allow, deny = await do_check(dut, DOMAIN_HOST, page, READ)
        if host_denied:
            assert deny == 1, f"host must be denied {state_name}"
        else:
            assert allow == 1, f"host must be allowed {state_name}"
        # Owner read verdict.
        allow, deny = await do_check(dut, GUEST, page, READ)
        if owner_read_ok:
            assert allow == 1, f"owner read must be allowed for {state_name}"
        else:
            assert deny == 1, f"owner read must be denied for {state_name}"


@cocotb.test()
async def reprogram_after_lock_dropped(dut):
    """A programming write after lock -- and a non-TSM write -- is dropped: the
    host cannot reprogram the root or clear the lock."""
    await setup(dut, build_mtt(), lock=True)
    root_lo_before = await reg_read(dut, OFFS_ROOT_LO)

    # TSM tries to repoint the root after lock -> dropped.
    await reg_write(dut, OFFS_ROOT_LO, 0xDEAD_0000, tsm=True)
    assert (await reg_read(dut, OFFS_ROOT_LO)) == root_lo_before, "root moved after lock"

    # Attempt to clear the lock bit -> dropped (sticky).
    await reg_write(dut, OFFS_CTRL, CTRL_ENABLE, tsm=True)
    assert int(dut.locked_o.value) == 1

    # A non-TSM (host) write during a hypothetical unlocked window is also gated:
    # reset to unlocked and confirm prog_unlock_i=0 writes are ignored.
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)
    cocotb.start_soon(axi_read_responder(dut, build_mtt()))
    await reg_write(dut, OFFS_ROOT_LO, 0xBEEF_0000, tsm=False)  # not the TSM
    assert (await reg_read(dut, OFFS_ROOT_LO)) == 0, "non-TSM write must be dropped"
    # The TSM write then takes effect.
    await reg_write(dut, OFFS_ROOT_LO, ROOT_BASE & 0xFFFF_FFFF, tsm=True)
    assert (await reg_read(dut, OFFS_ROOT_LO)) == (ROOT_BASE & 0xFFFF_FFFF)
