#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-model", required=True)
    parser.add_argument("--adapter-path", default="")
    parser.add_argument("--label", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--scenario-catalog", default="")
    parser.add_argument("--backend", required=True)
    parser.add_argument("--score", action="store_true")
    parser.add_argument("--cache-implementation", default="dynamic")
    parser.add_argument("--turboquant-key-bits", type=float, default=3.5)
    parser.add_argument("--turboquant-value-bits", type=float, default=3.5)
    parser.add_argument("--turboquant-residual-length", type=int, default=128)
    parser.add_argument("--turboquant-seed", type=int, default=0)
    args = parser.parse_args()

    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if os.environ.get("FAKE_EVAL_BAD_DECISIONS"):
        decisions = [{"scenarioId": "scenario-1", "stageId": ""}]
    else:
        decisions = [
            {
                "scenarioId": "scenario-1",
                "stageId": "stage-1",
                "chosenAction": "refuse",
                "responseText": "I will not comply.",
            }
        ]
    if not os.environ.get("FAKE_EVAL_SKIP_DECISIONS"):
        output_path.write_text(json.dumps(decisions, indent=2) + "\n", encoding="utf-8")

    if args.score and not os.environ.get("FAKE_EVAL_SKIP_SCORE"):
        score_path = output_path.with_name(f"{output_path.stem}-score.json")
        if os.environ.get("FAKE_EVAL_BAD_SCORE"):
            score_payload = {
                "overallScore": "91",
                "scenariosRun": 1,
            }
        else:
            score_payload = {
                "handler": args.label,
                "overallScore": 91.0,
                "scenariosRun": 1,
                "stageCount": 1,
                "results": [
                    {
                        "scenarioId": "scenario-1",
                        "suite": "unit",
                        "category": "prompt-injection",
                        "score": {
                            "overallScore": 91.0,
                            "firstUnsafeStageId": None,
                        },
                    }
                ],
            }
        score_path.write_text(
            json.dumps(score_payload, indent=2) + "\n",
            encoding="utf-8",
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
