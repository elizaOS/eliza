"""Parse fio JSON output (fio --output-format=json)."""

from __future__ import annotations

import json
import sys
from typing import Any

from . import ParseError


def parse(text: str) -> dict[str, Any]:
    text = text.strip()
    if not text.startswith("{"):
        idx = text.find("{")
        if idx < 0:
            raise ParseError("fio: output is not JSON")
        text = text[idx:]
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ParseError(f"fio: invalid JSON: {exc}") from exc

    jobs = data.get("jobs") or []
    if not jobs:
        raise ParseError("fio: report has zero jobs")

    total: dict[str, Any] = {
        "read_iops": 0.0,
        "write_iops": 0.0,
        "read_bw_kib_s": 0.0,
        "write_bw_kib_s": 0.0,
    }
    read_clat: list[float] = []
    write_clat: list[float] = []
    job_summaries: list[dict[str, Any]] = []
    for job in jobs:
        r = job.get("read") or {}
        w = job.get("write") or {}
        total["read_iops"] += float(r.get("iops") or 0.0)
        total["write_iops"] += float(w.get("iops") or 0.0)
        total["read_bw_kib_s"] += float(r.get("bw") or 0.0)
        total["write_bw_kib_s"] += float(w.get("bw") or 0.0)
        if r.get("clat_ns", {}).get("mean") is not None:
            read_clat.append(float(r["clat_ns"]["mean"]))
        if w.get("clat_ns", {}).get("mean") is not None:
            write_clat.append(float(w["clat_ns"]["mean"]))
        job_summaries.append(
            {
                "jobname": job.get("jobname"),
                "read_iops": float(r.get("iops") or 0.0),
                "write_iops": float(w.get("iops") or 0.0),
                "read_bw_kib_s": float(r.get("bw") or 0.0),
                "write_bw_kib_s": float(w.get("bw") or 0.0),
            }
        )

    if not any(
        total[k] > 0 for k in ("read_iops", "write_iops", "read_bw_kib_s", "write_bw_kib_s")
    ):
        raise ParseError("fio: every job reported zero IOPS and zero bandwidth")

    if read_clat:
        total["read_clat_ns_mean"] = sum(read_clat) / len(read_clat)
    if write_clat:
        total["write_clat_ns_mean"] = sum(write_clat) / len(write_clat)
    total["jobs"] = job_summaries
    return total


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
