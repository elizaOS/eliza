"""Mockingjay-vs-LRU accuracy benchmark on a synthetic stream.

The cocotb DUT (`e1_mockingjay_prod`) exposes a `victim_way` query
output plus access-update inputs. The harness:

1. Reproduces the Mockingjay-style set's victim choice from the DUT via
   the `query_set` output and feeds back the actual hit/miss decision.
2. Runs the same stream through a pure-Python LRU model.
3. Compares hit-rate.

Stream pattern: "scan + reuse" — a small hot working set (HOT_SET) that
fits in the per-set associativity, interleaved with a large scan that
strides through many cold sets. Classical LRU evicts the hot set on
every scan pass; Mockingjay should learn (via the STT-fed RTP) that the
hot-set PCs are short-reuse and keep them.

Pass criterion: Mockingjay hit-rate is at least +10% (absolute or
relative) above LRU on this synthetic stream. Phone-class IPC remains
BLOCKED — see docs/evidence/cache/cache-evidence-gate.yaml.
"""

from __future__ import annotations

import collections
import random

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge


# Trim DUT geometry mirrored from e1_mockingjay_prod_tb.sv
WAYS = 8
SETS = 64
SET_IDX_W = 6


class LRUModel:
    """Pure-Python per-set LRU oracle.

    `access(set_idx, tag)` returns True on a hit, False on a miss. On a
    miss, the entry is installed and the LRU victim is evicted.
    """

    def __init__(self, ways: int, sets: int) -> None:
        self.ways = ways
        self.sets = sets
        # Each set is an OrderedDict tag -> dummy (LRU semantics)
        self._sets = [collections.OrderedDict() for _ in range(sets)]
        self.hits = 0
        self.misses = 0

    def access(self, set_idx: int, tag: int) -> bool:
        s = self._sets[set_idx]
        if tag in s:
            s.move_to_end(tag)
            self.hits += 1
            return True
        if len(s) >= self.ways:
            s.popitem(last=False)
        s[tag] = True
        self.misses += 1
        return False


class TrackedTagSet:
    """Tracks {set_idx -> {way: tag}} so the DUT's victim_way decisions
    map to a concrete tag identity for hit/miss bookkeeping."""

    def __init__(self, ways: int, sets: int) -> None:
        self.ways = ways
        self.sets = sets
        self.way_to_tag = [[None] * ways for _ in range(sets)]
        self.tag_to_way = [{} for _ in range(sets)]

    def lookup(self, set_idx: int, tag: int) -> int | None:
        return self.tag_to_way[set_idx].get(tag)

    def install(self, set_idx: int, tag: int, way: int) -> None:
        old = self.way_to_tag[set_idx][way]
        if old is not None:
            self.tag_to_way[set_idx].pop(old, None)
        self.way_to_tag[set_idx][way] = tag
        self.tag_to_way[set_idx][tag] = way


def gen_stream(num_ops: int, seed: int = 42):
    """Yield (set_idx, tag, pc) over `num_ops` operations.

    Adversarial-to-LRU "thrashing" pattern. Each iteration of the outer
    loop touches a hot working set in a few sets, then walks a small
    scan over the SAME sets with one-use tags. The scan burst is sized
    > WAYS so LRU is guaranteed to evict the hot working set, but
    Mockingjay's PC-keyed RTP should learn that scan_pc has long-reuse
    (it never revisits a tag) and insert scan lines as eviction-priority,
    leaving the hot lines alone.

    The hot working set has tags `[0..3]` per set (4 tags x 4 sets = 16
    hot lines total). The scan PC has a per-burst stride of WAYS+1 lines
    so each burst forces an LRU eviction of one hot line per set.
    """
    rng = random.Random(seed)
    hot_sets = [0, 1, 2, 3]                  # 4 sets share both populations
    hot_pcs = [0x10_0000, 0x10_0040, 0x10_0080, 0x10_00C0]
    scan_pc = 0x20_0000
    HOT_TAGS = 4
    HOT_REPS_PER_BURST = 4   # repeat the (set,tag) walk this many times
    # WAYS=8 ways. Forcing LRU to evict the 4 hot tags requires more than
    # (WAYS - HOT_TAGS) unique scan tags per set. Use 8 unique scan tags
    # per hot set per burst.
    SCAN_PER_SET = 8
    scan_uid = 0
    i = 0
    while i < num_ops:
        # 1) Hot phase: HOT_REPS_PER_BURST passes over (hot_sets x HOT_TAGS).
        # After the first full pass the lines are installed; subsequent
        # passes within the same burst are hits if the cache retained them.
        for _ in range(HOT_REPS_PER_BURST):
            for s in hot_sets:
                for t in range(HOT_TAGS):
                    if i >= num_ops:
                        return
                    yield s, t, hot_pcs[t]
                    i += 1
        # 2) Scan phase: SCAN_PER_SET unique scan tags per hot set, which
        # is more than the per-set free slots after hot tags are installed.
        for s in hot_sets:
            for _ in range(SCAN_PER_SET):
                if i >= num_ops:
                    return
                scan_uid += 1
                tag = 0x80000 | scan_uid
                yield s, tag, scan_pc
                i += 1
        _ = rng  # rng kept for future stream variations


async def reset_dut(dut) -> None:
    dut.rst_n.value = 0
    dut.acc_valid.value = 0
    dut.acc_set.value = 0
    dut.acc_hit.value = 0
    dut.acc_way.value = 0
    dut.acc_is_miss_install.value = 0
    dut.acc_pc.value = 0
    dut.query_set.value = 0
    for _ in range(5):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


@cocotb.test()
async def test_mockingjay_beats_lru_on_scan_reuse(dut):
    """Run a synthetic scan+reuse stream through the Mockingjay DUT and
    an LRU oracle. Assert that Mockingjay's hit-rate is at least +10%
    higher (relative) than the LRU oracle's hit-rate."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    tracker = TrackedTagSet(ways=WAYS, sets=SETS)
    lru = LRUModel(ways=WAYS, sets=SETS)

    mj_hits = 0
    mj_misses = 0
    NUM_OPS = 2000

    for op_idx, (s, tag, pc) in enumerate(gen_stream(NUM_OPS, seed=1)):
        # 1. Decide hit/miss in the Mockingjay-driven tracked set.
        way = tracker.lookup(s, tag)
        if way is not None:
            mj_hits += 1
            hit = 1
            install = 0
            target_way = way
        else:
            mj_misses += 1
            hit = 0
            install = 1
            # Query the DUT for the victim way for this set
            dut.query_set.value = s
            await RisingEdge(dut.clk)
            target_way = int(dut.victim_way.value)
            tracker.install(s, tag, target_way)

        # 2. Drive the access update into the DUT
        dut.acc_valid.value = 1
        dut.acc_set.value = s
        dut.acc_hit.value = hit
        dut.acc_way.value = target_way
        dut.acc_is_miss_install.value = install
        dut.acc_pc.value = pc
        await RisingEdge(dut.clk)
        dut.acc_valid.value = 0

        # 3. Same access against the LRU oracle.
        lru.access(s, tag)

    # Allow the DUT counters to settle.
    for _ in range(3):
        await RisingEdge(dut.clk)

    mj_total = mj_hits + mj_misses
    lru_total = lru.hits + lru.misses
    mj_rate = mj_hits / mj_total
    lru_rate = lru.hits / lru_total

    dut._log.info(
        f"Mockingjay: {mj_hits}/{mj_total} = {mj_rate:.4f}  "
        f"LRU: {lru.hits}/{lru_total} = {lru_rate:.4f}"
    )
    dut._log.info(
        f"DUT-reported counters: hits={int(dut.hits_count.value)} "
        f"misses={int(dut.misses_count.value)}"
    )

    # Sanity: the DUT-reported counters should be close to (within a few
    # extra cycles for the query path) our externally-tracked counts.
    dut_hits = int(dut.hits_count.value)
    dut_misses = int(dut.misses_count.value)
    assert dut_hits + dut_misses == mj_total, (
        f"DUT total {dut_hits + dut_misses} != tracked total {mj_total}"
    )

    # Pass criterion: Mockingjay's hit-rate beats LRU's by at least 10%.
    # The number is reported on stdout so the cocotb-cache evidence gate
    # can extract it; the harness only asserts the minimum bar.
    rel_gain = (mj_rate - lru_rate) / max(lru_rate, 1e-6)
    abs_gain = mj_rate - lru_rate
    dut._log.info(
        f"Mockingjay vs LRU: abs_gain={abs_gain*100:.2f}% "
        f"rel_gain={rel_gain*100:.2f}%"
    )

    # Emit a machine-readable line for the evidence gate to parse.
    print(
        f"MOCKINGJAY_VS_LRU_SUMMARY mj_rate={mj_rate:.6f} "
        f"lru_rate={lru_rate:.6f} abs_gain={abs_gain:.6f} "
        f"rel_gain={rel_gain:.6f}"
    )

    assert mj_rate > lru_rate, "Mockingjay must beat LRU on the synthetic stream"
    assert abs_gain >= 0.10 or rel_gain >= 0.10, (
        f"Mockingjay-vs-LRU gain {abs_gain*100:.2f}% absolute "
        f"({rel_gain*100:.2f}% relative) below 10% threshold"
    )
