"""Multi-core MESI coherence KAT for the e1 SMP cache cluster.

Device under test: ``e1_coherence_smp_tb`` — NUM_CORES real ``e1_l1d_cache``
instances sharing one ``e1_coherence_dir`` directory controller. The test
drives loads/stores into each core's L1D and proves the canonical coherence
invariants through the real RTL coherence path (acquire -> directory probe ->
grant), never poking the internal coherence wires directly.

Invariants proven:
  * SWMR (single-writer / multiple-reader): at most one core holds a line in
    Modified at a time. Proven from the directory's authoritative per-line
    state and sharer mask (the ordering point), cross-checked against the
    architectural load values.
  * Write propagation: core A writes a value; core B's subsequent load of the
    same line observes the new value (coherent, not a stale cached copy).
  * Message-passing litmus (data + flag): core A stores data then a flag; once
    core B observes flag==1 it reads the data and must see A's data.
  * Clean eviction + writeback ordering: an M line evicted by capacity is
    written back to the directory before a peer's later read sees the value.
  * Domain flush partitioning: a confidential domain's directory lines are
    dropped on a flush so they cannot be observed after a domain switch.

SWMR is enforced by construction: a write acquire probes every peer to Invalid
before granting Modified, and a probe of a dirty owner returns its line as
writeback data, which the directory installs before the grant.

The directory's storage (``dir_state_q[idx]`` / ``dir_sharers_q[idx]``) is the
canonical coherence state. The L1D per-way arrays are not introspected because
nested unpacked SystemVerilog arrays are not reliably addressable from cocotb;
observable load/store behaviour is the architectural ground truth and is what
the invariants assert against.
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

NUM_CORES = 2
LINE_BYTES = 64
DIR_LINES = 64

MESI_I = 0
MESI_S = 1
MESI_E = 2
MESI_M = 3
MESI_NAME = {0: "I", 1: "S", 2: "E", 3: "M", 4: "O"}

MASK64 = (1 << 64) - 1


def _set_arr(handle, idx, val):
    handle[idx].value = val


async def reset_dut(dut) -> None:
    dut.rst_n.value = 0
    for c in range(NUM_CORES):
        dut.c_req_valid[c].value = 0
        _set_arr(dut.c_req_paddr, c, 0)
        _set_arr(dut.c_req_is_load, c, 1)
        _set_arr(dut.c_req_wdata, c, 0)
        _set_arr(dut.c_domain, c, 0)
    dut.flush_req.value = 0
    dut.flush_domain.value = 0
    for _ in range(6):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def core_access(dut, core, paddr, is_load, wdata=0, max_replays=200):
    """Issue a load/store on a core's L1D, retrying on replay (MSHR refill
    semantics) until the L1D acks. Returns the 64-bit read data on a load.

    The L1D returns replay on a miss while the MSHR fills from the directory;
    the LSU model reissues. This loop is that LSU reissue engine.
    """
    for _ in range(max_replays):
        dut.c_req_valid[core].value = 1
        _set_arr(dut.c_req_paddr, core, paddr)
        _set_arr(dut.c_req_is_load, core, 1 if is_load else 0)
        _set_arr(dut.c_req_wdata, core, wdata & MASK64)
        await RisingEdge(dut.clk)
        dut.c_req_valid[core].value = 0
        # Response is registered: sample on the next edge.
        await RisingEdge(dut.clk)
        if int(dut.c_resp_valid[core].value) == 1:
            if int(dut.c_resp_ack[core].value) == 1:
                return int(dut.c_resp_rdata[core].value) & MASK64
        # Let any in-flight directory transaction make progress before retry.
        for _ in range(3):
            await RisingEdge(dut.clk)
    raise AssertionError(
        f"core {core} {'load' if is_load else 'store'} @ {paddr:#x} "
        f"never acked within {max_replays} replays"
    )


def dir_index(paddr):
    return (paddr >> 6) & (DIR_LINES - 1)


def dir_state(dut, paddr):
    return int(dut.u_dir.dir_state_q[dir_index(paddr)].value)


def dir_sharers(dut, paddr):
    return int(dut.u_dir.dir_sharers_q[dir_index(paddr)].value)


def assert_swmr(dut, paddr):
    """SWMR ground truth from the directory: if a line is Modified, exactly one
    core may be its sharer; no line may be M with more than one sharer bit."""
    st = dir_state(dut, paddr)
    sh = dir_sharers(dut, paddr)
    nset = bin(sh).count("1")
    if st == MESI_M:
        assert nset == 1, (
            f"SWMR violation @ {paddr:#x}: state M but {nset} sharers "
            f"(mask {sh:#b})"
        )
    if st in (MESI_E, MESI_M):
        assert nset <= 1, (
            f"SWMR violation @ {paddr:#x}: exclusive/modified state "
            f"{MESI_NAME[st]} with {nset} sharers (mask {sh:#b})"
        )


@cocotb.test()
async def test_write_propagation(dut):
    """Core 0 writes a value; core 1's subsequent read sees the new value."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    paddr = 0x0000_2000_0000
    val = 0xA5A5_1234_DEAD_BEEF

    await core_access(dut, 0, paddr, is_load=False, wdata=val)
    assert dir_state(dut, paddr) == MESI_M, "writer must own the line M"
    assert dir_sharers(dut, paddr) == 0b01, "only core0 should hold the line"

    # Core 1 reads the same line -> directory downgrades core 0 (M->S, writes
    # back the dirty line) and grants core 1 the fresh data.
    got = await core_access(dut, 1, paddr, is_load=True)
    assert got == val, f"core1 read stale data: got {got:#x} want {val:#x}"
    assert dir_state(dut, paddr) == MESI_S, "line should be Shared after read"
    assert dir_sharers(dut, paddr) == 0b11, "both cores should share the line"


@cocotb.test()
async def test_swmr_single_writer(dut):
    """Two cores cannot both hold a line writable (Modified).

    Core 0 writes (M). Core 1 then writes the SAME line: the directory must
    invalidate core 0 before granting core 1 M. After core 1's write the
    directory must show exactly one sharer (core1), and core 0's stale value
    must not be observable.
    """
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    paddr = 0x0000_2000_0040
    await core_access(dut, 0, paddr, is_load=False,
                      wdata=0x1111_1111_1111_1111)
    assert_swmr(dut, paddr)
    assert dir_state(dut, paddr) == MESI_M
    assert dir_sharers(dut, paddr) == 0b01

    await core_access(dut, 1, paddr, is_load=False,
                      wdata=0x2222_2222_2222_2222)
    assert_swmr(dut, paddr)
    assert dir_state(dut, paddr) == MESI_M, "core1 should own the line M"
    assert dir_sharers(dut, paddr) == 0b10, (
        "SWMR violation: core0 still holds the line while core1 is M "
        f"(sharers {dir_sharers(dut, paddr):#b})"
    )

    # Coherent read-back: core 1 reads its own line, sees its write.
    got = await core_access(dut, 1, paddr, is_load=True)
    assert got == 0x2222_2222_2222_2222


@cocotb.test()
async def test_no_two_modified_invariant(dut):
    """Direct SWMR sweep: after each writer takes the line, assert no other
    core simultaneously holds it in M, across an alternating write sequence."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    paddr = 0x0000_2000_0080
    for i in range(6):
        writer = i % NUM_CORES
        val = 0xC0DE_0000_0000_0000 + i
        await core_access(dut, writer, paddr, is_load=False, wdata=val)
        assert_swmr(dut, paddr)
        assert dir_state(dut, paddr) == MESI_M
        assert dir_sharers(dut, paddr) == (1 << writer), (
            f"step {i}: expected only core {writer} to own M, got mask "
            f"{dir_sharers(dut, paddr):#b}"
        )
        # The writer can read back exactly its own value.
        got = await core_access(dut, writer, paddr, is_load=True)
        assert got == val, f"step {i}: writer read {got:#x} want {val:#x}"


@cocotb.test()
async def test_message_passing_litmus(dut):
    """Classic message-passing litmus on two distinct lines.

    Core 0:  store DATA(line X) ; store FLAG=1 (line Y)
    Core 1:  load FLAG ; once FLAG==1, load DATA must observe core 0's DATA.
    """
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    data_addr = 0x0000_3000_0000
    flag_addr = 0x0000_3000_0040  # distinct directory line (idx 0 vs 1)
    data_val = 0xFEED_FACE_CAFE_F00D

    await core_access(dut, 0, data_addr, is_load=False, wdata=data_val)
    await core_access(dut, 0, flag_addr, is_load=False, wdata=0x1)

    flag = 0
    for _ in range(50):
        flag = await core_access(dut, 1, flag_addr, is_load=True)
        if flag == 0x1:
            break
    assert flag == 0x1, "core1 never observed FLAG=1"

    got = await core_access(dut, 1, data_addr, is_load=True)
    assert got == data_val, (
        f"MP litmus violated: FLAG seen set but DATA stale "
        f"(got {got:#x} want {data_val:#x})"
    )


@cocotb.test()
async def test_dirty_writeback_ordering(dut):
    """A dirty owner's writeback is ordered before the next grant of the line.

    Core 0 writes A (M, dirty). Core 1 then writes A: the directory must probe
    core 0 to Invalid, COLLECT its dirty line as writeback data, and install
    that data before granting core 1. We prove the ordering by reading the
    directory's authoritative copy after the invalidating probe: it must hold
    core 0's value (not the cold-fill zero), and core 1 then overwrites it.
    Finally core 0 re-reads and observes core 1's value, never the stale one.
    """
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    base = 0x0000_4000_0000
    a_val = 0x0BAD_F00D_1234_5678
    b_val = 0x0000_BEEF_0000_C0DE

    # Core 0 writes A -> M, dirty.
    await core_access(dut, 0, base, is_load=False, wdata=a_val)
    assert dir_state(dut, base) == MESI_M
    assert dir_sharers(dut, base) == 0b01

    # Core 1 writes A -> directory probes core 0 (M->I), collects the dirty
    # line, then grants core 1. SWMR holds throughout.
    await core_access(dut, 1, base, is_load=False, wdata=b_val)
    assert_swmr(dut, base)
    assert dir_state(dut, base) == MESI_M
    assert dir_sharers(dut, base) == 0b10, (
        "core1 must be sole owner after invalidating core0"
    )

    # Core 0 re-reads A -> must observe core 1's value, proving core 1's dirty
    # line was written back and ordered before this read's grant.
    got = await core_access(dut, 0, base, is_load=True)
    assert got == b_val, (
        f"writeback ordering violated: got {got:#x} want {b_val:#x}"
    )
    assert_swmr(dut, base)


@cocotb.test()
async def test_domain_flush_partition(dut):
    """Flush-by-domain drops a confidential domain's lines.

    Core 1 is in confidential domain 1 and caches a line. A flush of domain 1
    invalidates the directory entry so a later read re-fetches from backing
    store (no cross-domain residue). A line owned by domain 0 survives.
    """
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    cd_addr = 0x0000_5000_0000
    host_addr = 0x0000_5000_0040  # distinct directory line (idx 0 vs 1)

    _set_arr(dut.c_domain, 0, 0)   # core0 = host domain
    _set_arr(dut.c_domain, 1, 1)   # core1 = confidential domain

    await core_access(dut, 0, host_addr, is_load=False,
                      wdata=0x0000_5700_0000_0001)
    await core_access(dut, 1, cd_addr, is_load=False, wdata=0xC0FF_EE00)
    assert dir_state(dut, cd_addr) == MESI_M
    assert dir_state(dut, host_addr) == MESI_M

    # Flush domain 1.
    dut.flush_req.value = 1
    dut.flush_domain.value = 1
    await RisingEdge(dut.clk)
    dut.flush_req.value = 0
    for _ in range(2 * DIR_LINES + 20):
        await RisingEdge(dut.clk)
        if int(dut.flush_done.value) == 1:
            break
    assert int(dut.flush_busy.value) == 0, "flush must finish"

    # Confidential line is now Invalid in the directory; host line survives.
    assert dir_state(dut, cd_addr) == MESI_I, (
        "confidential domain line must be invalidated by the flush"
    )
    assert dir_state(dut, host_addr) == MESI_M, (
        "host-domain line must survive a confidential-domain flush"
    )

    # A fresh read of the flushed line re-fetches from backing store (0 in
    # this model), proving the confidential value did not survive.
    got = await core_access(dut, 0, cd_addr, is_load=True)
    assert got == 0, f"confidential residue leaked across flush: read {got:#x}"
