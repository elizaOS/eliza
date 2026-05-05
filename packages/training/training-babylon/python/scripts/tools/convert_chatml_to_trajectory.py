#!/usr/bin/env python3
"""
Convert ChatML training data to trajectory JSONL format for train_local.py / Nebius pipeline.

Reads train.jsonl + valid.jsonl (ChatML format) and wraps each into trajectory format:
  {"trajectory": {"trajectoryId": ..., "steps": [{"llmCalls": [{"systemPrompt": ..., "userPrompt": ..., "response": ...}]}], ...}}

Usage:
  python3 convert_chatml_to_trajectory.py \
    --input-dir trained_models/scam-defense-qwen35-4b-v8-synthetic/training_data \
    --output-dir training-data/scam-defense-export/v8-combined
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from scam_defense_exchange import action_catalog_for_key


def extract_field(chatml: str, role: str) -> str:
    m = re.search(rf"<\|im_start\|>{role}\n(.*?)(<\|im_end\|>|$)", chatml, re.DOTALL)
    return m.group(1).strip() if m else ""


def chatml_to_trajectory(
    row: dict,
    idx: int,
    prefix: str,
) -> dict:
    chatml_text = str(row.get("text") or "")
    system = extract_field(chatml_text, "system")
    user = extract_field(chatml_text, "user")
    assistant = extract_field(chatml_text, "assistant")

    # Try to parse assistant response to extract action for reward
    reward = 1.0
    action = "unknown"
    response_text = str(row.get("response_text") or "")
    try:
        resp = json.loads(assistant)
        action = resp.get("chosenAction", "unknown")
        response_text = str(resp.get("responseText") or response_text)
    except (json.JSONDecodeError, AttributeError):
        pass

    tid = str(row.get("record_id") or f"{prefix}-{idx}")
    group_id = str(row.get("group_id") or f"{prefix}-group-{idx}")
    scenario_id = str(row.get("scenario_id") or group_id)
    chosen_action = str(row.get("chosen_action") or action or "unknown")
    available_actions = (
        list(row.get("available_actions") or [])
        if isinstance(row.get("available_actions"), list)
        else action_catalog_for_key(tid, chosen_action=chosen_action)
    )
    metadata = {
        "scenarioProfile": "scam-defense-v8",
        "finalTrustScore": 85,
        "chosenAction": chosen_action,
        "groupId": group_id,
        "sourceKind": row.get("source_kind"),
        "availableActions": available_actions,
        "actionCatalogProfile": row.get("action_catalog_profile"),
    }
    return {
        "trajectory": {
            "trajectoryId": tid,
            "id": tid,
            "agentId": "v8-agent",
            "windowId": group_id,
            "scenarioId": scenario_id,
            "episodeId": f"v8-ep-{idx}",
            "steps": [
                {
                    "stepNumber": 0,
                    "timestamp": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "environmentState": {},
                    "providerAccesses": [],
                    "llmCalls": [
                        {
                            "systemPrompt": system,
                            "userPrompt": user,
                            "response": assistant,
                            "purpose": "action",
                            "model": "synthetic-v8",
                            "actionType": str(row.get("action_type") or "scam_defense_decision"),
                        }
                    ],
                    "action": {
                        "actionType": str(row.get("action_type") or "scam_defense_decision"),
                        "parameters": {
                            "chosenAction": chosen_action,
                            "availableActions": [
                                item.get("name", "") if isinstance(item, dict) else str(item)
                                for item in available_actions
                            ],
                            "responseFormat": row.get("response_format", "decision-json"),
                        },
                        "success": True,
                        "result": {"responseText": response_text},
                    },
                    "reward": reward,
                    "trustState": {
                        "profile": "blue",
                        "scamLossesAvoided": 1000,
                        "scamLossesIncurred": 0,
                        "unsafeDisclosures": 0,
                    },
                }
            ],
            "totalReward": reward,
            "episodeLength": 1,
            "finalStatus": "completed",
            "finalPnL": 0,
            "finalBalance": 0,
            "tradesExecuted": 0,
            "postsCreated": 0,
            "archetype": "scam-defense",
            "metadataJson": json.dumps(metadata),
        }
    }


def convert_file(input_path: Path, output_path: Path, prefix: str) -> int:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with open(input_path) as fin, open(output_path, "w") as fout:
        for i, line in enumerate(fin):
            line = line.strip()
            if not line:
                continue
            data = json.loads(line)
            chatml_text = data.get("text", "")
            if not chatml_text:
                continue
            traj = chatml_to_trajectory(data, i, prefix)
            fout.write(json.dumps(traj) + "\n")
            count += 1
    return count


def main():
    parser = argparse.ArgumentParser(description="Convert ChatML to trajectory JSONL")
    parser.add_argument(
        "--input-dir", required=True, help="Directory with train.jsonl and valid.jsonl"
    )
    parser.add_argument("--output-dir", required=True, help="Output directory for trajectory files")
    parser.add_argument(
        "--merge-with",
        default=None,
        help="Optional: merge with existing trajectory dir (e.g. v6 external data)",
    )
    args = parser.parse_args()

    input_dir = Path(args.input_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "held-out").mkdir(parents=True, exist_ok=True)

    train_count = convert_file(
        input_dir / "train.jsonl",
        output_dir / "trajectories.jsonl",
        "v8-train",
    )
    valid_count = convert_file(
        input_dir / "valid.jsonl",
        output_dir / "held-out" / "trajectories.jsonl",
        "v8-valid",
    )

    print(f"Converted {train_count} train, {valid_count} valid trajectories")

    # Optionally merge with external data
    merge_train = 0
    merge_valid = 0
    if args.merge_with:
        merge_dir = Path(args.merge_with)
        if (merge_dir / "trajectories.jsonl").exists():
            with (
                open(merge_dir / "trajectories.jsonl") as fin,
                open(output_dir / "trajectories.jsonl", "a") as fout,
            ):
                for line in fin:
                    fout.write(line)
                    merge_train += 1
            print(f"Merged {merge_train} external train trajectories")

        held_out_path = merge_dir / "held-out" / "trajectories.jsonl"
        if held_out_path.exists():
            with (
                open(held_out_path) as fin,
                open(output_dir / "held-out" / "trajectories.jsonl", "a") as fout,
            ):
                for line in fin:
                    fout.write(line)
                    merge_valid += 1
            print(f"Merged {merge_valid} external valid trajectories")

    total_train = train_count + merge_train
    total_valid = valid_count + merge_valid

    manifest = {
        "source": "v8-combined",
        "v8_train": train_count,
        "v8_valid": valid_count,
        "external_train": merge_train,
        "external_valid": merge_valid,
        "total_train": total_train,
        "total_valid": total_valid,
    }
    with open(output_dir / "manifest.json", "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"Manifest written. Total: {total_train} train, {total_valid} valid")


if __name__ == "__main__":
    main()
