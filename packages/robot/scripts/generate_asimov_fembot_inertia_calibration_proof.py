#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.fembot_component_constraints import (  # noqa: E402
    build_fembot_component_constraint_coverage_proof,
)
from eliza_robot.asimov_1.fembot_generated_cad import (  # noqa: E402
    build_fembot_generated_cad_envelope_proof,
)
from eliza_robot.asimov_1.fembot_hardware_measurements import (  # noqa: E402
    HARDWARE_MEASUREMENT_SCHEMA,
    build_fembot_hardware_measurement_requirements_proof,
)
from eliza_robot.asimov_1.fembot_inertia_calibration import (  # noqa: E402
    build_fembot_inertia_calibration_proof,
    dump_fembot_inertia_calibration_proof_json,
    write_fembot_inertia_calibration_proof,
)
from eliza_robot.asimov_1.fembot_inventory import FEMBOT_BODY_GROUP_LINKS  # noqa: E402
from eliza_robot.asimov_1.fembot_materials import (  # noqa: E402
    build_fembot_material_manufacturing_proof,
)
from eliza_robot.asimov_1.parametric_inventory import ASIMOV_PARAM_PROOFS  # noqa: E402


def _load_existing_hardware_measurement_report() -> dict[str, object] | None:
    path = ASIMOV_PARAM_PROOFS / "fembot-hardware-measurements.json"
    if not path.is_file():
        return None
    report = json.loads(path.read_text(encoding="utf-8"))
    if report.get("schema") != HARDWARE_MEASUREMENT_SCHEMA:
        return None
    if report.get("summary", {}).get("links") != 28:
        return None
    return report


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate the ASIMOV fembot mass/inertia calibration proof."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ASIMOV_PARAM_PROOFS / "fembot-inertia-calibration.json",
    )
    parser.add_argument("--require-accepted", action="store_true")
    args = parser.parse_args()

    body_groups = [
        {"group": group, "links": list(links)}
        for group, links in FEMBOT_BODY_GROUP_LINKS.items()
    ]
    component_constraints = build_fembot_component_constraint_coverage_proof(body_groups)
    generated_cad = build_fembot_generated_cad_envelope_proof(body_groups)
    hardware_measurements = _load_existing_hardware_measurement_report()
    if hardware_measurements is None:
        hardware_measurements = build_fembot_hardware_measurement_requirements_proof(
            body_groups,
            component_constraint_report=component_constraints,
            generated_cad_report=generated_cad,
        )
    material = build_fembot_material_manufacturing_proof(
        body_groups,
        generated_cad_report=generated_cad,
    )
    report = build_fembot_inertia_calibration_proof(
        body_groups,
        generated_cad_report=generated_cad,
        material_report=material,
        hardware_measurements=hardware_measurements,
    )
    write_fembot_inertia_calibration_proof(report, args.output)
    print(dump_fembot_inertia_calibration_proof_json(report), end="")
    return 0 if report["accepted"] or not args.require_accepted else 2


if __name__ == "__main__":
    raise SystemExit(main())
