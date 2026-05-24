"""Host-side sanity check on rtl/cpu/csr/zihpm.sv event enum.

Confirms the OoO-domain contract event IDs are present in
``zihpm_pkg::hpm_event_e`` and that no two enumerants share an ID. Also
confirms:

  - ``EVT_NONE`` is enumerant 0 (the no-event sentinel).
  - The branch-block events match the names emitted by the
    cross-domain BPU remap in ``rtl/cpu/csr/bpu_to_zihpm_remap.sv``.
  - Cache events live in the 32..47 range, MMU/TLB events in 48..63,
    OoO events at 64+, per the docs/arch/ooo-cluster.md cross-domain
    table.
  - The cluster-level extension (cache/memory/IOMMU/MMU/OoO blocks)
    has no overlap with the branch block.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
ZIHPM = ROOT / "rtl/cpu/csr/zihpm.sv"
REMAP = ROOT / "rtl/cpu/csr/bpu_to_zihpm_remap.sv"

REQUIRED_EVENTS = (
    "EVT_BR_TAKEN",
    "EVT_BR_MISP",
    "EVT_BR_IND_MISP",
    "EVT_BR_RET_MISP",
    "EVT_FETCH_BUBBLE",
    "EVT_BTB_MISS",
    "EVT_FTQ_FULL",
    "EVT_L1I_MISS",
    "EVT_L1D_MISS",
    "EVT_L2_MISS",
    "EVT_L3_MISS",
    "EVT_SLC_MISS",
    "EVT_DTLB_MISS",
    "EVT_ITLB_MISS",
    "EVT_PTW_WALK",
    "EVT_STORE_SET_MISP",
)


def parse_events() -> dict[str, int]:
    if not ZIHPM.is_file():
        raise SystemExit(f"missing {ZIHPM.relative_to(ROOT)}")
    text = ZIHPM.read_text(encoding="utf-8")
    match = re.search(
        r"typedef\s+enum\s+logic\s*\[[^\]]+\]\s*\{(.+?)\}\s*hpm_event_e",
        text,
        re.S,
    )
    if not match:
        raise SystemExit("could not find hpm_event_e enum in zihpm.sv")
    body = match.group(1)
    items: dict[str, int] = {}
    for line in body.splitlines():
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        m = re.match(r"(EVT_[A-Z0-9_]+)\s*=\s*8'd(\d+)", line)
        if m:
            name, value = m.group(1), int(m.group(2))
            if value in items.values():
                raise SystemExit(f"duplicate event id {value} for {name}")
            items[name] = value
    return items


def parse_remap_destinations() -> set[str]:
    if not REMAP.is_file():
        return set()
    text = REMAP.read_text(encoding="utf-8")
    return set(re.findall(r"zihpm_evbus_o\[(EVT_[A-Z0-9_]+)\]\s*=", text))


def main(argv: list[str] | None = None) -> int:
    events = parse_events()
    errors: list[str] = []

    missing = [event for event in REQUIRED_EVENTS if event not in events]
    if missing:
        errors.append(f"zihpm.required_events missing: {missing}")

    if events.get("EVT_NONE") != 0:
        errors.append("EVT_NONE must equal 0 (sentinel contract)")

    remap_dests = parse_remap_destinations()
    branch_upper = max((events[name] for name in remap_dests if name in events), default=0)
    if branch_upper <= 0:
        errors.append("BPU remap did not declare any branch-block destinations")

    # Range partition contract (matches docs/arch/ooo-cluster.md).
    branch_block = {n: v for n, v in events.items() if 1 <= v <= branch_upper}
    cache_block = {n: v for n, v in events.items() if 32 <= v <= 47}
    mmu_block = {n: v for n, v in events.items() if 48 <= v <= 63}
    ooo_block = {n: v for n, v in events.items() if 64 <= v <= 95}

    for name, val in events.items():
        if name == "EVT_NONE":
            continue
        if (
            not (1 <= val <= branch_upper)
            and not (32 <= val <= 47)
            and not (48 <= val <= 63)
            and not (64 <= val <= 95)
        ):
            errors.append(
                f"event {name}={val} sits outside the partitioned blocks "
                f"(branch 1..{branch_upper}, cache 32..47, mmu 48..63, ooo 64..95)"
            )

    # All branch-block names must start with EVT_BR_ or EVT_FT/EVT_BTB/EVT_RAS/...
    for name in branch_block:
        if not name.startswith(
            (
                "EVT_BR_",
                "EVT_FT",
                "EVT_BTB_",
                "EVT_RAS_",
                "EVT_UFTB_",
                "EVT_TAGE_",
                "EVT_LOOP_",
                "EVT_SC_",
                "EVT_H2P_",
                "EVT_L2_BTB_",
                "EVT_LOCAL_DIR_",
                "EVT_BPU_META_",
                "EVT_TWO_AHEAD_",
                "EVT_FETCH_",
            )
        ):
            errors.append(f"branch-block event {name} has unexpected prefix")
    for name in cache_block:
        if not name.startswith(
            ("EVT_L1I_", "EVT_L1D_", "EVT_L2_", "EVT_L3_", "EVT_SLC_", "EVT_DCACHE_")
        ):
            errors.append(f"cache-block event {name} has unexpected prefix")
    for name in mmu_block:
        if not name.startswith(("EVT_DTLB_", "EVT_ITLB_", "EVT_PTW_", "EVT_TLB_")):
            errors.append(f"mmu-block event {name} has unexpected prefix")
    for name in ooo_block:
        if not name.startswith(
            (
                "EVT_DISPATCH",
                "EVT_RETIRE",
                "EVT_ROB_",
                "EVT_LQ_",
                "EVT_SQ_",
                "EVT_RS_",
                "EVT_STORE_SET_",
                "EVT_FUSION_",
                "EVT_FENCE_",
                "EVT_AMO_",
            )
        ):
            errors.append(f"ooo-block event {name} has unexpected prefix")

    # Remap consistency: every BPU-driven Zihpm slot must be in the branch
    # block.
    for name in remap_dests:
        if name not in branch_block:
            errors.append(
                f"BPU remap drives {name} which is not in the branch block 1..{branch_upper}"
            )

    if errors:
        print("STATUS: FAIL cpu.zihpm_event_table")
        for err in errors:
            print(f"  - {err}")
        return 1

    print(
        f"STATUS: PASS cpu.zihpm_event_table - {len(events)} events; "
        f"branch={len(branch_block)} cache={len(cache_block)} "
        f"mmu={len(mmu_block)} ooo={len(ooo_block)}; "
        f"remap_dests={len(remap_dests)}"
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main(sys.argv[1:]))
