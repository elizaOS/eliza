"""Parse STREAM stdout. Required: triad_mb_per_s."""

from __future__ import annotations

import json
import re
import sys
from typing import Any

from . import ParseError

_LINE_RE = re.compile(
    r"^\s*(Copy|Scale|Add|Triad):\s*"
    r"([0-9]+\.?[0-9]*)\s+"
    r"([0-9]+\.?[0-9]*)\s+"
    r"([0-9]+\.?[0-9]*)\s+"
    r"([0-9]+\.?[0-9]*)",
    re.MULTILINE,
)


def parse(text: str) -> dict[str, Any]:
    metrics: dict[str, Any] = {}
    for m in _LINE_RE.finditer(text):
        name = m.group(1).lower()
        metrics[f"{name}_mb_per_s"] = float(m.group(2))
        metrics[f"{name}_min_time_s"] = float(m.group(4))
        metrics[f"{name}_max_time_s"] = float(m.group(5))
    if "triad_mb_per_s" not in metrics:
        raise ParseError("stream: missing Triad rate line")
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
