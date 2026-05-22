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

The tiny stub CPU has none of those. The test runs in two modes:

  - stub mode: assert the DUT cannot resolve Sv39 (signals absent) and
    record BLOCKED.
  - real mode: once the DUT exposes ``satp_q`` (or ``dut_has_mmu``) the
    cocotb body programs satp, the page table, and walks a load. This
    body is still a skeleton; flipping it on is gated by a real DUT in
    `verify/cocotb/cpu/conftest.py` (TBD) and explicit env override.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parents[3]
_CVA6_CHIPYARD_RTL = _ROOT / "external/chipyard/generators/cva6/src/main/resources/cva6/vsrc/cva6"
_CVA6_STANDALONE_RTL = _ROOT / "external/cva6/cva6"


def _cva6_rtl_present() -> tuple[bool, str]:
    """Return (present, source_path) when CVA6 core RTL is checked out."""
    for candidate in (_CVA6_CHIPYARD_RTL, _CVA6_STANDALONE_RTL):
        if not candidate.is_dir():
            continue
        for entry in candidate.rglob("*"):
            if entry.is_file() and entry.suffix in (".sv", ".v"):
                return True, str(candidate.relative_to(_ROOT))
    return False, ""


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
# Bit 8 is an Sv39 RSW slot that the e1 big core proposes to use as the
# Ztso (Total Store Order) per-page indicator. See
# rtl/cpu/csr/ztso_ctrl.sv and docs/arch/ooo-cluster.md.
PTE_ZTSO_RSW = 1 << 8

SATP_MODE_SV39 = 8
SATP_MODE_SV48 = 9
SATP_MODE_SV57 = 10


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
        "satp_mode_sv39": SATP_MODE_SV39,
        "satp_value": (SATP_MODE_SV39 << 60) | (root_pa >> 12),
        "entries": entries,
    }


def build_page_table_with_ztso(va: int, pa_page: int, perm: int) -> dict:
    """Like build_page_table but sets the Ztso RSW bit on the leaf."""
    base = build_page_table(va, pa_page, perm | PTE_ZTSO_RSW)
    # Validate the leaf carries the RSW bit.
    indices = virt_to_indices(va)
    leaf_addr = 0x8020_2000 + 8 * indices[2]
    assert base["entries"][leaf_addr] & PTE_ZTSO_RSW
    return base


def _real_dut(dut) -> bool:
    return any(hasattr(dut, n) for n in ("satp_q", "dut_has_mmu", "csr_satp"))


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
    # The Ztso variant must set bit 8 but not change the PPN.
    tbl_ztso = build_page_table_with_ztso(va, pa_page, PTE_R | PTE_W)
    leaf_ztso = tbl_ztso["entries"][leaf_addr]
    assert leaf_ztso & PTE_ZTSO_RSW
    assert (leaf_ztso >> 10) & ((1 << 44) - 1) == pa_page >> 12
    # Multi-VA collision check: two different VAs must land in different
    # leaf slots so the builder is not aliasing.
    a = build_page_table(0x0000_0000_DEAD_0000, 0x8010_0000, PTE_R)
    b = build_page_table(0x0000_0000_DEAD_1000, 0x8010_1000, PTE_R)
    a_leaf = 0x8020_2000 + 8 * virt_to_indices(0x0000_0000_DEAD_0000)[2]
    b_leaf = 0x8020_2000 + 8 * virt_to_indices(0x0000_0000_DEAD_1000)[2]
    assert a_leaf != b_leaf
    assert a["entries"][a_leaf] != b["entries"][b_leaf]
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
        if not _real_dut(dut):
            cocotb.log.info(
                "STATUS: BLOCKED cpu.mmu_sv39_evidence - "
                "DUT has no satp/MMU; real CVA6/Kunminghu required."
            )
            return
        raise AssertionError(
            "DUT exposes satp_q/dut_has_mmu but the test body has not been "
            "implemented for the real core path; flip me on when CVA6 lands."
        )


def main(argv: list[str] | None = None) -> int:
    host_self_check()
    if os.environ.get("E1_REQUIRE_REAL_MMU_DUT"):
        present, source = _cva6_rtl_present()
        if not present:
            print(
                "STATUS: FAIL cpu.mmu_sv39_evidence - E1_REQUIRE_REAL_MMU_DUT set "
                "but no CVA6 RTL is checked out."
            )
            print(
                "  next: git -C external/chipyard submodule update --init "
                "--recursive generators/cva6"
            )
            print("  alt:  git clone https://github.com/openhwgroup/cva6.git external/cva6/cva6")
            return 1
        print(
            "STATUS: BLOCKED cpu.mmu_sv39_evidence - "
            f"CVA6 RTL detected at {source}; positive-path Sv39 walk TB "
            "(verify/cocotb/cpu/e1_cva6_mmu_tb.sv) has not been ported. "
            "Wire up before flipping E1_REQUIRE_REAL_MMU_DUT to PASS."
        )
        return 1
    print(
        "STATUS: BLOCKED cpu.mmu_sv39_evidence - "
        "real Sv39 walk requires CVA6 / Kunminghu DUT; "
        "page-table builder + Ztso RSW host check passed."
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main(sys.argv[1:]))
