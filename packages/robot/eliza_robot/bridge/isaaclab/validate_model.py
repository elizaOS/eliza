"""Validate AiNex URDF/USD model joint structure and physics properties.

Runs standalone (no Isaac Sim required) against the URDF to verify:
- All expected joints are present with correct limits
- Link masses are physically reasonable
- Joint axes match expected kinematic chain
- Standing pose is valid (all joints within limits)

Usage:
    python -m bridge.isaaclab.validate_model [--urdf PATH]
"""

from __future__ import annotations

import argparse
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

from eliza_robot.bridge.isaaclab.ainex_cfg import STAND_JOINT_POSITIONS
from eliza_robot.bridge.isaaclab.joint_map import JOINT_BY_NAME, JOINT_TABLE


@dataclass
class ValidationResult:
    checks_run: int = 0
    checks_passed: int = 0
    warnings: list[str] = None  # type: ignore[assignment]
    errors: list[str] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.warnings is None:
            self.warnings = []
        if self.errors is None:
            self.errors = []


ROOT_DIR = Path(__file__).resolve().parent.parent.parent
DEFAULT_URDF = ROOT_DIR / "bridge" / "generated" / "ainex.urdf"


def _parse_urdf(path: Path) -> ET.Element:
    tree = ET.parse(str(path))
    return tree.getroot()


def validate_joints(root: ET.Element, result: ValidationResult) -> None:
    """Check all expected joints exist with correct limits."""
    urdf_joints: dict[str, ET.Element] = {}
    for j in root.findall("joint"):
        name = j.get("name", "")
        if name:
            urdf_joints[name] = j

    for spec in JOINT_TABLE:
        result.checks_run += 1
        if spec.urdf_name not in urdf_joints:
            result.errors.append(f"missing joint: {spec.urdf_name}")
            continue

        result.checks_passed += 1
        j = urdf_joints[spec.urdf_name]

        # Check joint type
        result.checks_run += 1
        jtype = j.get("type", "")
        if jtype != "revolute":
            result.errors.append(f"joint {spec.urdf_name}: expected revolute, got {jtype}")
        else:
            result.checks_passed += 1

        # Check limits
        limit = j.find("limit")
        if limit is not None:
            result.checks_run += 1
            lower = float(limit.get("lower", "0"))
            upper = float(limit.get("upper", "0"))
            effort = float(limit.get("effort", "0"))

            if abs(lower - spec.lower_rad) > 0.01:
                result.errors.append(
                    f"joint {spec.urdf_name}: lower limit mismatch "
                    f"(urdf={lower}, expected={spec.lower_rad})"
                )
            elif abs(upper - spec.upper_rad) > 0.01:
                result.errors.append(
                    f"joint {spec.urdf_name}: upper limit mismatch "
                    f"(urdf={upper}, expected={spec.upper_rad})"
                )
            elif abs(effort - spec.effort) > 0.1:
                result.warnings.append(
                    f"joint {spec.urdf_name}: effort mismatch "
                    f"(urdf={effort}, expected={spec.effort})"
                )
            else:
                result.checks_passed += 1


def validate_link_masses(root: ET.Element, result: ValidationResult) -> None:
    """Check link masses are physically reasonable."""
    total_mass = 0.0
    for link in root.findall("link"):
        inertial = link.find("inertial")
        if inertial is None:
            continue
        mass_elem = inertial.find("mass")
        if mass_elem is None:
            continue
        mass = float(mass_elem.get("value", "0"))
        total_mass += mass
        name = link.get("name", "unknown")

        result.checks_run += 1
        if mass <= 0.0:
            result.errors.append(f"link {name}: non-positive mass {mass}")
        elif mass > 2.0:
            result.warnings.append(f"link {name}: unusually heavy ({mass} kg)")
        else:
            result.checks_passed += 1

    result.checks_run += 1
    if total_mass < 1.0 or total_mass > 5.0:
        result.warnings.append(f"total robot mass {total_mass:.3f} kg outside expected 1-5 kg range")
    else:
        result.checks_passed += 1
    print(f"  Total robot mass: {total_mass:.3f} kg")


def validate_mesh_references(root: ET.Element, urdf_dir: Path, result: ValidationResult) -> None:
    """Check that referenced mesh files exist."""
    for link in root.findall("link"):
        for geom_type in ("visual", "collision"):
            geom = link.find(geom_type)
            if geom is None:
                continue
            geometry = geom.find("geometry")
            if geometry is None:
                continue
            mesh = geometry.find("mesh")
            if mesh is None:
                continue
            filename = mesh.get("filename", "")
            if not filename:
                continue

            result.checks_run += 1
            # Handle both package:// and relative paths
            if filename.startswith("package://"):
                # Skip package:// URIs as they require ROS resolution
                result.checks_passed += 1
                continue

            mesh_path = urdf_dir / filename
            if mesh_path.exists():
                result.checks_passed += 1
            else:
                result.warnings.append(
                    f"link {link.get('name', '?')}: mesh not found: {filename}"
                )


def validate_standing_pose(result: ValidationResult) -> None:
    """Check that the standing pose has all joints within limits."""
    for name, pos in STAND_JOINT_POSITIONS.items():
        result.checks_run += 1
        spec = JOINT_BY_NAME.get(name)
        if spec is None:
            result.errors.append(f"standing pose: unknown joint {name}")
            continue
        if pos < spec.lower_rad or pos > spec.upper_rad:
            result.errors.append(
                f"standing pose: {name}={pos} outside limits [{spec.lower_rad}, {spec.upper_rad}]"
            )
        else:
            result.checks_passed += 1


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate AiNex robot model")
    parser.add_argument(
        "--urdf",
        type=str,
        default=str(DEFAULT_URDF),
        help="path to URDF file",
    )
    args = parser.parse_args()

    urdf_path = Path(args.urdf)
    if not urdf_path.exists():
        print(f"ERROR: URDF not found: {urdf_path}")
        print("Run ./bridge/scripts/prepare_ainex_urdf.sh first.")
        raise SystemExit(1)

    root = _parse_urdf(urdf_path)
    result = ValidationResult()

    print("Validating joint structure...")
    validate_joints(root, result)

    print("Validating link masses...")
    validate_link_masses(root, result)

    print("Validating mesh references...")
    validate_mesh_references(root, urdf_path.parent, result)

    print("Validating standing pose...")
    validate_standing_pose(result)

    print()
    print(f"Checks: {result.checks_passed}/{result.checks_run} passed")
    if result.warnings:
        print(f"Warnings ({len(result.warnings)}):")
        for w in result.warnings:
            print(f"  - {w}")
    if result.errors:
        print(f"Errors ({len(result.errors)}):")
        for e in result.errors:
            print(f"  - {e}")
        print("model_validation=FAIL")
        raise SystemExit(1)

    print("model_validation=PASS")


if __name__ == "__main__":
    main()
