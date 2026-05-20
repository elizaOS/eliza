#!/usr/bin/env python3
"""Summarize DFlash native smoke/bench evidence for a staged Eliza-1 bundle.

This does not run a model. It reads the already-produced DFlash sidecars and
raw llama.cpp logs, then emits a small operator report that distinguishes:

* structural/runtime loadability,
* native draft acceptance,
* release-bench speedup evidence,
* and whether the bundle is still optimization-blocked.
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def _number(pattern: str, text: str) -> float | None:
    match = re.search(pattern, text, flags=re.IGNORECASE)
    return float(match.group(1)) if match else None


def _int(pattern: str, text: str) -> int | None:
    value = _number(pattern, text)
    return int(value) if value is not None else None


def _parse_raw_log(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8", errors="replace")
    drafted = _int(r"n_drafted\s*[:=]\s*(\d+)", text)
    accepted = _int(r"n_accept(?:ed)?\s*[:=]\s*(\d+)", text)
    decoded_tps = _number(
        r"decoded\s+\d+\s+tokens\s+in\s+[\d.]+\s+seconds,\s+speed:\s+([\d.]+)\s+t/s",
        text,
    )
    return {
        "path": str(path),
        "speculator": (
            "dflash"
            if "adding speculative implementation 'dflash'" in text
            else "draft-simple"
            if "adding speculative implementation 'draft-simple'" in text
            else None
        ),
        "status": "complete" if "common_perf_print" in text else "incomplete",
        "drafted": drafted,
        "accepted": accepted,
        "acceptanceRate": (
            accepted / drafted
            if isinstance(drafted, int) and drafted > 0 and isinstance(accepted, int)
            else None
        ),
        "decodedTokensPerSecond": decoded_tps,
    }


def build_report(bundle: Path) -> dict[str, Any]:
    target_meta = _read_json(bundle / "dflash" / "target-meta.json")
    runtime = _read_json(bundle / "dflash" / "runtime-smoke-native.json")
    bench = _read_json(bundle / "evals" / "dflash-native-bench.json")
    accept = _read_json(bundle / "evals" / "dflash-accept.json")
    raw_dir = bundle / "evals" / "raw"
    raw_logs = (
        [_parse_raw_log(path) for path in sorted(raw_dir.glob("dflash-*.log"))]
        if raw_dir.is_dir()
        else []
    )

    runtime_run = {}
    runtime_runs = runtime.get("runtime")
    if isinstance(runtime_runs, list) and runtime_runs:
        first = runtime_runs[0]
        runtime_run = first if isinstance(first, dict) else {}
    runtime_dflash = runtime_run.get("dflash")
    runtime_dflash = runtime_dflash if isinstance(runtime_dflash, dict) else {}
    runtime_bench = runtime.get("bench")
    runtime_bench = runtime_bench if isinstance(runtime_bench, dict) else {}

    gate = None
    rollout = target_meta.get("acceptanceRollout")
    if isinstance(rollout, dict):
        gate = rollout.get("gate")
    if not isinstance(gate, (int, float)):
        gate = accept.get("gateThreshold")
    if not isinstance(gate, (int, float)):
        gate = 0.4

    accepted_smoke = (
        runtime.get("metadataStatus") == "metadata_loadable"
        and runtime_dflash.get("draftingActive") is True
        and isinstance(runtime_dflash.get("accepted"), int)
        and runtime_dflash["accepted"] > 0
    )
    bench_rate = bench.get("acceptanceRate")
    bench_speedup = bench.get("speedup")
    bench_publishable = (
        bench.get("status") == "pass"
        and isinstance(bench_rate, (int, float))
        and bench_rate >= gate
        and isinstance(bench_speedup, (int, float))
        and bench_speedup > 1.0
    )
    status = "publishable" if target_meta.get("publishEligible") is True and bench_publishable else "optimization-blocked"
    blockers: list[str] = []
    if target_meta.get("targetText", {}).get("path") and "256k" not in str(
        target_meta["targetText"]["path"]
    ):
        blockers.append("target-meta targetText.path is not the native 256k target")
    if target_meta.get("drafter", {}).get("matchesTargetCheckpoint") is not True:
        blockers.append("drafter does not prove matchesTargetCheckpoint=true")
    if not accepted_smoke:
        blockers.append("native runtime smoke did not prove accepted DFlash drafts")
    if not bench_publishable:
        blockers.append("native release bench did not prove acceptance plus speedup > 1.0")

    return {
        "schemaVersion": 1,
        "kind": "dflash-tuning-report",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "bundle": str(bundle),
        "tier": target_meta.get("tier"),
        "status": status,
        "publishEligible": target_meta.get("publishEligible"),
        "acceptanceGate": gate,
        "target": target_meta.get("targetText"),
        "drafter": target_meta.get("drafter"),
        "runtimeSmoke": {
            "metadataStatus": runtime.get("metadataStatus"),
            "metadataFailures": runtime.get("metadataFailures"),
            "drafted": runtime_dflash.get("drafted"),
            "accepted": runtime_dflash.get("accepted"),
            "acceptanceRate": runtime_dflash.get("acceptanceRate"),
            "draftingActive": runtime_dflash.get("draftingActive"),
            "failure": runtime_run.get("dflashFailure"),
        },
        "releaseBench": {
            "status": bench.get("status") or runtime_bench.get("status"),
            "failure": bench.get("failure") or runtime_bench.get("failure"),
            "acceptanceRate": bench_rate,
            "speedup": bench_speedup,
            "drafted": bench.get("drafted"),
            "accepted": bench.get("accepted"),
        },
        "acceptanceReport": accept,
        "rawLogs": raw_logs,
        "blockers": blockers,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    report = build_report(args.bundle)
    text = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
    else:
        print(text, end="")
    return 0 if report["status"] == "publishable" else 2


if __name__ == "__main__":
    raise SystemExit(main())
