"""Proof contract definitions for ASIMOV fembot production readiness."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from typing import Any

FEMBOT_PROOF_SCHEMA_VERSION = "asimov-fembot-proof-contract-v1"


@dataclass(frozen=True)
class FembotProofContract:
    proof_type: str
    label: str
    scope: str
    required_artifact_schema: str
    pass_condition: str
    minimum_fields: tuple[str, ...]
    applies_to: tuple[str, ...]
    notes: str


FEMBOT_PROOF_CONTRACTS: tuple[FembotProofContract, ...] = (
    FembotProofContract(
        proof_type="source_step_or_controlled_loft",
        label="Source STEP or controlled loft",
        scope="per-link",
        required_artifact_schema="asimov-fembot-source-proof-v1",
        pass_condition=(
            "Every link is traced to source STEP/B-rep bodies or to a controlled "
            "loft with bounded fit error and preserved mate planes."
        ),
        minimum_fields=(
            "link",
            "source_kind",
            "source_paths",
            "source_sha256",
            "fit_max_error_m",
            "fit_rms_error_m",
            "interface_levels_m",
            "interface_max_delta_m",
            "accepted",
        ),
        applies_to=("torso", "head", "arm", "leg", "foot"),
        notes="STL-only reverse engineering is allowed as evidence input, not as the production source.",
    ),
    FembotProofContract(
        proof_type="material_properties",
        label="Material properties",
        scope="per-part",
        required_artifact_schema="asimov-fembot-material-proof-v1",
        pass_condition=(
            "Every generated part has a material assignment with density, modulus, "
            "yield/ultimate strength or process-appropriate allowable stress, and "
            "mass/inertia update inputs."
        ),
        minimum_fields=(
            "part_id",
            "material",
            "density_kg_m3",
            "elastic_modulus_pa",
            "yield_strength_pa",
            "allowable_stress_pa",
            "source",
            "accepted",
        ),
        applies_to=("torso", "head", "arm", "leg", "foot"),
        notes="Off-the-shelf components must retain vendor material/envelope metadata and must not be scaled.",
    ),
    FembotProofContract(
        proof_type="manufacturing_process",
        label="Manufacturing process",
        scope="per-part",
        required_artifact_schema="asimov-fembot-manufacturing-proof-v1",
        pass_condition=(
            "The selected process can make the part within wall, draft, flatness, "
            "tool-access, bend, tolerance, and undercut constraints."
        ),
        minimum_fields=(
            "part_id",
            "process",
            "minimum_wall_thickness_m",
            "minimum_feature_size_m",
            "draft_angle_deg",
            "undercut_count",
            "tool_access_ok",
            "tolerance_class",
            "accepted",
        ),
        applies_to=("torso", "head", "arm", "leg", "foot"),
        notes="Molded torso/head shells need injection/vacuform review; metal plates need machining/sheet review.",
    ),
    FembotProofContract(
        proof_type="flatness_or_smoothness",
        label="Flatness or smoothness",
        scope="per-surface",
        required_artifact_schema="asimov-fembot-surface-quality-proof-v1",
        pass_condition=(
            "Plate-metal surfaces remain planar within tolerance, while molded or "
            "lofted shells meet curvature/smoothness continuity requirements."
        ),
        minimum_fields=(
            "part_id",
            "surface_id",
            "surface_class",
            "flatness_error_m",
            "curvature_discontinuity_max",
            "normal_deviation_max_rad",
            "accepted",
        ),
        applies_to=("torso", "head", "arm", "leg", "foot"),
        notes="Spatially varying warps on structural flat plates should fail this proof.",
    ),
    FembotProofContract(
        proof_type="motor_bearing_ring_gear_pulley_fastener_keepouts",
        label="Component keepouts",
        scope="per-link",
        required_artifact_schema="asimov-fembot-keepout-proof-v1",
        pass_condition=(
            "All motors, bearings, rings, gears, pulleys, belts, fasteners, wiring, "
            "and service-access envelopes remain clear after thinning."
        ),
        minimum_fields=(
            "link",
            "component_count",
            "minimum_clearance_m",
            "violations",
            "off_the_shelf_scaled",
            "accepted",
        ),
        applies_to=("torso", "head", "arm", "leg", "foot"),
        notes="This proof is the primary guard against making the robot thin but unbuildable.",
    ),
    FembotProofContract(
        proof_type="hardware_measurements",
        label="Hardware measurement evidence",
        scope="per-link and per-component",
        required_artifact_schema="asimov-fembot-hardware-measurement-requirements-v1",
        pass_condition=(
            "Every motor, bearing/ring, transmission, fastener/thread, wiring/service-access, "
            "vendor off-the-shelf, and component-specific clearance requirement has exact "
            "measured or datasheet-backed dimensions with valid units and sources."
        ),
        minimum_fields=(
            "link",
            "measurement_key",
            "family",
            "field",
            "value",
            "unit",
            "source",
            "accepted",
        ),
        applies_to=("torso", "head", "arm", "leg", "foot"),
        notes=(
            "This bridges conservative keepouts to manufacturable CAD; no link can "
            "be accepted with placeholder radii only."
        ),
    ),
    FembotProofContract(
        proof_type="interface_preservation",
        label="Interface preservation",
        scope="per-link",
        required_artifact_schema="asimov-fembot-interface-proof-v1",
        pass_condition="All parent/child mate planes, bores, centers, and axes remain within tolerance.",
        minimum_fields=(
            "link",
            "interface_levels_m",
            "centroid_delta_max_m",
            "bbox_delta_max_m",
            "axis_delta_max_rad",
            "accepted",
        ),
        applies_to=("torso", "head", "arm", "leg", "foot"),
        notes="This extends the existing spline-fit interface proof with axis and bore constraints.",
    ),
    FembotProofContract(
        proof_type="topology",
        label="Export topology",
        scope="per-mesh-export",
        required_artifact_schema="asimov-fembot-topology-proof-v1",
        pass_condition="Generated mesh exports are watertight/manifold where simulation or manufacturing requires it.",
        minimum_fields=(
            "link",
            "boundary_edges",
            "nonmanifold_edges",
            "degenerate_faces",
            "component_count",
            "watertight",
            "accepted",
        ),
        applies_to=("torso", "head", "arm", "leg", "foot"),
        notes="Inherited topology defects must be repaired or explicitly isolated as non-production references.",
    ),
    FembotProofContract(
        proof_type="surface_distance",
        label="Surface distance",
        scope="per-link",
        required_artifact_schema="asimov-fembot-surface-distance-proof-v1",
        pass_condition="Generated surfaces remain within bounded source/reference distance except intentional thinning zones.",
        minimum_fields=(
            "link",
            "source_to_output_rms_m",
            "source_to_output_max_m",
            "output_to_source_rms_m",
            "output_to_source_max_m",
            "intentional_delta_regions",
            "accepted",
        ),
        applies_to=("torso", "head", "arm", "leg", "foot"),
        notes="Distance bounds need region labels so deliberate slimming is not confused with drift.",
    ),
    FembotProofContract(
        proof_type="collision_sweep",
        label="Collision sweep",
        scope="per-body-group and whole-robot",
        required_artifact_schema="asimov-fembot-collision-sweep-proof-v1",
        pass_condition=(
            "Known joint ranges and sampled motion paths are collision-free except "
            "approved contact pairs, with minimum clearance recorded."
        ),
        minimum_fields=(
            "group",
            "joint_ranges",
            "samples",
            "minimum_clearance_m",
            "colliding_pairs",
            "approved_contact_pairs",
            "accepted",
        ),
        applies_to=("torso", "head", "arm", "leg", "foot"),
        notes="This is separate from MuJoCo load; it proves spatial fit during motion.",
    ),
    FembotProofContract(
        proof_type="collider_scale_tuning",
        label="Collider scale tuning",
        scope="whole-robot",
        required_artifact_schema="asimov-fembot-contact-tuning-proof-v1",
        pass_condition=(
            "Generated MuJoCo body-capsule collider scales are swept, sampled contacts "
            "are eliminated or explicitly approved, and the selected colliders retain "
            "measured visual-mesh coverage before production acceptance."
        ),
        minimum_fields=(
            "scale_candidates",
            "contact_clean_scale_count",
            "best_scale",
            "contact_pairs",
            "visual_fit",
            "accepted",
        ),
        applies_to=("torso", "head", "arm", "leg", "foot"),
        notes=(
            "A contact-clean scale is not sufficient by itself; under-covering visual "
            "meshes must keep this proof non-accepted until the collision set is rebuilt."
        ),
    ),
    FembotProofContract(
        proof_type="mujoco_static",
        label="MuJoCo static model",
        scope="whole-robot",
        required_artifact_schema="asimov-1-mujoco-load-proof-v1",
        pass_condition="MJCF asset refs, actuator count/order, and collision geoms pass static checks.",
        minimum_fields=("static", "summary", "accepted"),
        applies_to=("torso", "head", "arm", "leg", "foot"),
        notes="Current ASIMOV static proof already passes; fembot exports must preserve it.",
    ),
    FembotProofContract(
        proof_type="mujoco_dynamic",
        label="MuJoCo dynamic step",
        scope="whole-robot",
        required_artifact_schema="asimov-1-mujoco-load-proof-v1",
        pass_condition="MuJoCo imports, compiles, forwards, and steps the fembot MJCF with expected actuator count.",
        minimum_fields=("load", "summary", "accepted"),
        applies_to=("torso", "head", "arm", "leg", "foot"),
        notes="Requires the Python mujoco package or an equivalent provisioned simulator environment.",
    ),
    FembotProofContract(
        proof_type="whole_robot_assembly",
        label="Whole-robot assembly",
        scope="whole-robot",
        required_artifact_schema="asimov-fembot-assembly-proof-v1",
        pass_condition=(
            "All fembot body groups assemble at the original height with preserved "
            "kinematic tree, joint axes, actuator order, mass/inertia records, and no mate gaps."
        ),
        minimum_fields=(
            "height_m",
            "height_delta_m",
            "joint_count",
            "actuator_count",
            "mate_gap_max_m",
            "axis_delta_max_rad",
            "accepted",
        ),
        applies_to=("torso", "head", "arm", "leg", "foot"),
        notes="This is the final fit-together proof before any generated profile can be promoted.",
    ),
    FembotProofContract(
        proof_type="structural_sanity",
        label="Structural sanity",
        scope="per-part and per-body-group",
        required_artifact_schema="asimov-fembot-structural-proof-v1",
        pass_condition=(
            "Minimum wall/web thickness, load path, stress, deflection, buckling, "
            "and fastener edge-distance checks are inside process/material limits."
        ),
        minimum_fields=(
            "part_id",
            "load_cases",
            "minimum_wall_thickness_m",
            "minimum_safety_factor",
            "max_stress_pa",
            "max_deflection_m",
            "accepted",
        ),
        applies_to=("torso", "head", "arm", "leg", "foot"),
        notes="This contract can start with conservative analytic checks before full FEA is added.",
    ),
    FembotProofContract(
        proof_type="visual_review",
        label="Visual and mathematical review",
        scope="per-body-group and whole-robot",
        required_artifact_schema="asimov-fembot-visual-review-proof-v1",
        pass_condition="Rendered views and numeric envelopes confirm the fembot shape is thin, coherent, and nonbroken.",
        minimum_fields=(
            "group",
            "render_paths",
            "front_envelope_m",
            "side_envelope_m",
            "three_quarter_review",
            "accepted",
        ),
        applies_to=("torso", "head", "arm", "leg", "foot"),
        notes="Visual review cannot replace physics/manufacturing proofs; it catches bad geometry that numeric gates miss.",
    ),
    FembotProofContract(
        proof_type="visual_motion_media",
        label="Screenshots and constrained joint-motion video",
        scope="whole-robot",
        required_artifact_schema="asimov-fembot-media-review-v1",
        pass_condition=(
            "Each design round has nonblank whole-robot screenshots plus a video "
            "driving all limited hinge joints simultaneously inside their declared ranges."
        ),
        minimum_fields=(
            "screenshots",
            "video",
            "joint_motion",
            "summary",
            "accepted",
        ),
        applies_to=("torso", "head", "arm", "leg", "foot"),
        notes=(
            "This is the explicit visual deliverable for every round; it remains "
            "separate from manual visual acceptance and engineering signoff."
        ),
    ),
)


def fembot_proof_contracts_by_type() -> dict[str, FembotProofContract]:
    return {contract.proof_type: contract for contract in FEMBOT_PROOF_CONTRACTS}


def fembot_proof_contract_report() -> dict[str, Any]:
    return {
        "schema": FEMBOT_PROOF_SCHEMA_VERSION,
        "proof_count": len(FEMBOT_PROOF_CONTRACTS),
        "proof_types": [contract.proof_type for contract in FEMBOT_PROOF_CONTRACTS],
        "contracts": [asdict(contract) for contract in FEMBOT_PROOF_CONTRACTS],
    }


def dump_fembot_proof_contract_report_json() -> str:
    return json.dumps(fembot_proof_contract_report(), indent=2, sort_keys=True) + "\n"
