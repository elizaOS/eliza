#!/usr/bin/env python3
"""Run ScamBench decisions through the Hermes agent runtime."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
PYTHON_ROOT = SCRIPT_DIR.parent

sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(PYTHON_ROOT))
sys.path.insert(0, str(PYTHON_ROOT / "src" / "training"))

import run_scambench_local as scambench_local
from hermes_bridge import HermesBridgeClient

WORKSPACE_ROOT = Path(__file__).resolve().parents[5]


def resolve_scambench_root(workspace_root: Path) -> Path:
    candidates = [
        workspace_root / "scambench",
        workspace_root / "benchmarks" / "scambench",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


SCAMBENCH_ROOT = resolve_scambench_root(WORKSPACE_ROOT)


def stage_key(scenario_id: str, stage_id: str) -> str:
    return f"{scenario_id}::{stage_id}"


def load_existing_decisions(output_path: Path) -> dict[str, dict[str, Any]]:
    if not output_path.exists():
        return {}
    payload = json.loads(output_path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise ValueError(f"Expected a JSON list in {output_path}")

    decisions: dict[str, dict[str, Any]] = {}
    for item in payload:
        if not isinstance(item, dict):
            continue
        scenario_id = item.get("scenarioId")
        stage_id = item.get("stageId")
        if isinstance(scenario_id, str) and isinstance(stage_id, str):
            decisions[stage_key(scenario_id, stage_id)] = item
    return decisions


def ordered_decisions(
    scenarios: list[dict[str, Any]],
    decisions_by_key: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    ordered: list[dict[str, Any]] = []
    for scenario in scenarios:
        scenario_id = str(scenario["id"])
        for stage in scenario["stages"]:
            decision = decisions_by_key.get(stage_key(scenario_id, str(stage["id"])))
            if decision is not None:
                ordered.append(decision)
    return ordered


def persist_decisions(
    output_path: Path,
    scenarios: list[dict[str, Any]],
    decisions_by_key: dict[str, dict[str, Any]],
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(ordered_decisions(scenarios, decisions_by_key), indent=2),
        encoding="utf-8",
    )


def filter_scenarios(
    scenarios: list[dict[str, Any]],
    *,
    allowed_ids: set[str] | None,
    limit: int | None,
) -> list[dict[str, Any]]:
    filtered = [
        scenario for scenario in scenarios if allowed_ids is None or scenario["id"] in allowed_ids
    ]
    if limit is not None:
        return filtered[:limit]
    return filtered


def append_decision_to_transcript(
    transcript: list[dict[str, Any]],
    *,
    label: str,
    channel: str,
    decision: dict[str, Any],
) -> None:
    transcript.append(
        {
            "role": "assistant",
            "speaker": label,
            "content": decision["responseText"],
            "channel": channel,
            "tags": ["target-response", decision["chosenAction"]],
            "isAttack": False,
        }
    )


def score_decisions(output_path: Path, output_dir: Path, target_repo: Path | None) -> None:
    command = [
        "bun",
        "run",
        "src/index.ts",
        "--decisions",
        str(output_path),
        "--output-dir",
        str(output_dir),
    ]
    if target_repo is not None:
        command.extend(["--target-repo", str(target_repo)])
    subprocess.run(
        command,
        cwd=SCAMBENCH_ROOT,
        check=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run ScamBench through Hermes against an OpenAI-compatible endpoint."
    )
    parser.add_argument("--model", required=True, help="Served model id for Hermes.")
    parser.add_argument("--base-url", required=True, help="OpenAI-compatible base URL.")
    parser.add_argument(
        "--api-key", default="benchmark-local", help="API key for the served endpoint."
    )
    parser.add_argument("--label", required=True, help="Label for the decision set.")
    parser.add_argument("--output", required=True, help="Path to write decisions.json.")
    parser.add_argument(
        "--scenario-catalog",
        default=str(scambench_local.DEFAULT_CATALOG_PATH),
        help="Path to the ScamBench scenario catalog JSON.",
    )
    parser.add_argument(
        "--max-iterations", type=int, default=4, help="Hermes agent loop budget per stage."
    )
    parser.add_argument("--hermes-root", default=None, help="Optional Hermes repo root override.")
    parser.add_argument(
        "--scenario-id",
        action="append",
        default=None,
        help="Optional scenario id filter. Repeat to run multiple scenarios.",
    )
    parser.add_argument(
        "--limit-scenarios", type=int, default=None, help="Optional max scenario count."
    )
    parser.add_argument(
        "--resume",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Resume from an existing decisions file if present.",
    )
    parser.add_argument(
        "--persistent-bridge",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Keep the Hermes bridge subprocess alive across stages.",
    )
    parser.add_argument(
        "--rebuild-agent-per-request",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Recreate the Hermes agent inside the bridge for each stage.",
    )
    parser.add_argument(
        "--score-output-dir",
        default=None,
        help="Optional ScamBench score output directory. When set, the recorded decisions are scored after generation.",
    )
    parser.add_argument(
        "--target-repo",
        default=None,
        help="Optional repo path for ScamBench research-profile generation during scoring.",
    )
    args = parser.parse_args()

    output_path = Path(args.output).resolve()
    allowed_ids = set(args.scenario_id) if args.scenario_id else None
    all_scenarios = scambench_local.build_scenarios(args.scenario_catalog)
    scenarios = filter_scenarios(
        all_scenarios,
        allowed_ids=allowed_ids,
        limit=args.limit_scenarios,
    )
    if not scenarios:
        raise ValueError("No scenarios selected for Hermes ScamBench run")

    decisions_by_key = load_existing_decisions(output_path) if args.resume else {}

    with HermesBridgeClient(
        model=args.model,
        base_url=args.base_url,
        api_key=args.api_key,
        max_iterations=args.max_iterations,
        hermes_root=args.hermes_root,
        persistent=args.persistent_bridge,
        rebuild_agent_per_request=args.rebuild_agent_per_request,
    ) as client:
        for scenario in scenarios:
            transcript = list(scenario.get("preamble") or [])
            for stage in scenario["stages"]:
                key = stage_key(str(scenario["id"]), str(stage["id"]))
                transcript.extend(scambench_local.resolve_stage_messages(stage))
                existing = decisions_by_key.get(key)
                if existing is not None:
                    append_decision_to_transcript(
                        transcript,
                        label=args.label,
                        channel=stage["channel"],
                        decision=existing,
                    )
                    if scenario.get("stopOnLeak") and existing.get("leakedSecret"):
                        break
                    continue

                raw = client.complete(
                    system_message=scambench_local.SYSTEM_PROMPT,
                    user_message=scambench_local.build_target_user_prompt(
                        scenario=scenario,
                        stage=stage,
                        transcript=transcript,
                    ),
                )
                decision = scambench_local.normalize_decision(raw, stage["id"], stage)
                decisions_by_key[key] = {
                    "scenarioId": scenario["id"],
                    **decision,
                    "rawResponse": raw,
                }
                persist_decisions(output_path, scenarios, decisions_by_key)
                append_decision_to_transcript(
                    transcript,
                    label=args.label,
                    channel=stage["channel"],
                    decision=decision,
                )

                if scenario.get("stopOnLeak") and decision["leakedSecret"]:
                    break

    ordered = ordered_decisions(scenarios, decisions_by_key)
    persist_decisions(output_path, scenarios, decisions_by_key)
    print(f"Wrote {len(ordered)} Hermes stage decisions for {args.label} to {output_path}")

    if args.score_output_dir:
        score_output_dir = Path(args.score_output_dir).resolve()
        target_repo = Path(args.target_repo).resolve() if args.target_repo else None
        if len(scenarios) != len(all_scenarios):
            print(
                "Skipping score pass because this run only covers a filtered scenario subset. "
                f"Wrote decisions to {output_path}."
            )
        else:
            score_decisions(output_path, score_output_dir, target_repo)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
