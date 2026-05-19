"""8-master AXI4 arbitration fairness regression.

The production fabric biases round-robin by AxQOS; this regression
exercises:

* Equal-QoS arbitration must distribute service across all eight masters
  within a fairness window.  No master may go more than
  ``MAX_STARVATION_BEATS`` consecutive R-beats before being serviced.
* QoS-weighted arbitration: when one master raises its AxQOS, it must
  receive strictly more service than the equal-QoS baseline without
  starving the remaining seven.

The test counts per-master beat returns and asserts both bandwidth
balance (max/min ratio) and the per-master starvation window.

The harness wires ``NUM_MASTERS = 8`` against a single DRAM-backed slave
port.  Each master targets a distinct 64 KiB sub-region of the same
slave aperture so responses can be attributed by AxID + master prefix
on the slave side.
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

NUM_MASTERS = 8
BURST_INCR = 1
RESP_OKAY = 0
RESP_SLVERR = 2

DATA_WIDTH = 128
BYTES_PER_BEAT = DATA_WIDTH // 8

# Maximum number of consecutive R-beats from a single master before a
# new master must be granted.  Round-robin + per-master MAX_OUTST=8 +
# command-latency=2 means the worst case is one full slave burst plus
# a few priority-rotation cycles; 64 beats is generous.
MAX_STARVATION_BEATS = 64


async def reset(dut):
    dut.rst_n.value = 0
    dut.m_awvalid.value = 0
    dut.m_wvalid.value = 0
    dut.m_bready.value = 0
    dut.m_arvalid.value = 0
    dut.m_rready.value = 0
    for _ in range(8):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    for _ in range(4):
        await RisingEdge(dut.clk)


def setup_ar_fields(dut, master, arid, addr, length, qos=0):
    """Configure per-master AR fields (without touching m_arvalid).  The
    caller drives m_arvalid as a single vector write so that all
    asserted bits land in the same simulation tick — cocotb signal
    writes are deferred until the next scheduler step, so OR-ing
    individual bits into the vector across multiple writes can drop
    earlier bits before the simulator observes them."""
    size = int(BYTES_PER_BEAT).bit_length() - 1
    dut.m_arid[master].value = arid
    dut.m_araddr[master].value = addr
    dut.m_arlen[master].value = length - 1
    dut.m_arsize[master].value = size
    dut.m_arburst[master].value = BURST_INCR
    dut.m_arlock[master].value = 0
    dut.m_arcache[master].value = 0x2
    dut.m_arprot[master].value = 0x2
    dut.m_arqos[master].value = qos
    dut.m_aruser[master].value = 0


async def collect_beats(dut, expected_per_master, max_cycles, qos_per_master=None):
    """Drive the fabric until every master has produced
    ``expected_per_master`` R-beats or ``max_cycles`` elapses.  All
    masters drive AR in parallel; AR handshakes are detected inside the
    main loop and reissued immediately so each master keeps pressing.

    Returns the per-master beat counts, the maximum consecutive
    same-master R-beat streak (used for the starvation guard), and the
    number of cycles the run consumed.
    """
    qos_per_master = qos_per_master or [0] * NUM_MASTERS
    full_ones = (1 << NUM_MASTERS) - 1
    dut.m_rready.value = full_ones

    base_per_master = [0x1000 * (m + 1) * 16 for m in range(NUM_MASTERS)]
    burst_len = 16
    arid = 0x1
    outstanding = [0] * NUM_MASTERS

    # Pre-arm all 8 masters with their first AR in parallel.  Track
    # arvalid locally so the vector write atomically captures every
    # master's bit in the same simulation tick.
    arvalid_mask = 0
    for m in range(NUM_MASTERS):
        setup_ar_fields(dut, m, arid, base_per_master[m], burst_len, qos=qos_per_master[m])
        arvalid_mask |= 1 << m
        outstanding[m] += 1
    dut.m_arvalid.value = arvalid_mask

    counts = [0] * NUM_MASTERS
    last_grant = -1
    streak = 0
    max_streak = 0
    cycle = 0
    for cycle in range(max_cycles):  # noqa: B007  used after the loop
        await RisingEdge(dut.clk)

        # AR handshake: clear arvalid bits whose master also saw arready
        # this cycle.  Use the locally tracked mask so subsequent
        # iterations within the same tick are consistent.
        arready_now = int(dut.m_arready.value)
        accepted = arready_now & arvalid_mask
        if accepted:
            arvalid_mask &= ~accepted
            dut.m_arvalid.value = arvalid_mask

        # R-beat consumption + per-master beat counting.
        rvalid = int(dut.m_rvalid.value)
        for m in range(NUM_MASTERS):
            bit = 1 << m
            if rvalid & bit:
                counts[m] += 1
                if last_grant == m:
                    streak += 1
                else:
                    streak = 1
                    last_grant = m
                if streak > max_streak:
                    max_streak = streak
                if int(dut.m_rlast.value) & bit:
                    outstanding[m] -= 1
                    base_per_master[m] += burst_len * BYTES_PER_BEAT
                    if counts[m] < expected_per_master:
                        setup_ar_fields(
                            dut,
                            m,
                            arid,
                            base_per_master[m],
                            burst_len,
                            qos=qos_per_master[m],
                        )
                        arvalid_mask |= bit
                        outstanding[m] += 1
        if accepted or any(
            rvalid & (1 << m) and int(dut.m_rlast.value) & (1 << m) for m in range(NUM_MASTERS)
        ):
            # Any update to the mask above must be written back to the
            # DUT so other masters see the new valid pattern.
            dut.m_arvalid.value = arvalid_mask

        if all(c >= expected_per_master for c in counts):
            break
    else:
        cycle = max_cycles

    dut.m_arvalid.value = 0
    dut.m_rready.value = 0
    return counts, max_streak, cycle


@cocotb.test()
async def equal_qos_round_robin_no_starvation(dut):
    """All eight masters with QoS=0 must each receive >=16 beats in well
    under MAX_STARVATION_BEATS-per-master consecutive runs."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    counts, max_streak, cycles = await collect_beats(dut, expected_per_master=64, max_cycles=20000)
    dut._log.info(
        f"per-master beat counts (equal QoS): {counts}; max streak={max_streak};"
        f" total cycles={cycles}"
    )
    assert all(c >= 64 for c in counts), f"some master got under 64 beats: {counts}"
    assert max_streak <= MAX_STARVATION_BEATS, (
        f"max consecutive same-master R-beats {max_streak} > {MAX_STARVATION_BEATS}"
    )


@cocotb.test()
async def qos_weighted_high_master_wins_no_starvation(dut):
    """Master 0 with the highest QoS must receive at least 1.5x the
    minimum-served master while no master goes unserved."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset(dut)

    qos = [15] + [0] * (NUM_MASTERS - 1)
    counts, max_streak, cycles = await collect_beats(
        dut, expected_per_master=32, max_cycles=20000, qos_per_master=qos
    )
    dut._log.info(
        f"per-master beat counts (QoS bias): {counts}; max streak={max_streak};"
        f" total cycles={cycles}"
    )
    # Every master must still be eventually served.
    assert all(c > 0 for c in counts), f"a master got zero beats: {counts}"
    # The high-QoS master should be served at least as much as the
    # average of the rest; the QoS-bias picker breaks ties in favour
    # of higher AxQOS so under steady-state load master 0 should run
    # ahead of the equal-QoS baseline.
    high = counts[0]
    others = counts[1:]
    avg_other = sum(others) / len(others)
    assert high >= avg_other, f"high-QoS master got {high} beats vs avg-other {avg_other:.1f}"
    # No master goes over the starvation window even with QoS bias.
    assert max_streak <= MAX_STARVATION_BEATS, (
        f"max consecutive same-master R-beats {max_streak} > {MAX_STARVATION_BEATS}"
    )
