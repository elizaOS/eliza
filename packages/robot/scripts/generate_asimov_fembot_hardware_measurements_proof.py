#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_hardware_measurements import (  # noqa: E402
    apply_fembot_hardware_measurement_evidence,
    build_fembot_hardware_measurement_requirements_proof,
    build_fembot_hardware_measurement_template,
    dump_fembot_hardware_measurement_evidence_validation_json,
    dump_fembot_hardware_measurement_requirements_proof_json,
    write_fembot_hardware_measurement_evidence_validation,
    write_fembot_hardware_measurement_requirements_proof,
    write_fembot_hardware_measurement_template,
)
from eliza_robot.asimov_1.fembot_inventory import collect_fembot_inventory  # noqa: E402
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate ASIMOV fembot hardware measurement requirements proof."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-hardware-measurements.json",
    )
    parser.add_argument(
        "--require-accepted",
        action="store_true",
        help="fail until all required hardware measurements are provided and verified",
    )
    parser.add_argument(
        "--template-output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-hardware-measurement-template.json",
        help="write a fillable JSON template for exact hardware dimensions",
    )
    parser.add_argument(
        "--evidence",
        type=Path,
        help="optional filled measurement JSON to validate against the generated template",
    )
    parser.add_argument(
        "--validation-output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-hardware-measurement-validation.json",
        help="write validation results for --evidence or an empty measurement set",
    )
    args = parser.parse_args()

    inventory = collect_fembot_inventory()
    report = build_fembot_hardware_measurement_requirements_proof(
        inventory["body_groups"],
    )
    template = build_fembot_hardware_measurement_template(report)
    write_fembot_hardware_measurement_template(template, args.template_output)
    evidence = (
        json.loads(args.evidence.read_text(encoding="utf-8"))
        if args.evidence
        else {"measurements": []}
    )
    report = apply_fembot_hardware_measurement_evidence(report, evidence)
    validation = report["evidence_validation"]
    write_fembot_hardware_measurement_requirements_proof(report, args.output)
    write_fembot_hardware_measurement_evidence_validation(validation, args.validation_output)
    print(dump_fembot_hardware_measurement_requirements_proof_json(report), end="")
    if args.evidence:
        print(dump_fembot_hardware_measurement_evidence_validation_json(validation), end="")
    return 0 if validation["accepted"] or not args.require_accepted else 2


if __name__ == "__main__":
    raise SystemExit(main())
