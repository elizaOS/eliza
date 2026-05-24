#!/usr/bin/env python3
"""Cross-domain harmonization check: BPU PMU enum vs Zihpm event enum.

The BPU agent owns ``rtl/cpu/bpu/bpu_pkg.sv`` which declares the
``pmu_event_e`` enum (5-bit IDs 0..25). The OoO / CSR domain owns
``rtl/cpu/csr/zihpm.sv`` which declares the ``hpm_event_e`` enum (8-bit
IDs, EVT_NONE=0 + branch block 1..PMU_EVENTS + cache/memory/OoO blocks).

The cross-domain wiring lives in ``rtl/cpu/csr/bpu_to_zihpm_remap.sv``. This
script enforces that every BPU branch event has a unique destination in the
Zihpm enum and that the remap module names them consistently. The check
fails closed on:

  - any BPU enum entry that has no matching Zihpm name (modulo the documented
    PMU_FTB_MISS <-> EVT_BTB_MISS aliasing);
  - any Zihpm branch-block entry without a matching BPU entry;
  - any duplicate destination in the remap table.

Emit a JSON evidence record at ``docs/evidence/cpu_ap/pmu-event-alignment.json``.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BPU_PKG = ROOT / "rtl/cpu/bpu/bpu_pkg.sv"
ZIHPM_SV = ROOT / "rtl/cpu/csr/zihpm.sv"
REMAP_SV = ROOT / "rtl/cpu/csr/bpu_to_zihpm_remap.sv"
EVIDENCE = ROOT / "docs/evidence/cpu_ap/pmu-event-alignment.json"

# Aliases the remap module declares between BPU names and Zihpm names. The
# left side is the BPU enumerant; the right side is the Zihpm enumerant.
NAME_ALIASES = {
    "PMU_FTB_MISS": "EVT_BTB_MISS",
    "PMU_L2_FTB_HIT": "EVT_L2_BTB_HIT",
    "PMU_L2_FTB_MISS": "EVT_L2_BTB_MISS",
    "PMU_L2_FTB_LATE_REDIRECT": "EVT_L2_BTB_LATE_REDIRECT",
    "PMU_META_TRAIN": "EVT_BPU_META_TRAIN",
}


def parse_enum(path: Path, type_name: str, bit_width: int) -> dict[str, int]:
    text = path.read_text(encoding="utf-8")
    pat = r"typedef\s+enum\s+logic\s*\[[^\]]+\]\s*\{(.+?)\}\s*" + re.escape(type_name)
    match = re.search(pat, text, re.S)
    if not match:
        raise SystemExit(f"{path}: cannot find {type_name} enum")
    body = match.group(1)
    items: dict[str, int] = {}
    for line in body.splitlines():
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        m = re.match(rf"([A-Z][A-Z0-9_]+)\s*=\s*{bit_width}'d(\d+)", line)
        if m:
            name, val = m.group(1), int(m.group(2))
            if val in items.values():
                raise SystemExit(f"{path}: duplicate value {val} for {name}")
            items[name] = val
    return items


def parse_remap(path: Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    pairs: dict[str, str] = {}
    for m in re.finditer(
        r"zihpm_evbus_o\[(EVT_[A-Z0-9_]+)\]\s*=\s*bpu_strobes_i\[(PMU_[A-Z0-9_]+)\]",
        text,
    ):
        zihpm_name, bpu_name = m.group(1), m.group(2)
        if bpu_name in pairs:
            raise SystemExit(
                f"{path}: duplicate BPU source {bpu_name} (also drove {pairs[bpu_name]})"
            )
        pairs[bpu_name] = zihpm_name
    return pairs


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--print-only",
        "--no-write",
        action="store_true",
        dest="print_only",
        help="run the alignment check without rewriting the evidence JSON",
    )
    args = parser.parse_args(argv)

    bpu = parse_enum(BPU_PKG, "pmu_event_e", 5)
    zihpm = parse_enum(ZIHPM_SV, "hpm_event_e", 8)
    remap = parse_remap(REMAP_SV)

    errors: list[str] = []

    # Every BPU entry must appear as a remap key.
    for bpu_name in bpu:
        if bpu_name not in remap:
            errors.append(f"BPU enumerant {bpu_name} has no remap destination")
            continue
        # The remap destination must be the same name, modulo the
        # documented aliases.
        zihpm_name = remap[bpu_name]
        expected_zihpm = NAME_ALIASES.get(bpu_name, "EVT_" + bpu_name[len("PMU_") :])
        if zihpm_name != expected_zihpm:
            errors.append(f"remap mismatch: {bpu_name} -> {zihpm_name}, expected {expected_zihpm}")
        if zihpm_name not in zihpm:
            errors.append(
                f"remap destination {zihpm_name} (from {bpu_name}) not declared in hpm_event_e"
            )

    # Branch-block Zihpm entries (1..PMU_EVENTS) must all have a remap source.
    branch_block_zihpm = {
        name: val for name, val in zihpm.items() if 1 <= val <= len(bpu)
    }
    seen_zihpm_dests = set(remap.values())
    for zihpm_name in branch_block_zihpm:
        if zihpm_name not in seen_zihpm_dests:
            errors.append(f"branch-block Zihpm entry {zihpm_name} is not driven by the remap")

    # Remap destinations must all be in branch-block range to avoid
    # accidental aliasing into cache/memory event IDs.
    for bpu_name, zihpm_name in remap.items():
        v = zihpm.get(zihpm_name)
        if v is None or not (1 <= v <= len(bpu)):
            errors.append(
                f"remap target {zihpm_name}={v} for {bpu_name} is outside "
                f"the branch block 1..{len(bpu)}"
            )

    summary = {
        "schema": "eliza.cpu_pmu_event_alignment.v1",
        "generated_at": _dt.datetime.now(_dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "bpu_event_count": len(bpu),
        "zihpm_branch_block_count": len(branch_block_zihpm),
        "remap_pair_count": len(remap),
        "aliases": NAME_ALIASES,
        "errors": errors,
        "verdict": "ok" if not errors else "fail",
    }
    if not args.print_only:
        EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
        EVIDENCE.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")

    if errors:
        print("STATUS: FAIL cpu.pmu_event_alignment")
        for err in errors:
            print(f"  - {err}")
        return 1
    print(
        f"STATUS: PASS cpu.pmu_event_alignment - {len(bpu)} BPU events mapped to "
        f"{len(branch_block_zihpm)} Zihpm slots"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
