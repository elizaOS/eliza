"""Catalog of ASIMOV-1 morphology parameters and their proof requirements."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class MorphologyParameter:
    name: str
    group: str
    label: str
    default: float
    minimum: float
    maximum: float
    unit: str
    affected_links: tuple[str, ...]
    transform: str
    intent: str
    proof_requirements: tuple[str, ...]


PROOF_REQUIREMENTS = (
    "spline_fit",
    "interface_preservation",
    "topology",
    "surface_distance",
    "mujoco_load",
)


MORPHOLOGY_PARAMETERS: tuple[MorphologyParameter, ...] = (
    MorphologyParameter(
        name="global_shell_scale",
        group="lean",
        label="Global shell thinning",
        default=0.92,
        minimum=0.80,
        maximum=1.00,
        unit="multiplier",
        affected_links=(
            "NECK_YAW",
            "NECK_PITCH",
            "LEFT_HIP_PITCH",
            "RIGHT_HIP_PITCH",
            "LEFT_HIP_ROLL",
            "RIGHT_HIP_ROLL",
            "LEFT_HIP_YAW",
            "RIGHT_HIP_YAW",
            "LEFT_KNEE",
            "RIGHT_KNEE",
            "LEFT_ANKLE_A",
            "RIGHT_ANKLE_A",
            "LEFT_ANKLE_B",
            "RIGHT_ANKLE_B",
            "LEFT_SHOULDER_ROLL",
            "RIGHT_SHOULDER_ROLL",
            "LEFT_SHOULDER_YAW",
            "RIGHT_SHOULDER_YAW",
            "LEFT_ELBOW",
            "RIGHT_ELBOW",
            "LEFT_WRIST_YAW",
            "RIGHT_WRIST_YAW",
        ),
        transform="uniform radial scale away from reserved connection levels",
        intent="Primary lean/space-efficiency control for all body shells and limbs.",
        proof_requirements=PROOF_REQUIREMENTS,
    ),
    MorphologyParameter(
        name="torso_waist_cinch_depth",
        group="torso",
        label="Waist cinch depth",
        default=0.12,
        minimum=0.00,
        maximum=0.20,
        unit="fractional radial reduction",
        affected_links=("WAIST_YAW", "IMU_ORIGIN"),
        transform="gaussian radial reduction about the torso/pelvis waist band",
        intent="Narrow the torso and pelvis waist while preserving waist, shoulder, neck, and hip mates.",
        proof_requirements=PROOF_REQUIREMENTS,
    ),
    MorphologyParameter(
        name="hip_spacing_scale",
        group="pelvis",
        label="Hip spacing scale",
        default=0.96,
        minimum=0.88,
        maximum=1.05,
        unit="multiplier",
        affected_links=("IMU_ORIGIN", "LEFT_HIP_PITCH", "RIGHT_HIP_PITCH"),
        transform="Y-axis socket spacing parameter plus mating-ring preservation",
        intent="Narrow robot hip spacing between legs without moving unproven joint interfaces.",
        proof_requirements=PROOF_REQUIREMENTS,
    ),
    MorphologyParameter(
        name="upper_thigh_hip_flare",
        group="hips",
        label="Upper thigh hip flare",
        default=0.13,
        minimum=0.00,
        maximum=0.18,
        unit="fractional Y gain",
        affected_links=("LEFT_HIP_YAW", "RIGHT_HIP_YAW"),
        transform="localized Y-axis flare near upper thigh, tapered before knee interface",
        intent="Add hip/upper-leg curvature while keeping hip and knee connection planes fixed.",
        proof_requirements=PROOF_REQUIREMENTS,
    ),
    MorphologyParameter(
        name="bust_front_gain",
        group="torso",
        label="Bust front gain",
        default=0.40,
        minimum=0.00,
        maximum=0.55,
        unit="fractional sector gain",
        affected_links=("WAIST_YAW",),
        transform="front +X sector gain over upper-mid torso band",
        intent="Accentuate chest as integrated surface curvature, not attached primitives.",
        proof_requirements=PROOF_REQUIREMENTS,
    ),
    MorphologyParameter(
        name="back_arch_shift_m",
        group="torso",
        label="Back arch shift",
        default=0.013,
        minimum=0.00,
        maximum=0.025,
        unit="metres",
        affected_links=("WAIST_YAW",),
        transform="smooth centroid shift in -X over mid torso",
        intent="Sculpt the back profile while preserving waist, shoulder, and neck interfaces.",
        proof_requirements=PROOF_REQUIREMENTS,
    ),
    MorphologyParameter(
        name="calf_back_bulge",
        group="legs",
        label="Calf back bulge",
        default=1.06,
        minimum=1.00,
        maximum=1.10,
        unit="sector multiplier",
        affected_links=("LEFT_KNEE", "RIGHT_KNEE"),
        transform="localized -X sector multiplier over calf belly band",
        intent="Create leg curvature while keeping knee and ankle mates fixed.",
        proof_requirements=PROOF_REQUIREMENTS,
    ),
    MorphologyParameter(
        name="arm_slim_taper",
        group="arms",
        label="Arm slim taper",
        default=0.82,
        minimum=0.74,
        maximum=0.95,
        unit="radial multiplier",
        affected_links=(
            "LEFT_SHOULDER_ROLL",
            "RIGHT_SHOULDER_ROLL",
            "LEFT_SHOULDER_YAW",
            "RIGHT_SHOULDER_YAW",
            "LEFT_ELBOW",
            "RIGHT_ELBOW",
            "LEFT_WRIST_YAW",
            "RIGHT_WRIST_YAW",
        ),
        transform="radial scale with wrist/hand taper, pinned at joint planes",
        intent="Thin and curve arms/forearms without breaking shoulder, elbow, or wrist mates.",
        proof_requirements=PROOF_REQUIREMENTS,
    ),
)


def morphology_parameter_catalog() -> dict[str, Any]:
    groups = sorted({param.group for param in MORPHOLOGY_PARAMETERS})
    links = sorted({link for param in MORPHOLOGY_PARAMETERS for link in param.affected_links})
    return {
        "schema": "asimov-1-morphology-parameter-catalog-v1",
        "parameter_count": len(MORPHOLOGY_PARAMETERS),
        "groups": groups,
        "affected_link_count": len(links),
        "affected_links": links,
        "required_proof_types": list(PROOF_REQUIREMENTS),
        "parameters": [_parameter_dict(param) for param in MORPHOLOGY_PARAMETERS],
    }


def _parameter_dict(param: MorphologyParameter) -> dict[str, Any]:
    data = asdict(param)
    data["affected_links"] = list(param.affected_links)
    data["proof_requirements"] = list(param.proof_requirements)
    return data


def dump_morphology_parameter_catalog_json() -> str:
    return json.dumps(morphology_parameter_catalog(), indent=2, sort_keys=True) + "\n"
