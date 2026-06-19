"""Waist subsystem: the 2-DOF spine that separates the torso from the pelvis.

The waist provides upper-body TWIST (waist_yaw about +z) and LEAN (waist_pitch
about +y, fwd/back). The yaw axis carries the entire upper body, so it rides on
a large-diameter slewing-ring bearing (Ø80 bore / Ø100 outer) rather than a thin
shaft. Above the yaw ring a vertical spine_link carries a horizontal pitch
cross-shaft on two bearings; the torso_mount plate (the chest bolts to it) tilts
on that cross-shaft.

Stack, low to high along +z (frame: x=fwd, y=left, z=up):

    pelvis_top_mount (fixed seat)
      └─ waist_yaw_ring_bearing  (slewing ring, yaws)
           └─ waist_yaw_shaft    (vertical, yaws)
                └─ spine_link     (vertical riser, yaws)
                     ├─ waist_pitch_shaft + 2× waist_pitch_bearing
                     └─ torso_mount  (pitches; chest mounts here)

Actuation: 2× CubeMars AK70-10 (Ø80×35). The yaw actuator is fixed below the
pelvis plate, coaxial with z. The pitch actuator rides on the spine_link beside
the cross-shaft.
"""

from __future__ import annotations

from eliza_robot.erobot.subsystems.base import (
    DOF,
    Mate,
    MechPart,
    Subsystem,
    prove_subsystem,
)

# --- key axial stations (m) ---
_PLATE_Z = 0.010          # pelvis top plate mid-height
_RING_Z = 0.030           # slewing-ring mid-height
_YAW_SHAFT_TOP = 0.110    # top of vertical yaw shaft
_SPINE_TOP = 0.205        # top of the spine riser / pitch axis height
_PITCH_AXIS_Z = 0.205     # cross-shaft (pitch) axis height
_TORSO_Z = 0.275          # torso_mount plate mid-height

_RING_BORE = 0.080        # slewing-ring inner Ø
_RING_OUTER = 0.100       # slewing-ring outer Ø

# Parts that ride on the yaw ring (everything above it).
_YAW_MOVING = (
    "waist_yaw_ring_bearing",
    "waist_yaw_shaft",
    "spine_link",
    "waist_pitch_shaft",
    "waist_pitch_bearing",
    "torso_mount",
    "waist_pitch_actuator",
    "hardstop_pitch",
    "circlip",
)
# Parts above the pitch axis (tilt with lean).
_PITCH_MOVING = ("torso_mount",)


def build() -> Subsystem:
    parts: tuple[MechPart, ...] = (
        # --- fixed pelvis interface ---
        MechPart(
            name="pelvis_top_mount",
            kind="structural",
            mesh_type="cylinder",
            size=(0.058,),
            pose={"fromto": (0.0, 0.0, 0.0, 0.0, 0.0, 0.020)},
            material="AL6061",
            note="Pelvis crown plate; bored seat for the slewing ring + bolt circle.",
        ),
        MechPart(
            name="waist_yaw_actuator",
            kind="actuator",
            mesh_type="cylinder",
            size=(0.040,),  # AK70-10 Ø80
            pose={"fromto": (0.0, 0.0, -0.045, 0.0, 0.0, -0.010)},  # 35mm tall, under plate
            material="AL6061",
            note="CubeMars AK70-10 driving waist_yaw; coaxial with z, fixed to pelvis.",
        ),
        MechPart(
            name="hardstop_yaw",
            kind="hardstop",
            mesh_type="box",
            size=(0.006, 0.006, 0.005),
            # On the fixed plate top, tucked just below the rotating ring (ring
            # bottom is at z=0.021), so the spinning assembly never sweeps it.
            pose={"pos": (0.050, 0.0, 0.012)},
            material="PA6_GF30",
            note="Fixed twist limit post; the yaw driver pin lands here at ±1.0 rad.",
        ),
        # --- yaw ring + shaft (ride on the ring) ---
        MechPart(
            name="waist_yaw_ring_bearing",
            kind="bearing",
            mesh_type="annulus",
            size=(_RING_BORE / 2, _RING_OUTER / 2, 0.018),
            pose={"fromto": (0.0, 0.0, _RING_Z - 1e-4, 0.0, 0.0, _RING_Z + 1e-4)},
            material="STEEL",
            note="Large-Ø slewing ring; carries the entire upper body on the yaw axis.",
        ),
        MechPart(
            name="waist_yaw_shaft",
            kind="shaft",
            mesh_type="cylinder",
            size=(_RING_BORE / 2,),  # fills the ring bore
            pose={"fromto": (0.0, 0.0, _RING_Z - 0.006, 0.0, 0.0, _YAW_SHAFT_TOP)},
            material="STEEL",
            note="Vertical yaw shaft, pressed through the slewing ring bore.",
        ),
        MechPart(
            name="circlip",
            kind="circlip",
            mesh_type="torus",
            size=(_RING_BORE / 2 + 0.0015, 0.0012),
            pose={"fromto": (0.0, 0.0, _RING_Z + 0.010, 0.0, 0.0, _RING_Z + 0.0102)},
            material="STEEL",
            qty=2,
            note="Retaining rings axially locating the yaw shaft on the slewing ring.",
        ),
        # --- vertical spine riser ---
        MechPart(
            name="spine_link",
            kind="structural",
            mesh_type="box",
            size=(0.018, 0.030, (_SPINE_TOP - _YAW_SHAFT_TOP) / 2 + 0.015),
            pose={"pos": (0.0, 0.0, (_YAW_SHAFT_TOP + _SPINE_TOP) / 2)},
            material="AL6061",
            note="Riser tying the yaw shaft to the pitch cross-shaft yoke.",
        ),
        # --- pitch cross-shaft assembly ---
        MechPart(
            name="waist_pitch_shaft",
            kind="shaft",
            mesh_type="cylinder",
            size=(0.009,),
            pose={"fromto": (0.0, -0.046, _PITCH_AXIS_Z, 0.0, 0.046, _PITCH_AXIS_Z)},
            material="STEEL",
            note="Horizontal pitch (lean) cross-shaft.",
        ),
        MechPart(
            name="waist_pitch_bearing",
            kind="bearing",
            mesh_type="annulus",
            size=(0.009, 0.016, 0.010),
            pose={"fromto": (0.0, 0.030, _PITCH_AXIS_Z, 0.0, 0.040, _PITCH_AXIS_Z)},
            material="STEEL",
            qty=2,
            note="Pitch-shaft support bearings (left + right of the yoke).",
        ),
        MechPart(
            name="waist_pitch_actuator",
            kind="actuator",
            mesh_type="cylinder",
            size=(0.040,),  # AK70-10 Ø80
            pose={"fromto": (0.0, -0.090, _PITCH_AXIS_Z, 0.0, -0.055, _PITCH_AXIS_Z)},
            material="AL6061",
            note="CubeMars AK70-10 driving waist_pitch; coaxial with the cross-shaft.",
        ),
        # --- torso interface plate (pitches) ---
        MechPart(
            name="torso_mount",
            kind="structural",
            mesh_type="box",
            size=(0.075, 0.090, 0.010),
            pose={"pos": (0.0, 0.0, _TORSO_Z)},
            material="AL6061",
            note="Plate the chest (~0.19x0.30x0.42 box) bolts to; tilts with lean.",
        ),
        MechPart(
            name="hardstop_pitch",
            kind="hardstop",
            mesh_type="box",
            size=(0.006, 0.010, 0.006),
            pose={"pos": (0.030, 0.0, _PITCH_AXIS_Z + 0.012)},
            material="PA6_GF30",
            note="Lean limit bumper near the cross-shaft.",
        ),
    )

    mates: tuple[Mate, ...] = (
        # slewing ring pressed into the pelvis plate seat
        Mate(
            "waist_yaw_ring_bearing", "pelvis_top_mount", "press_fit",
            fit={"shaft_dia": _RING_OUTER, "bore_dia": _RING_OUTER - 60e-6},
            note="Outer race pressed into the bored seat (-60 µm interference).",
        ),
        # yaw shaft through the ring bore (clearance running fit)
        Mate(
            "waist_yaw_shaft", "waist_yaw_ring_bearing", "bearing_fit",
            fit={"shaft_dia": _RING_BORE, "bore_dia": _RING_BORE + 30e-6},
            note="Yaw shaft journalled in the slewing-ring bore (+30 µm).",
        ),
        # circlip seated in the ring-bore groove
        Mate(
            "circlip", "waist_yaw_shaft", "bearing_fit",
            fit={"shaft_dia": _RING_BORE, "bore_dia": _RING_BORE + 40e-6},
            note="Retaining ring axial location.",
        ),
        # spine riser bolted onto the yaw shaft head
        Mate(
            "spine_link", "waist_yaw_shaft", "bolted",
            fit={"bolt_dia": 0.005, "hole_dia": 0.0054},
            note="Riser bolted to the yaw-shaft head flange.",
        ),
        # pitch cross-shaft in each support bearing (clearance running fit)
        Mate(
            "waist_pitch_shaft", "waist_pitch_bearing", "bearing_fit",
            fit={"shaft_dia": 0.018, "bore_dia": 0.018 + 25e-6},
            note="Cross-shaft journalled in the pitch bearings (+25 µm).",
        ),
        # pitch bearings pressed into the spine yoke
        Mate(
            "waist_pitch_bearing", "spine_link", "press_fit",
            fit={"shaft_dia": 0.032, "bore_dia": 0.032 - 40e-6},
            note="Bearing OD pressed into the yoke bores (-40 µm).",
        ),
        # torso plate bolted onto the pitch cross-shaft hub
        Mate(
            "torso_mount", "waist_pitch_shaft", "bolted",
            fit={"bolt_dia": 0.005, "hole_dia": 0.0055},
            note="Torso plate bolted to the cross-shaft hub.",
        ),
        # actuators bolted to their structures
        Mate(
            "waist_yaw_actuator", "pelvis_top_mount", "bolted",
            fit={"bolt_dia": 0.004, "hole_dia": 0.0044},
            note="Yaw motor bolted under the pelvis plate.",
        ),
        Mate(
            "waist_pitch_actuator", "spine_link", "bolted",
            fit={"bolt_dia": 0.004, "hole_dia": 0.0044},
            note="Pitch motor bolted to the spine yoke.",
        ),
        # revolute joints
        Mate(
            "waist_yaw_shaft", "pelvis_top_mount", "revolute",
            axis=(0.0, 0.0, 1.0),
            note="waist_yaw twist axis.",
        ),
        Mate(
            "torso_mount", "waist_pitch_shaft", "revolute",
            axis=(0.0, 1.0, 0.0),
            note="waist_pitch lean axis.",
        ),
        # hardstops
        Mate(
            "hardstop_yaw", "pelvis_top_mount", "hardstop",
            axis=(0.0, 0.0, 1.0),
            note="Twist travel limit.",
        ),
        Mate(
            "hardstop_pitch", "spine_link", "hardstop",
            axis=(0.0, 1.0, 0.0),
            note="Lean travel limit.",
        ),
    )

    dofs: tuple[DOF, ...] = (
        DOF(
            name="waist_yaw",
            axis=(0.0, 0.0, 1.0),
            origin=(0.0, 0.0, _RING_Z),
            lower_rad=-1.0,
            upper_rad=1.0,
            moving_parts=_YAW_MOVING,
        ),
        DOF(
            name="waist_pitch",
            axis=(0.0, 1.0, 0.0),
            origin=(0.0, 0.0, _PITCH_AXIS_Z),
            lower_rad=-0.5,
            upper_rad=0.8,
            moving_parts=_PITCH_MOVING,
        ),
    )

    return Subsystem(
        name="waist",
        parts=parts,
        mates=mates,
        dofs=dofs,
        note="2-DOF spine: large-Ø slewing-ring yaw (twist) + cross-shaft pitch (lean).",
    )


def proof() -> dict:
    return prove_subsystem(build())


if __name__ == "__main__":
    import json

    print(json.dumps(proof(), indent=2)[:1600])
