"""Canonical parametric definition of **erobot** — the single source of truth.

erobot is a full-size (~1.70 m) humanoid designed from scratch for this repo.
Design intent:

  * Light and thin: every structural link is a hollow injection-molded shell
    (clamshell halves bolted around the actuator), not solid stock.
  * Strong where it counts: load-path links (legs, pelvis, torso spine) use
    30% glass-filled nylon; cosmetic / low-load links use PC-ABS.
  * Easy to assemble / access / replace: one actuator per joint, captured at
    the body origin between two molded halves with brass heat-set inserts; no
    bonded joints, every link removable with an M4 hex driver.

Every other module (`mjcf`, `mass`, `profile`, `bom`, `mating`, `validate`)
consumes :func:`build_spec` — they never hardcode geometry. Change a number
here and the MJCF, the MuJoCo inertials, the profile, and the BOM all move
together.

Coordinate convention (matches MuJoCo + the repo's other profiles):
``x`` forward, ``y`` left, ``z`` up. The robot stands at the origin with both
foot soles on the ``z = 0`` ground plane in the home pose.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import Literal

Vec3 = tuple[float, float, float]

JointGroup = Literal["LEG", "ARM", "HEAD", "TORSO"]
GeomType = Literal["capsule", "box", "cylinder", "sphere", "ellipsoid"]
ActuatorTier = Literal["high", "mid", "low"]


# ---------------------------------------------------------------------------
# Materials — conservative engineering baselines. Replace allowable_stress with
# vendor/build-direction data before any production release.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Material:
    key: str
    name: str
    density_kg_m3: float
    elastic_modulus_pa: float
    yield_strength_pa: float
    allowable_stress_pa: float
    source: str


MATERIALS: dict[str, Material] = {
    "PA6_GF30": Material(
        key="PA6_GF30",
        name="30% glass-filled nylon 6 (injection molded)",
        density_kg_m3=1360.0,
        elastic_modulus_pa=9.5e9,
        yield_strength_pa=160e6,
        # ~3x knockdown on yield for fatigue + weld lines + moisture.
        allowable_stress_pa=55e6,
        source="conservative PA6-GF30 molded baseline; verify supplier datasheet + build direction before release",
    ),
    "PC_ABS": Material(
        key="PC_ABS",
        name="PC-ABS blend (injection molded)",
        density_kg_m3=1130.0,
        elastic_modulus_pa=2.4e9,
        yield_strength_pa=55e6,
        allowable_stress_pa=18e6,
        source="conservative PC-ABS molded baseline; verify supplier datasheet before release",
    ),
    "TPU_SHORE_A95": Material(
        key="TPU_SHORE_A95",
        name="TPU 95A (molded foot sole)",
        density_kg_m3=1200.0,
        elastic_modulus_pa=0.05e9,
        yield_strength_pa=25e6,
        allowable_stress_pa=6e6,
        source="conservative TPU 95A baseline; sole is a wear part",
    ),
}


# ---------------------------------------------------------------------------
# Off-the-shelf actuator tiers. Mass is the installed mass of the actuator plus
# its joint bearing + fasteners (the lumped "iron" that sits at each joint).
# Torque is the peak the joint is designed around; it drives BOM selection and
# the profile's actuator_torque_nm / safe_torque_clip.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ActuatorClass:
    tier: ActuatorTier
    mass_kg: float
    peak_torque_nm: float
    velocity_max_rad_s: float


# Tier values track the confirmed off-the-shelf BOM selections:
#   high -> CubeMars AK80-64 (120 N·m peak, 0.85 kg)
#   mid  -> CubeMars AK70-10 (24.8 N·m peak, 0.52 kg)
#   low  -> Robotis Dynamixel XM540-W270 (10.6 N·m stall, 0.165 kg)
ACTUATORS: dict[str, ActuatorClass] = {
    "high": ActuatorClass(tier="high", mass_kg=0.85, peak_torque_nm=120.0, velocity_max_rad_s=20.0),
    "mid": ActuatorClass(tier="mid", mass_kg=0.52, peak_torque_nm=24.0, velocity_max_rad_s=20.0),
    "low": ActuatorClass(tier="low", mass_kg=0.17, peak_torque_nm=10.0, velocity_max_rad_s=12.0),
}


# ---------------------------------------------------------------------------
# Anthropometry — full-size humanoid (~1.70 m standing). All lengths in meters.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Dimensions:
    # Vertical stack (home pose, foot sole on z=0)
    ankle_height: float = 0.07          # sole -> ankle joint
    shank_length: float = 0.42          # ankle -> knee
    thigh_length: float = 0.42          # knee -> hip
    hip_half_width: float = 0.105       # pelvis center -> hip joint (y)
    pelvis_to_waist: float = 0.06       # hip line -> waist yaw joint
    spine_length: float = 0.12          # waist yaw -> waist pitch (torso) joint
    waist_to_shoulder: float = 0.44     # waist -> shoulder line
    shoulder_half_width: float = 0.21   # spine -> shoulder joint (y); wider than chest so arms clear
    shoulder_to_neck: float = 0.07      # shoulder line -> neck base
    neck_length: float = 0.07           # neck base -> head pivot
    head_half_height: float = 0.115     # head pivot -> crown

    # Limb cross-sections (shell outer radius / half-extents)
    thigh_radius: float = 0.058
    shank_radius: float = 0.048
    upper_arm_radius: float = 0.042
    forearm_radius: float = 0.036
    neck_radius: float = 0.040

    # Foot
    foot_length: float = 0.24
    foot_width: float = 0.10
    foot_height: float = 0.045
    foot_forward_offset: float = 0.05   # ankle is set back from toe
    sole_thickness: float = 0.008
    toe_length: float = 0.08            # front segment, hinged + tendon-driven

    # Pelvis shell (box half-extents)
    pelvis_half: Vec3 = (0.085, 0.115, 0.075)
    # Torso / chest shell (box half-extents)
    torso_half: Vec3 = (0.095, 0.150, 0.210)
    # Hand / end-effector mitt (box half-extents)
    hand_half: Vec3 = (0.045, 0.025, 0.085)
    # Head shell (ellipsoid radii)
    head_radii: Vec3 = (0.090, 0.080, 0.115)

    # Joint housing radii — each actuator's shell must contain its motor:
    #   high AK80-64 (Ø98)  mid AK70-10 (Ø80)  low XM540 (Ø~80 diagonal)
    high_housing_r: float = 0.060
    mid_housing_r: float = 0.050
    low_housing_r: float = 0.044

    # Manufacturing
    shell_wall_mm: float = 2.5          # default molded wall
    load_wall_mm: float = 3.0           # legs / pelvis / spine
    min_mold_wall_mm: float = 2.0
    draft_deg: float = 2.0


DIMENSIONS = Dimensions()


# ---------------------------------------------------------------------------
# Structured spec model
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Geom:
    """One molded shell (or sole) on a body, in the body-local frame."""

    name: str
    type: GeomType
    material_key: str
    wall_mm: float
    role: Literal["shell", "sole"] = "shell"
    # capsule/cylinder: use fromto (p0 -> p1) + radius via size=(r,)
    fromto: tuple[float, float, float, float, float, float] | None = None
    # box: size = half-extents (hx,hy,hz); sphere: (r,); ellipsoid: (rx,ry,rz)
    size: tuple[float, ...] = ()
    pos: Vec3 = (0.0, 0.0, 0.0)


@dataclass(frozen=True)
class Joint:
    """The single actuated DoF connecting a body to its parent."""

    name: str
    index: int
    axis: Vec3
    lower_rad: float
    upper_rad: float
    home_rad: float
    group: JointGroup
    tier: ActuatorTier
    # tendon_driven joints are actuated through a cable + pulley (the toes),
    # not a motor seated at the joint. The MJCF drives them via a spatial
    # tendon actuator; mass lumps the remote winch at the joint body.
    tendon_driven: bool = False

    @property
    def torque_nm(self) -> float:
        return ACTUATORS[self.tier].peak_torque_nm

    @property
    def velocity_max_rad_s(self) -> float:
        return ACTUATORS[self.tier].velocity_max_rad_s


@dataclass(frozen=True)
class Body:
    """A link: parent-relative origin, its joint, geoms, and lumped iron."""

    name: str
    parent: str | None
    pos: Vec3                       # origin relative to parent origin (home pose)
    group: JointGroup
    geoms: tuple[Geom, ...]
    joint: Joint | None = None      # None only for the floating base (pelvis)
    actuator_tier: ActuatorTier | None = None
    is_floating_base: bool = False
    world_pos: Vec3 = (0.0, 0.0, 0.0)   # filled in by build_spec

    @property
    def actuator_mass_kg(self) -> float:
        return ACTUATORS[self.actuator_tier].mass_kg if self.actuator_tier else 0.0


@dataclass(frozen=True)
class RobotSpec:
    name: str
    profile_id: str
    bodies: tuple[Body, ...]
    dims: Dimensions

    @property
    def joints(self) -> tuple[Joint, ...]:
        return tuple(b.joint for b in self.bodies if b.joint is not None)

    @property
    def dof(self) -> int:
        return len(self.joints)

    def body(self, name: str) -> Body:
        for b in self.bodies:
            if b.name == name:
                return b
        raise KeyError(name)

    @property
    def standing_height_m(self) -> float:
        # head removed; the shoulder line is the top of the torso assembly
        torso = self.body("torso")
        return torso.world_pos[2] + self.dims.waist_to_shoulder

    @property
    def pelvis_height_m(self) -> float:
        return self.body("pelvis").world_pos[2]


# ---------------------------------------------------------------------------
# Joint range library (radians). Symmetric ranges are valid and load cleanly;
# they are anthropomorphic envelopes, not manufacturer hard stops.
# ---------------------------------------------------------------------------

_RANGES: dict[str, tuple[float, float, float]] = {
    # name suffix -> (lower, upper, home)
    "hip_pitch": (-2.0, 1.0, 0.0),
    # adduction limited so a single rolled-in leg clears the stance leg
    "hip_roll": (-0.2, 0.5, 0.0),
    "hip_yaw": (-0.8, 0.8, 0.0),
    "knee": (0.0, 2.3, 0.0),
    "ankle_pitch": (-0.9, 0.5, 0.0),
    "ankle_roll": (-0.3, 0.3, 0.0),
    "toe": (-0.6, 0.2, 0.0),
    "waist_yaw": (-1.0, 1.0, 0.0),
    "waist_pitch": (-0.5, 0.8, 0.0),
    "shoulder_pitch": (-3.0, 1.5, 0.0),
    "shoulder_roll": (-1.6, 1.6, 0.0),
    "shoulder_yaw": (-1.6, 1.6, 0.0),
    "elbow": (0.0, 2.5, 0.3),
}

_AXES: dict[str, Vec3] = {
    "pitch": (0.0, 1.0, 0.0),
    "roll": (1.0, 0.0, 0.0),
    "yaw": (0.0, 0.0, 1.0),
    "knee": (0.0, 1.0, 0.0),   # pitch
    "elbow": (0.0, 1.0, 0.0),  # pitch
    "toe": (0.0, 1.0, 0.0),    # pitch
}

_TIER: dict[str, ActuatorTier] = {
    "hip_pitch": "high",
    "hip_roll": "high",
    "hip_yaw": "mid",
    "knee": "high",
    "ankle_pitch": "mid",
    "ankle_roll": "mid",
    "waist_yaw": "mid",
    "waist_pitch": "mid",
    "shoulder_pitch": "mid",
    "shoulder_roll": "mid",
    "shoulder_yaw": "mid",
    "elbow": "mid",
    "toe": "low",
}


def _axis_for(kind: str) -> Vec3:
    if kind in _AXES:
        return _AXES[kind]
    return _AXES[kind.rsplit("_", 1)[-1]]


def _housing_r(d: Dimensions, tier: ActuatorTier) -> float:
    return {"high": d.high_housing_r, "mid": d.mid_housing_r, "low": d.low_housing_r}[tier]


def _housing(name: str, d: Dimensions, tier: ActuatorTier, material: str, wall: float) -> Geom:
    """Spherical motor housing at a joint, sized to contain that tier's motor."""
    return Geom(name=name, type="sphere", material_key=material, wall_mm=wall,
                size=(_housing_r(d, tier),))


def _joint(name: str, index: int, kind: str, group: JointGroup) -> Joint:
    lo, hi, home = _RANGES[kind]
    # Roll/yaw limits are anatomically handed: the right side mirrors the left so
    # that, e.g., adduction is limited toward the midline on both legs (the
    # Unitree G1 convention). Pitch joints are symmetric and never mirrored.
    if name.startswith("right_") and ("roll" in kind or "yaw" in kind):
        lo, hi, home = -hi, -lo, -home
    return Joint(
        name=name,
        index=index,
        axis=_axis_for(kind),
        lower_rad=lo,
        upper_rad=hi,
        home_rad=home,
        group=group,
        tier=_TIER[kind],
        tendon_driven=("toe" in kind),
    )


# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------


def build_spec(dims: Dimensions = DIMENSIONS) -> RobotSpec:
    """Construct the full erobot link/joint tree from anthropometry.

    World positions are computed by walking the tree from the floating pelvis
    so downstream tools can reason about absolute geometry (clearance sweeps,
    kinematic_tree.json) while the MJCF emits parent-relative offsets.
    """

    d = dims
    bodies: list[Body] = []
    idx = 0

    pelvis_z = d.ankle_height + d.shank_length + d.thigh_length

    def leg(side: str, sign: float) -> None:
        nonlocal idx
        load = d.load_wall_mm
        thigh_mat = "PA6_GF30"
        shank_mat = "PA6_GF30"
        # hip_pitch body sits at the hip joint
        bodies.append(Body(
            name=f"{side}_hip_pitch",
            parent="pelvis",
            pos=(0.0, sign * d.hip_half_width, 0.0),
            group="LEG",
            joint=_joint(f"{side}_hip_pitch_joint", idx, "hip_pitch", "LEG"),
            actuator_tier="high",
            geoms=(_housing(f"{side}_hip_pitch_shell", d, "high", thigh_mat, load),),
        ))
        idx += 1
        bodies.append(Body(
            name=f"{side}_hip_roll",
            parent=f"{side}_hip_pitch",
            pos=(0.0, 0.0, 0.0),
            group="LEG",
            joint=_joint(f"{side}_hip_roll_joint", idx, "hip_roll", "LEG"),
            actuator_tier="high",
            geoms=(_housing(f"{side}_hip_roll_shell", d, "high", thigh_mat, load),),
        ))
        idx += 1
        bodies.append(Body(
            name=f"{side}_hip_yaw",
            parent=f"{side}_hip_roll",
            pos=(0.0, 0.0, 0.0),
            group="LEG",
            joint=_joint(f"{side}_hip_yaw_joint", idx, "hip_yaw", "LEG"),
            actuator_tier="mid",
            geoms=(),  # actuator-only node; thigh shell lives on the knee parent
        ))
        idx += 1
        # thigh shell hangs off the hip_yaw body, down to the knee
        bodies[-1] = replace(bodies[-1], geoms=(Geom(
            name=f"{side}_thigh_shell", type="capsule", material_key=thigh_mat,
            wall_mm=load, size=(d.thigh_radius,),
            fromto=(0.0, 0.0, 0.0, 0.0, 0.0, -d.thigh_length),),))
        bodies.append(Body(
            name=f"{side}_knee",
            parent=f"{side}_hip_yaw",
            pos=(0.0, 0.0, -d.thigh_length),
            group="LEG",
            joint=_joint(f"{side}_knee_joint", idx, "knee", "LEG"),
            actuator_tier="high",
            geoms=(
                _housing(f"{side}_knee_shell", d, "high", shank_mat, load),
                Geom(
                    name=f"{side}_shank_shell", type="capsule", material_key=shank_mat,
                    wall_mm=load, size=(d.shank_radius,),
                    fromto=(0.0, 0.0, 0.0, 0.0, 0.0, -d.shank_length)),
            ),
        ))
        idx += 1
        bodies.append(Body(
            name=f"{side}_ankle_pitch",
            parent=f"{side}_knee",
            pos=(0.0, 0.0, -d.shank_length),
            group="LEG",
            joint=_joint(f"{side}_ankle_pitch_joint", idx, "ankle_pitch", "LEG"),
            actuator_tier="mid",
            geoms=(_housing(f"{side}_ankle_pitch_shell", d, "mid", "PA6_GF30", load),),
        ))
        idx += 1
        # ankle_roll carries the heel+midfoot; the toe is a separate hinged link
        foot_pos_z = -(d.ankle_height - d.foot_height / 2.0)
        sole_z = foot_pos_z - d.foot_height / 2.0 - d.sole_thickness / 2.0
        heel_x = d.foot_forward_offset - d.foot_length / 2.0
        main_len = d.foot_length - d.toe_length
        main_cx = heel_x + main_len / 2.0
        toe_hinge_x = heel_x + main_len
        bodies.append(Body(
            name=f"{side}_ankle_roll",
            parent=f"{side}_ankle_pitch",
            pos=(0.0, 0.0, 0.0),
            group="LEG",
            joint=_joint(f"{side}_ankle_roll_joint", idx, "ankle_roll", "LEG"),
            actuator_tier="mid",
            geoms=(
                _housing(f"{side}_ankle_roll_shell", d, "mid", "PA6_GF30", load),
                Geom(
                    name=f"{side}_foot_shell", type="box", material_key="PA6_GF30",
                    wall_mm=d.shell_wall_mm,
                    size=(main_len / 2.0, d.foot_width / 2.0, d.foot_height / 2.0),
                    pos=(main_cx, 0.0, foot_pos_z),
                ),
                Geom(
                    name=f"{side}_foot_sole", type="box", material_key="TPU_SHORE_A95",
                    wall_mm=d.sole_thickness * 1000.0, role="sole",
                    size=(main_len / 2.0, d.foot_width / 2.0, d.sole_thickness / 2.0),
                    pos=(main_cx, 0.0, sole_z),
                ),
            ),
        ))
        idx += 1
        # toe link — tendon/pulley driven (no motor in the toe)
        bodies.append(Body(
            name=f"{side}_toe",
            parent=f"{side}_ankle_roll",
            pos=(toe_hinge_x, 0.0, foot_pos_z),
            group="LEG",
            joint=_joint(f"{side}_toe_joint", idx, "toe", "LEG"),
            actuator_tier="low",   # lumped winch mass; driven via tendon+pulley
            geoms=(
                Geom(
                    name=f"{side}_toe_shell", type="box", material_key="PA6_GF30",
                    wall_mm=d.shell_wall_mm,
                    size=(d.toe_length / 2.0, d.foot_width / 2.0, d.foot_height / 2.0),
                    pos=(d.toe_length / 2.0, 0.0, 0.0),
                ),
                Geom(
                    name=f"{side}_toe_sole", type="box", material_key="TPU_SHORE_A95",
                    wall_mm=d.sole_thickness * 1000.0, role="sole",
                    size=(d.toe_length / 2.0, d.foot_width / 2.0, d.sole_thickness / 2.0),
                    pos=(d.toe_length / 2.0, 0.0,
                         -d.foot_height / 2.0 - d.sole_thickness / 2.0),
                ),
            ),
        ))
        idx += 1

    def arm(side: str, sign: float) -> None:
        nonlocal idx
        wall = d.shell_wall_mm
        bodies.append(Body(
            name=f"{side}_shoulder_pitch",
            parent="torso",
            pos=(0.0, sign * d.shoulder_half_width, d.waist_to_shoulder),
            group="ARM",
            joint=_joint(f"{side}_shoulder_pitch_joint", idx, "shoulder_pitch", "ARM"),
            actuator_tier="mid",
            geoms=(Geom(name=f"{side}_shoulder_shell", type="sphere",
                        material_key="PC_ABS", wall_mm=wall, size=(0.05,)),),
        ))
        idx += 1
        bodies.append(Body(
            name=f"{side}_shoulder_roll",
            parent=f"{side}_shoulder_pitch",
            pos=(0.0, 0.0, 0.0),
            group="ARM",
            joint=_joint(f"{side}_shoulder_roll_joint", idx, "shoulder_roll", "ARM"),
            actuator_tier="mid",
            geoms=(),
        ))
        idx += 1
        bodies.append(Body(
            name=f"{side}_shoulder_yaw",
            parent=f"{side}_shoulder_roll",
            pos=(0.0, 0.0, 0.0),
            group="ARM",
            joint=_joint(f"{side}_shoulder_yaw_joint", idx, "shoulder_yaw", "ARM"),
            actuator_tier="mid",
            geoms=(Geom(name=f"{side}_upper_arm_shell", type="capsule",
                        material_key="PC_ABS", wall_mm=wall, size=(d.upper_arm_radius,),
                        fromto=(0.0, 0.0, 0.0, 0.0, 0.0, -0.28)),),
        ))
        idx += 1
        bodies.append(Body(
            name=f"{side}_elbow",
            parent=f"{side}_shoulder_yaw",
            pos=(0.0, 0.0, -0.28),
            group="ARM",
            joint=_joint(f"{side}_elbow_joint", idx, "elbow", "ARM"),
            actuator_tier="mid",
            geoms=(
                _housing(f"{side}_elbow_shell", d, "mid", "PC_ABS", wall),
                Geom(name=f"{side}_forearm_shell", type="capsule",
                     material_key="PC_ABS", wall_mm=wall, size=(d.forearm_radius,),
                     fromto=(0.0, 0.0, 0.0, 0.0, 0.0, -0.26)),
            ),
        ))
        idx += 1

    # --- floating base: pelvis ---
    bodies.append(Body(
        name="pelvis",
        parent=None,
        pos=(0.0, 0.0, pelvis_z),
        group="TORSO",
        is_floating_base=True,
        geoms=(Geom(name="pelvis_shell", type="box", material_key="PA6_GF30",
                    wall_mm=d.load_wall_mm, size=d.pelvis_half),),
    ))

    # --- legs (indices 0..11) ---
    leg("left", +1.0)
    leg("right", -1.0)

    # --- waist: 2-DOF spine separating the torso from the pelvis ---
    # pelvis -> waist_yaw (spine link, twist) -> waist_pitch (torso, lean)
    bodies.append(Body(
        name="spine",
        parent="pelvis",
        pos=(0.0, 0.0, d.pelvis_to_waist),
        group="TORSO",
        joint=_joint("waist_yaw_joint", idx, "waist_yaw", "TORSO"),
        actuator_tier="mid",
        geoms=(_housing("spine_shell", d, "mid", "PA6_GF30", d.load_wall_mm),),
    ))
    idx += 1
    bodies.append(Body(
        name="torso",
        parent="spine",
        pos=(0.0, 0.0, d.spine_length),
        group="TORSO",
        joint=_joint("waist_pitch_joint", idx, "waist_pitch", "TORSO"),
        actuator_tier="mid",
        geoms=(
            _housing("torso_pitch_shell", d, "mid", "PA6_GF30", d.load_wall_mm),
            Geom(name="torso_shell", type="box", material_key="PA6_GF30",
                 wall_mm=d.load_wall_mm, size=d.torso_half,
                 pos=(0.0, 0.0, d.torso_half[2])),
        ),
    ))
    idx += 1

    # --- arms attach to the torso ---
    arm("left", +1.0)
    arm("right", -1.0)

    # --- compute world positions by walking the tree ---
    by_name = {b.name: b for b in bodies}
    resolved: dict[str, Vec3] = {}

    def world_of(name: str) -> Vec3:
        if name in resolved:
            return resolved[name]
        b = by_name[name]
        if b.parent is None:
            wp = b.pos
        else:
            px, py, pz = world_of(b.parent)
            wp = (px + b.pos[0], py + b.pos[1], pz + b.pos[2])
        resolved[name] = wp
        return wp

    placed = tuple(replace(b, world_pos=world_of(b.name)) for b in bodies)

    spec = RobotSpec(name="erobot", profile_id="erobot", bodies=placed, dims=d)
    _validate_indices(spec)
    return spec


def _validate_indices(spec: RobotSpec) -> None:
    indices = sorted(j.index for j in spec.joints)
    if indices != list(range(len(indices))):
        raise ValueError(f"joint indices must be contiguous 0..N-1, got {indices}")
    names = [j.name for j in spec.joints]
    if len(set(names)) != len(names):
        raise ValueError("duplicate joint names")
    for j in spec.joints:
        if not (j.lower_rad <= j.home_rad <= j.upper_rad):
            raise ValueError(f"{j.name}: home {j.home_rad} outside [{j.lower_rad},{j.upper_rad}]")
        if abs(j.lower_rad) > 2 * math.pi or abs(j.upper_rad) > 2 * math.pi:
            raise ValueError(f"{j.name}: limits exceed +/-2pi")


if __name__ == "__main__":
    s = build_spec()
    print(f"erobot: {s.dof} DoF, {len(s.bodies)} bodies")
    print(f"standing height: {s.standing_height_m:.3f} m, pelvis: {s.pelvis_height_m:.3f} m")
    for b in s.bodies:
        jn = b.joint.name if b.joint else ("<floating base>" if b.is_floating_base else "-")
        print(f"  {b.name:22s} parent={str(b.parent):16s} world_z={b.world_pos[2]:.3f}  joint={jn}")
