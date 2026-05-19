"""Host-side sanity check on rtl/cpu/csr/zihpm.sv event enum.

Confirms the OoO-domain contract event IDs are present in
``zihpm_pkg::hpm_event_e`` and that no two enumerants share an ID.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
ZIHPM = ROOT / "rtl/cpu/csr/zihpm.sv"

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


def main(argv: list[str] | None = None) -> int:
    events = parse_events()
    missing = [event for event in REQUIRED_EVENTS if event not in events]
    if missing:
        print(f"STATUS: FAIL zihpm.required_events missing: {missing}")
        return 1
    if events.get("EVT_NONE") != 0:
        print("STATUS: FAIL zihpm.events EVT_NONE must equal 0")
        return 1
    print(f"STATUS: PASS zihpm.required_events - {len(events)} events enumerated")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main(sys.argv[1:]))
