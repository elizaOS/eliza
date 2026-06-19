"""Parse lmbench bw_mem and lat_mem_rd. Auto-detects via 'stride='."""

from __future__ import annotations

import json
import re
import sys
from typing import Any

from . import ParseError

_BW_RE = re.compile(r"^\s*([0-9]+\.?[0-9]*)\s+([0-9]+\.?[0-9]*)\s*$", re.MULTILINE)
_STRIDE_RE = re.compile(r"stride[=\s]+([0-9]+)")


def parse_bw_mem(text: str) -> dict[str, Any]:
    last = None
    for m in _BW_RE.finditer(text):
        last = m
    if last is None:
        raise ParseError("lmbench bw_mem: no numeric '<size> <bandwidth>' line")
    return {
        "size_mb": float(last.group(1)),
        "bandwidth_mb_per_s": float(last.group(2)),
    }


def parse_lat_mem_rd(text: str) -> dict[str, Any]:
    stride_match = _STRIDE_RE.search(text)
    stride = int(stride_match.group(1)) if stride_match else None
    points: list[dict[str, float]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("stride") or line.startswith('"'):
            continue
        parts = line.split()
        if len(parts) != 2:
            continue
        try:
            size_mb = float(parts[0])
            latency_ns = float(parts[1])
        except ValueError:
            continue
        points.append({"size_mb": size_mb, "latency_ns": latency_ns})
    if not points:
        raise ParseError("lmbench lat_mem_rd: no numeric latency points")
    return {
        "stride": stride,
        "points": points,
        "max_latency_ns": max(p["latency_ns"] for p in points),
        "min_latency_ns": min(p["latency_ns"] for p in points),
    }


def parse(text: str) -> dict[str, Any]:
    if _STRIDE_RE.search(text):
        return parse_lat_mem_rd(text)
    return parse_bw_mem(text)


def main(argv: list[str]) -> int:
    if not argv or argv[0] == "-":
        data = sys.stdin.read()
    else:
        with open(argv[0], encoding="utf-8") as handle:
            data = handle.read()
    try:
        out = parse(data)
    except ParseError as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1
    json.dump(out, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
