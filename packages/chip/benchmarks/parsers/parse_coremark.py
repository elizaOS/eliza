"""Parse CoreMark stdout into the coremark_v1 metric block."""

from __future__ import annotations

import json
import re
import sys
from typing import Any

from . import ParseError

_ITER_SEC_RE = re.compile(r"Iterations/Sec\s*:\s*([0-9]+\.?[0-9]*)")
_COREMARK_MHZ_RE = re.compile(r"CoreMark\s*/\s*MHz\s*:\s*([0-9]+\.?[0-9]*)")
_ITER_RE = re.compile(r"\bIterations\s*:\s*([0-9]+)")
_TOTAL_TICKS_RE = re.compile(r"Total\s+ticks\s*:\s*([0-9]+)")
_TOTAL_TIME_RE = re.compile(r"Total\s+time\s*\(secs?\)\s*:\s*([0-9]+\.?[0-9]*)")


def parse(text: str) -> dict[str, Any]:
    m = _ITER_SEC_RE.search(text)
    if not m:
        raise ParseError("coremark: missing 'Iterations/Sec' line")
    metrics: dict[str, Any] = {"iterations_per_second": float(m.group(1))}
    cm = _COREMARK_MHZ_RE.search(text)
    if cm:
        metrics["coremark_per_mhz"] = float(cm.group(1))
    it = _ITER_RE.search(text)
    if it:
        metrics["iterations"] = int(it.group(1))
    tt = _TOTAL_TICKS_RE.search(text)
    if tt:
        metrics["total_ticks"] = int(tt.group(1))
    ts = _TOTAL_TIME_RE.search(text)
    if ts:
        metrics["total_time_sec"] = float(ts.group(1))
    return metrics


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
