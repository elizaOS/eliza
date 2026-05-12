"""Delta report for the Cerebras nightly benchmark workflow.

Walks a per-agent results directory, computes mean scores per suite/agent,
and emits a markdown summary plus a JSON snapshot. Best-effort: missing
files don't fail the report; they're listed as gaps.

Inputs:
  --suite     {lifeops,personality}
  --input     Path to the artifacts/<suite>/ dir containing per-agent
              subdirectories with result JSON.
  --output    Path to write the markdown report.
  --json-output  Path to write the JSON snapshot.

This script is intentionally stdlib-only (CI robustness). Per Phase 8 of
the cleanup roadmap.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def _load_results(agent_dir: Path) -> dict[str, Any]:
    """Find the most recent results JSON under the agent dir."""
    if not agent_dir.is_dir():
        return {}
    candidates = sorted(agent_dir.rglob("*.json"), key=lambda p: p.stat().st_mtime)
    if not candidates:
        return {}
    latest = candidates[-1]
    try:
        data = json.loads(latest.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    return {"path": str(latest), "data": data}


def _extract_score(payload: dict[str, Any]) -> float | None:
    """Pull a single numeric score from a results payload.

    Tries the canonical W0 schema keys first (mean_score, pass_at_1),
    falls back to common alternatives. Returns None when no score lands.
    """
    data = payload.get("data") if "data" in payload else payload
    if not isinstance(data, dict):
        return None
    for key in ("mean_score", "score", "pass_at_1", "passRate"):
        if key in data and isinstance(data[key], (int, float)):
            return float(data[key])
    if "summary" in data and isinstance(data["summary"], dict):
        for key in ("mean_score", "score", "pass_at_1"):
            if key in data["summary"] and isinstance(
                data["summary"][key], (int, float)
            ):
                return float(data["summary"][key])
    return None


def _format_score(score: float | None) -> str:
    return "n/a" if score is None else f"{score:.3f}"


def build_report(
    suite: str, input_dir: Path
) -> tuple[str, dict[str, dict[str, float | None]]]:
    agents: list[str] = []
    if suite == "lifeops":
        agents = ["eliza", "hermes", "openclaw"]
    elif suite == "personality":
        agents = ["eliza", "hermes", "openclaw", "eliza-runtime"]

    snapshot: dict[str, dict[str, float | None]] = {}
    rows: list[str] = []
    rows.append(f"### {suite}\n")
    rows.append("| Agent | Mean Score | Source |")
    rows.append("|---|---:|---|")

    for agent in agents:
        agent_dir = input_dir / agent
        payload = _load_results(agent_dir)
        score = _extract_score(payload) if payload else None
        source = payload.get("path", "—") if payload else "missing"
        rows.append(f"| {agent} | {_format_score(score)} | `{source}` |")
        snapshot[agent] = {"score": score, "source": source if payload else None}

    rows.append("")
    return "\n".join(rows), snapshot


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--suite", required=True, choices=["lifeops", "personality"])
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--json-output", type=Path, required=True)
    args = parser.parse_args(argv)

    if not args.input.exists():
        args.input.mkdir(parents=True, exist_ok=True)

    report, snapshot = build_report(args.suite, args.input)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(report)
    args.json_output.write_text(
        json.dumps({"suite": args.suite, "scores": snapshot}, indent=2)
    )
    print(report)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
