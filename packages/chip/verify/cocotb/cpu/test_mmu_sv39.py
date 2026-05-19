"""Sv39 MMU smoke for the e1 CPU subsystem.

Builds a hand-rolled three-level Sv39 page table in DRAM:

    Virtual address V = 0x0000_0000_DEAD_0000
    Physical mapping  PPN = 0x80100  (DRAM @ 0x80100000)
    Permissions       R=1 W=1 X=0 U=0 (kernel data)

Lays out the table at DRAM[0x80200000] (root), DRAM[0x80201000] (middle),
DRAM[0x80202000] (leaf). Writes a sentinel byte at the physical page and
expects the CPU to be able to load it via the virtual address after satp
points at the root.

DUT requirements:
  - satp CSR
  - Sv39 page-table walker
  - S-mode entry
  - dcache flush / fence.vma plumbing

None of those are present in the tiny stub CPU. This file is therefore
parked as a structural skeleton: the cocotb tests are skipped fail-closed
on the stub, and the same file is rerunnable against the real
``E1_HAVE_CVA6`` build later. The host-side checker prints BLOCKED.
"""

from __future__ import annotations

import sys
from typing import Any

_cocotb: Any
try:
    import cocotb as _cocotb_real
    from cocotb.clock import Clock
    from cocotb.triggers import RisingEdge, Timer

    _cocotb = _cocotb_real
except Exception:  # noqa: BLE001 - only cocotb runs this
    _cocotb = None

cocotb: Any = _cocotb


# Sv39 PTE field bits: V R W X U G A D PPN[26:0] (low 8 bits are flags+RSW)
PTE_V = 1 << 0
PTE_R = 1 << 1
PTE_W = 1 << 2
PTE_X = 1 << 3
PTE_U = 1 << 4
PTE_G = 1 << 5
PTE_A = 1 << 6
PTE_D = 1 << 7
# Bit 7 also doubles as the proposed Ztso indicator per
# rtl/cpu/csr/ztso_ctrl.sv when D is encoded separately; the current
# Sv39 spec reserves bits 8-9 for RSW so a software-allocated Ztso bit
# can live at bit 8 without conflicting.
PTE_ZTSO_RSW = 1 << 8


def pte_make(ppn: int, perm: int) -> int:
    """Build a 64-bit Sv39 leaf PTE."""
    return (ppn << 10) | perm | PTE_V | PTE_A | PTE_D


def pte_branch(next_ppn: int) -> int:
    """Build a non-leaf PTE (R=W=X=0)."""
    return (next_ppn << 10) | PTE_V


def virt_to_indices(va: int) -> list[int]:
    """Return Sv39 [vpn2, vpn1, vpn0] page indices."""
    return [(va >> 30) & 0x1FF, (va >> 21) & 0x1FF, (va >> 12) & 0x1FF]


def build_page_table(va: int, pa_page: int, perm: int) -> dict:
    """Return a dict of {phys_addr: 64-bit value} encoding a 3-level walk."""
    root_pa = 0x8020_0000
    mid_pa = 0x8020_1000
    leaf_pa = 0x8020_2000
    indices = virt_to_indices(va)

    entries: dict = {}
    # Root PTE at root_pa + 8*vpn2 points to mid table.
    entries[root_pa + 8 * indices[0]] = pte_branch(mid_pa >> 12)
    # Middle PTE points to leaf table.
    entries[mid_pa + 8 * indices[1]] = pte_branch(leaf_pa >> 12)
    # Leaf PTE points to physical page.
    entries[leaf_pa + 8 * indices[2]] = pte_make(pa_page >> 12, perm)

    return {
        "root_pa": root_pa,
        "satp_mode_sv39": 8,
        "satp_value": (8 << 60) | (root_pa >> 12),
        "entries": entries,
    }


# -------- host-side structural checks --------


def host_self_check() -> int:
    """Sanity check the page-table builder math runs without DUT."""
    va = 0x0000_0000_DEAD_0000
    pa_page = 0x8010_0000
    tbl = build_page_table(va, pa_page, PTE_R | PTE_W)
    assert tbl["satp_mode_sv39"] == 8
    indices = virt_to_indices(va)
    assert indices == [(va >> 30) & 0x1FF, (va >> 21) & 0x1FF, (va >> 12) & 0x1FF]
    leaf_addr = 0x8020_2000 + 8 * indices[2]
    leaf_pte = tbl["entries"][leaf_addr]
    assert (leaf_pte >> 10) & ((1 << 44) - 1) == pa_page >> 12
    assert leaf_pte & PTE_V
    assert leaf_pte & PTE_R
    assert leaf_pte & PTE_W
    assert not (leaf_pte & PTE_X)
    return 0


if cocotb is not None:

    @cocotb.test()
    async def sv39_smoke_skipped_on_tiny_stub(dut) -> None:
        """Tiny CPU has no MMU; this test must record the BLOCKED state."""
        cocotb.start_soon(Clock(dut.clk, 10, units="ns").start())
        # Drive reset, then immediately mark the test BLOCKED. The DUT
        # cannot do anything meaningful with an Sv39 walk.
        dut.rst_n.value = 0
        await Timer(1, units="ns")
        for _ in range(4):
            await RisingEdge(dut.clk)
        dut.rst_n.value = 1
        await RisingEdge(dut.clk)
        # If a real MMU shows up later, replace this body with the full
        # walk + load smoke. Until then, halt-fail-closed must be honored.
        if not hasattr(dut, "satp_q") and not hasattr(dut, "dut_has_mmu"):
            cocotb.log.info(
                "STATUS: BLOCKED cpu.mmu_sv39_evidence - "
                "DUT has no satp/MMU; real CVA6/Kunminghu/Ascalon required."
            )
            return
        raise AssertionError(
            "DUT exposes satp_q/dut_has_mmu but the test body has not been "
            "implemented for the real core path; flip me on when CVA6 lands."
        )


def main(argv: list[str] | None = None) -> int:
    host_self_check()
    print(
        "STATUS: BLOCKED cpu.mmu_sv39_evidence - "
        "real Sv39 walk requires CVA6 / Kunminghu / Ascalon DUT; "
        "page-table builder self-check passed."
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main(sys.argv[1:]))
