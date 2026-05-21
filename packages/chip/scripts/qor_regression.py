#!/usr/bin/env python3
"""QoR regression store for the synth->backend loop.

Persists one QoR row per (design, node_id, run_id, git_sha) into an append-only
JSONL store under build/qor/qor_regression.jsonl. Rows carry the post-route PPA
metric columns declared by the post-route-ppa validator
(docs/evidence/pd/post-route-ppa-validator.yaml -> required_metric_keys) so a
regression gate can compare any run against a named baseline.

This module is both a library (record_row / load_rows / latest_baseline) and a
CLI:

  scripts/qor_regression.py record \
      --design e1_chip_top --node-id sky130 --run-id <id> \
      --metrics-json <path/to/final/metrics.json> \
      [--source <provenance>] [--baseline] [--git-sha <sha>]

  scripts/qor_regression.py list [--design ...] [--node-id ...]

A "row" is fail-closed: a record is rejected unless every required metric key is
present and numeric in the source metrics.json. Advanced-node rows are accepted
only when carried as explicit BLOCKED placeholders (release_use_allowed=false,
metrics absent) via `record-blocked`; they never claim QoR numbers.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
STORE_DIR = ROOT / "build" / "qor"
STORE_PATH = STORE_DIR / "qor_regression.jsonl"
VALIDATOR = ROOT / "docs" / "evidence" / "pd" / "post-route-ppa-validator.yaml"

SCHEMA = "eliza.qor.v1"

# Advanced nodes whose physically-aware closure stays blocked: a real QoR row
# may never be recorded for these (commercial-eda-gate / NDA / PDK access).
OPEN_PDK_NODE_IDS = {"sky130", "gf180", "ihp-sg13g2", "asap7"}
BLOCKED_NODE_IDS = {"tsmc-n2p", "tsmc-a14", "intel-14a", "samsung-sf2p"}


def required_metric_keys() -> list[str]:
    """Single source of truth: the post-route PPA validator's columns."""
    if not VALIDATOR.is_file():
        raise FileNotFoundError(
            f"post-route PPA validator missing: {VALIDATOR.relative_to(ROOT)}"
        )
    payload = yaml.safe_load(VALIDATOR.read_text())
    keys = payload.get("required_metric_keys") if isinstance(payload, dict) else None
    if not isinstance(keys, list) or not keys:
        raise ValueError(
            f"{VALIDATOR.relative_to(ROOT)} has no required_metric_keys list"
        )
    return [str(k) for k in keys]


@dataclass
class QorRow:
    schema: str
    design: str
    node_id: str
    run_id: str
    git_sha: str
    recorded_at: str
    status: str  # "captured" | "blocked"
    release_use_allowed: bool
    source: str | None
    metrics: dict[str, float]
    extra: dict[str, Any] = field(default_factory=dict)

    def key(self) -> tuple[str, str, str, str]:
        return (self.design, self.node_id, self.run_id, self.git_sha)


def git_sha() -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        sha = out.stdout.strip()
        return sha or "unknown"
    except OSError:
        return "unknown"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_rows(store_path: Path = STORE_PATH) -> list[QorRow]:
    if not store_path.is_file():
        return []
    rows: list[QorRow] = []
    for line in store_path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        raw = json.loads(line)
        rows.append(
            QorRow(
                schema=raw["schema"],
                design=raw["design"],
                node_id=raw["node_id"],
                run_id=raw["run_id"],
                git_sha=raw["git_sha"],
                recorded_at=raw["recorded_at"],
                status=raw["status"],
                release_use_allowed=bool(raw.get("release_use_allowed", False)),
                source=raw.get("source"),
                metrics={k: float(v) for k, v in (raw.get("metrics") or {}).items()},
                extra=raw.get("extra") or {},
            )
        )
    return rows


def append_row(row: QorRow, store_path: Path = STORE_PATH) -> None:
    store_path.parent.mkdir(parents=True, exist_ok=True)
    with store_path.open("a") as fh:
        fh.write(json.dumps(asdict(row), sort_keys=True) + "\n")


def filter_rows(
    rows: list[QorRow],
    *,
    design: str | None = None,
    node_id: str | None = None,
    status: str | None = None,
) -> list[QorRow]:
    out = rows
    if design is not None:
        out = [r for r in out if r.design == design]
    if node_id is not None:
        out = [r for r in out if r.node_id == node_id]
    if status is not None:
        out = [r for r in out if r.status == status]
    return out


def latest_baseline(
    rows: list[QorRow], design: str, node_id: str
) -> QorRow | None:
    """Most recently recorded captured row flagged as a baseline."""
    candidates = [
        r
        for r in filter_rows(rows, design=design, node_id=node_id, status="captured")
        if r.extra.get("baseline") is True
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda r: r.recorded_at)


def collect_metrics(metrics_json: Path, keys: list[str]) -> dict[str, float]:
    """Extract the required metric columns; fail closed on any miss."""
    raw = json.loads(metrics_json.read_text())
    if not isinstance(raw, dict):
        raise ValueError(f"{metrics_json} is not a JSON object")
    out: dict[str, float] = {}
    missing: list[str] = []
    for key in keys:
        value = raw.get(key)
        if value is None or not isinstance(value, (int, float)) or isinstance(value, bool):
            missing.append(key)
            continue
        out[key] = float(value)
    if missing:
        raise ValueError(
            f"metrics.json missing/non-numeric required keys: {', '.join(sorted(missing))}"
        )
    return out


def make_row(
    *,
    design: str,
    node_id: str,
    run_id: str,
    metrics: dict[str, float],
    source: str | None,
    baseline: bool,
    sha: str | None = None,
    extra: dict[str, Any] | None = None,
) -> QorRow:
    base_extra = dict(extra or {})
    if baseline:
        base_extra["baseline"] = True
    return QorRow(
        schema=SCHEMA,
        design=design,
        node_id=node_id,
        run_id=run_id,
        git_sha=sha or git_sha(),
        recorded_at=_now(),
        status="captured",
        release_use_allowed=False,
        source=source,
        metrics=metrics,
        extra=base_extra,
    )


def make_blocked_row(
    *,
    design: str,
    node_id: str,
    run_id: str,
    reason: str,
    proving_command: str,
    sha: str | None = None,
) -> QorRow:
    return QorRow(
        schema=SCHEMA,
        design=design,
        node_id=node_id,
        run_id=run_id,
        git_sha=sha or git_sha(),
        recorded_at=_now(),
        status="blocked",
        release_use_allowed=False,
        source=None,
        metrics={},
        extra={"blocked_reason": reason, "proving_command": proving_command},
    )


def fail(message: str, **context: Any) -> int:
    payload = {"error": message, **context}
    print(f"FAIL: {message}", file=sys.stderr)
    json.dump(payload, sys.stderr, indent=2, sort_keys=True)
    sys.stderr.write("\n")
    return 1


def cmd_record(args: argparse.Namespace) -> int:
    if args.node_id in BLOCKED_NODE_IDS:
        return fail(
            "advanced-node QoR capture is blocked",
            node_id=args.node_id,
            remedy="use `record-blocked` to log a fail-closed placeholder",
        )
    if args.node_id not in OPEN_PDK_NODE_IDS:
        return fail("unknown node_id", node_id=args.node_id, open=sorted(OPEN_PDK_NODE_IDS))
    metrics_path = Path(args.metrics_json)
    if not metrics_path.is_absolute():
        metrics_path = (ROOT / args.metrics_json).resolve()
    if not metrics_path.is_file():
        return fail("metrics.json missing", metrics_json=str(metrics_path))
    keys = required_metric_keys()
    try:
        metrics = collect_metrics(metrics_path, keys)
    except ValueError as exc:
        return fail(str(exc), metrics_json=str(metrics_path))
    row = make_row(
        design=args.design,
        node_id=args.node_id,
        run_id=args.run_id,
        metrics=metrics,
        source=args.source,
        baseline=args.baseline,
        sha=args.git_sha,
    )
    append_row(row)
    print(
        f"PASS: recorded QoR row design={row.design} node_id={row.node_id} "
        f"run_id={row.run_id} git_sha={row.git_sha} baseline={args.baseline}"
    )
    return 0


def cmd_record_blocked(args: argparse.Namespace) -> int:
    row = make_blocked_row(
        design=args.design,
        node_id=args.node_id,
        run_id=args.run_id,
        reason=args.reason,
        proving_command=args.proving_command,
        sha=args.git_sha,
    )
    append_row(row)
    print(
        f"BLOCK: recorded fail-closed QoR placeholder design={row.design} "
        f"node_id={row.node_id} run_id={row.run_id} reason={args.reason}"
    )
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    rows = filter_rows(load_rows(), design=args.design, node_id=args.node_id)
    print(json.dumps([asdict(r) for r in rows], indent=2, sort_keys=True))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    record = sub.add_parser("record", help="Record a captured QoR row")
    record.add_argument("--design", required=True)
    record.add_argument("--node-id", required=True)
    record.add_argument("--run-id", required=True)
    record.add_argument("--metrics-json", required=True)
    record.add_argument("--source", default=None)
    record.add_argument("--baseline", action="store_true")
    record.add_argument("--git-sha", default=None)
    record.set_defaults(func=cmd_record)

    blocked = sub.add_parser(
        "record-blocked", help="Record a fail-closed BLOCKED placeholder row"
    )
    blocked.add_argument("--design", required=True)
    blocked.add_argument("--node-id", required=True)
    blocked.add_argument("--run-id", required=True)
    blocked.add_argument("--reason", required=True)
    blocked.add_argument("--proving-command", required=True)
    blocked.add_argument("--git-sha", default=None)
    blocked.set_defaults(func=cmd_record_blocked)

    listing = sub.add_parser("list", help="Dump matching rows as JSON")
    listing.add_argument("--design", default=None)
    listing.add_argument("--node-id", default=None)
    listing.set_defaults(func=cmd_list)

    return parser.parse_args()


def main() -> int:
    args = parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
