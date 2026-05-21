#!/usr/bin/env python3
"""Normalize STA `report_checks` output into `eliza.pd_timing_path.v1`.

This is the tool-AGNOSTIC canonical timing-path schema. OpenSTA's textual
`report_checks` report is the source today; a future PrimeTime/Tempus
importer (scripts/check_signoff_handoff.py --import-back) targets the SAME
schema so paths from any tool are comparable.

A normalized path captures:
  - startpoint / endpoint (port or instance pin)
  - path_group, path_type (max=setup, min=hold)
  - data arrival / required time, slack, met flag
  - per-stage pin/net/cell rows (cell, transition, delay, time)

We parse only what the report states. We never synthesize delays or slack.
If a report block is malformed we skip it and record a parse warning rather
than guess values.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = "eliza.pd_timing_path.v1"

_STARTPOINT_RE = re.compile(r"^Startpoint:\s+(?P<value>.+?)\s*$")
_ENDPOINT_RE = re.compile(r"^Endpoint:\s+(?P<value>.+?)\s*$")
_PATH_GROUP_RE = re.compile(r"^Path Group:\s+(?P<value>.+?)\s*$")
_PATH_TYPE_RE = re.compile(r"^Path Type:\s+(?P<value>min|max)\s*$")
_SLACK_RE = re.compile(r"^\s*(?P<slack>-?\d+(?:\.\d+)?)\s+slack\s+\((?P<met>MET|VIOLATED)\)")
_ARRIVAL_RE = re.compile(r"^\s*(?P<value>-?\d+(?:\.\d+)?)\s+data arrival time\s*$")
_REQUIRED_RE = re.compile(r"^\s*(?P<value>-?\d+(?:\.\d+)?)\s+data required time\s*$")

# A stage row in the report has a trailing description like:
#   "<slew> <delay> <time> <edge> <pin> (<cell>)"  e.g.
#   "0.339657    0.380477    4.512119 ^ _26_/Y (sky130_fd_sc_hd__nor4b_1)"
# We anchor on the (cell) at the end and the edge (^ or v) before the pin.
# Port/net markers (in)/(out)/(net) are NOT cells and are excluded.
_NON_CELL_MARKERS = frozenset({"in", "out", "net"})
_STAGE_RE = re.compile(
    r"(?P<delay>-?\d+\.\d+)\s+(?P<time>-?\d+\.\d+)\s+"
    r"(?P<edge>[v^])\s+(?P<pin>\S+)\s+\((?P<cell>[^)]+)\)\s*$"
)


@dataclass(frozen=True)
class PathStage:
    pin: str
    cell: str
    edge: str  # "rise" | "fall"
    delay: float
    time: float


@dataclass
class TimingPath:
    startpoint: str
    endpoint: str
    path_group: str
    path_type: str  # "max" (setup) | "min" (hold)
    slack: float
    met: bool
    arrival: float | None
    required: float | None
    stages: list[PathStage] = field(default_factory=list)


def _edge_word(symbol: str) -> str:
    return "rise" if symbol == "^" else "fall"


def _split_blocks(text: str) -> list[list[str]]:
    """Split a report into per-path line blocks.

    A new block starts at each "Startpoint:" line. Lines before the first
    Startpoint (headers) are discarded.
    """
    blocks: list[list[str]] = []
    current: list[str] | None = None
    for raw in text.splitlines():
        if _STARTPOINT_RE.match(raw.strip()):
            if current is not None:
                blocks.append(current)
            current = [raw]
        elif current is not None:
            current.append(raw)
    if current is not None:
        blocks.append(current)
    return blocks


def _parse_block(lines: list[str], warnings: list[str]) -> TimingPath | None:
    startpoint: str | None = None
    endpoint: str | None = None
    path_group = ""
    path_type: str | None = None
    slack: float | None = None
    met: bool | None = None
    arrival: float | None = None
    required: float | None = None
    stages: list[PathStage] = []

    for raw in lines:
        stripped = raw.strip()
        m = _STARTPOINT_RE.match(stripped)
        if m:
            startpoint = m.group("value")
            continue
        m = _ENDPOINT_RE.match(stripped)
        if m:
            endpoint = m.group("value")
            continue
        m = _PATH_GROUP_RE.match(stripped)
        if m:
            path_group = m.group("value")
            continue
        m = _PATH_TYPE_RE.match(stripped)
        if m:
            path_type = m.group("value")
            continue
        m = _SLACK_RE.match(raw)
        if m:
            slack = float(m.group("slack"))
            met = m.group("met") == "MET"
            continue
        m = _ARRIVAL_RE.match(raw)
        if m and arrival is None:
            # The first "data arrival time" is the path's own arrival; the
            # value repeated (negated) in the slack summary is ignored.
            arrival = float(m.group("value"))
            continue
        m = _REQUIRED_RE.match(raw)
        if m and required is None:
            required = float(m.group("value"))
            continue
        m = _STAGE_RE.search(raw)
        if m and m.group("cell") not in _NON_CELL_MARKERS:
            stages.append(
                PathStage(
                    pin=m.group("pin"),
                    cell=m.group("cell"),
                    edge=_edge_word(m.group("edge")),
                    delay=float(m.group("delay")),
                    time=float(m.group("time")),
                )
            )

    if startpoint is None or endpoint is None or slack is None or met is None:
        warnings.append(
            "skipped a path block missing startpoint/endpoint/slack "
            f"(startpoint={startpoint!r}, endpoint={endpoint!r})"
        )
        return None
    if path_type is None:
        # report_checks always emits Path Type; if absent the block is
        # malformed and we do not guess setup vs hold.
        warnings.append(f"skipped path {startpoint}->{endpoint}: missing Path Type")
        return None

    return TimingPath(
        startpoint=startpoint,
        endpoint=endpoint,
        path_group=path_group,
        path_type=path_type,
        slack=slack,
        met=met,
        arrival=arrival,
        required=required,
        stages=stages,
    )


def parse_report(text: str) -> tuple[list[TimingPath], list[str]]:
    warnings: list[str] = []
    paths: list[TimingPath] = []
    for block in _split_blocks(text):
        parsed = _parse_block(block, warnings)
        if parsed is not None:
            paths.append(parsed)
    return paths, warnings


def to_dict(
    paths: list[TimingPath],
    *,
    source_tool: str,
    source_report: str,
    scenario: str | None,
    warnings: list[str],
) -> dict[str, Any]:
    return {
        "schema": SCHEMA,
        "source_tool": source_tool,
        "source_report": source_report,
        "scenario": scenario,
        "path_count": len(paths),
        "parse_warnings": warnings,
        "paths": [
            {
                "startpoint": p.startpoint,
                "endpoint": p.endpoint,
                "path_group": p.path_group,
                "path_type": p.path_type,
                "slack": p.slack,
                "met": p.met,
                "arrival": p.arrival,
                "required": p.required,
                "stages": [asdict(s) for s in p.stages],
            }
            for p in paths
        ],
    }


def normalize_file(
    report_path: Path,
    *,
    source_tool: str = "opensta",
    scenario: str | None = None,
) -> dict[str, Any]:
    if not report_path.is_file():
        raise FileNotFoundError(f"report not found: {report_path}")
    paths, warnings = parse_report(report_path.read_text())
    return to_dict(
        paths,
        source_tool=source_tool,
        source_report=str(report_path),
        scenario=scenario,
        warnings=warnings,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", required=True, help="report_checks text output")
    parser.add_argument("--out", help="write normalized JSON here (default: stdout)")
    parser.add_argument("--source-tool", default="opensta")
    parser.add_argument("--scenario", help="scenario name this report belongs to")
    args = parser.parse_args()

    report_path = Path(args.report)
    if not report_path.is_absolute():
        report_path = (ROOT / args.report).resolve()
    try:
        payload = normalize_file(
            report_path, source_tool=args.source_tool, scenario=args.scenario
        )
    except FileNotFoundError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1

    text = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    if args.out:
        out_path = Path(args.out)
        if not out_path.is_absolute():
            out_path = (ROOT / args.out).resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text)
        print(f"PASS: {payload['path_count']} timing paths normalized: {out_path}")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
