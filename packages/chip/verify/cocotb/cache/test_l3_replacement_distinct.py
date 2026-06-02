"""L3 replacement-policy distinctness proof.

The e1_l3_cache claims that REPLACEMENT_POLICY selects between three real,
delegated sub-modules (DRRIP, Hawkeye, Mockingjay). The audit finding
l3-replacement-policy-larp flagged that the old inline pick_victim()
silently collapsed policies 1/2 onto tree-PLRU.

This test drives the SAME access-event stream into all three instantiated
sub-modules at once (e1_l3_replacement_tb) and exposes each policy's
proposed victim_way for the same query set. It proves two things:

  1. Liveness: each policy responds to its own training. After the policy
     proposes a victim, a HIT on that very way must change the proposed
     victim (a dead constant/aliased policy would keep proposing it).

  2. Distinctness: over a shared install/hit/miss stream the three policies
     produce pairwise-different victim sequences. If Hawkeye/Mockingjay
     were the old silent PLRU alias of DRRIP, the sequences would match.

Geometry mirrors e1_l3_replacement_tb (WAYS=8, SETS=64). Phone-class IPC
of any individual policy remains BLOCKED — see
docs/evidence/cache/cache-evidence-gate.yaml.
"""

from __future__ import annotations

import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

WAYS = 8
SETS = 64
TAG_W = 24
TAG_MASK = (1 << TAG_W) - 1

# Index of each policy's victim in the sample_victims() tuple.
DRRIP, HAWKEYE, MOCKINGJAY = 0, 1, 2
POLICY_NAMES = ("DRRIP", "Hawkeye", "Mockingjay")


async def reset_dut(dut) -> None:
    dut.rst_n.value = 0
    dut.acc_valid.value = 0
    dut.acc_set.value = 0
    dut.acc_hit.value = 0
    dut.acc_way.value = 0
    dut.acc_is_miss_install.value = 0
    dut.acc_tag.value = 0
    dut.query_set.value = 0
    for _ in range(5):
        await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    await RisingEdge(dut.clk)


async def drive_access(
    dut,
    *,
    set_idx: int,
    way: int,
    hit: bool,
    install: bool,
    tag: int,
) -> None:
    dut.acc_valid.value = 1
    dut.acc_set.value = set_idx
    dut.acc_way.value = way
    dut.acc_hit.value = 1 if hit else 0
    dut.acc_is_miss_install.value = 1 if install else 0
    dut.acc_tag.value = tag & TAG_MASK
    await RisingEdge(dut.clk)
    dut.acc_valid.value = 0


async def sample_victims(dut, set_idx: int) -> tuple[int, int, int]:
    """Read each policy's proposed victim for `set_idx` (combinational)."""
    dut.query_set.value = set_idx
    await RisingEdge(dut.clk)
    return (
        int(dut.drrip_victim.value),
        int(dut.hawkeye_victim.value),
        int(dut.mockingjay_victim.value),
    )


async def fill_set(dut, set_idx: int, round_idx: int) -> None:
    """Install a fresh line into every way of the set."""
    for way in range(WAYS):
        await drive_access(
            dut,
            set_idx=set_idx,
            way=way,
            hit=False,
            install=True,
            tag=(round_idx << 8) | way,
        )


@cocotb.test()
async def test_l3_replacement_policy_liveness(dut):
    """Each policy must respond to its own training: after every way is a
    standing eviction candidate, a hit on the proposed victim must move the
    victim elsewhere. The old bug aliased Hawkeye/Mockingjay onto tree-PLRU
    and would not react to the policy-specific RRPV/ETR training the L3
    drives here.

    Each policy is tested on its own freshly-reset state (a separate set
    index plus a reset between policies) so one policy's stream never
    perturbs another's measurement."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())

    for policy in (DRRIP, HAWKEYE, MOCKINGJAY):
        await reset_dut(dut)
        set_idx = 5

        # Fill every way, then age the whole set so multiple ways become
        # standing eviction candidates (RRPV at max / large ETR). This is
        # the regime where evicting the proposed victim is unambiguous.
        await fill_set(dut, set_idx, round_idx=0)
        for _ in range(8):
            await drive_access(
                dut,
                set_idx=set_idx,
                way=0,
                hit=False,
                install=False,
                tag=0x900000 | _,
            )

        victim_before = (await sample_victims(dut, set_idx))[policy]
        # Hit the proposed victim way: a live RRIP/ETR policy lowers that
        # way's eviction priority and the victim must move.
        await drive_access(
            dut,
            set_idx=set_idx,
            way=victim_before,
            hit=True,
            install=False,
            tag=victim_before,
        )
        victim_after = (await sample_victims(dut, set_idx))[policy]
        dut._log.info(
            f"{POLICY_NAMES[policy]} victim before hit={victim_before} after hit={victim_after}"
        )
        assert victim_after != victim_before, (
            f"{POLICY_NAMES[policy]} did not react to a hit on its proposed "
            f"victim (way {victim_before}); policy is not live"
        )


@cocotb.test()
async def test_l3_replacement_policies_distinct(dut):
    """All three L3 replacement policies must produce distinct victim
    sequences over a shared install/hit/miss stream."""
    cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
    await reset_dut(dut)

    set_idx = 7
    drrip_seq: list[int] = []
    hawkeye_seq: list[int] = []
    mockingjay_seq: list[int] = []

    for round_idx in range(8):
        for way in range(WAYS):
            d, h, m = await sample_victims(dut, set_idx)
            drrip_seq.append(d)
            hawkeye_seq.append(h)
            mockingjay_seq.append(m)
            await drive_access(
                dut,
                set_idx=set_idx,
                way=way,
                hit=False,
                install=True,
                tag=(round_idx << 8) | way,
            )
        # Mixed hit/miss aging so each policy's state machine diverges.
        for way in (1, 3, 6):
            await drive_access(
                dut,
                set_idx=set_idx,
                way=way,
                hit=True,
                install=False,
                tag=(round_idx << 8) | way,
            )
        await drive_access(
            dut,
            set_idx=set_idx,
            way=0,
            hit=False,
            install=False,
            tag=0x800000 | round_idx,
        )

    dut._log.info(f"DRRIP victim seq:      {drrip_seq}")
    dut._log.info(f"Hawkeye victim seq:    {hawkeye_seq}")
    dut._log.info(f"Mockingjay victim seq: {mockingjay_seq}")

    assert drrip_seq != hawkeye_seq, (
        "DRRIP and Hawkeye produced identical victim sequences; policy selection is not distinct"
    )
    assert drrip_seq != mockingjay_seq, (
        "DRRIP and Mockingjay produced identical victim sequences; policy selection is not distinct"
    )
    assert hawkeye_seq != mockingjay_seq, (
        "Hawkeye and Mockingjay produced identical victim sequences; "
        "policy selection is not distinct"
    )

    print(
        "L3_REPLACEMENT_DISTINCT_SUMMARY "
        f"drrip_vs_hawkeye_diff={sum(a != b for a, b in zip(drrip_seq, hawkeye_seq, strict=True))} "
        f"drrip_vs_mj_diff={sum(a != b for a, b in zip(drrip_seq, mockingjay_seq, strict=True))} "
        f"hawkeye_vs_mj_diff={sum(a != b for a, b in zip(hawkeye_seq, mockingjay_seq, strict=True))}"
    )
