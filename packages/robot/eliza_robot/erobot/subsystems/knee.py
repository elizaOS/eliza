"""Knee subsystem: a single-axis revolute hinge (flexion about +y).

Anatomy (subsystem-local frame, x=forward, y=left, z=up, pivot at origin):

  * A thigh-side **clevis** with two cheeks straddling the pivot in y, fed by the
    thigh tube from above (+z).
  * A shank-side **yoke/tang** that rides the **knee pivot shaft** on two
    **bearings**, located axially between thrust **washers** and held by
    retaining **circlips**. The shank tube hangs below (-z) at full extension.
  * The **AK80-64** actuator sits coaxial with the pivot, bolted to the outboard
    cheek, driving the shaft.
  * Two **hard-stop bumpers** cap travel at the extension (0 rad) and flexion
    (2.3 rad ~= 132 deg) limits.

The shank swings rearward (-x) and up as it flexes; the thigh tube is set forward
and the clevis cheeks are gapped so the shank tang/tube clears them through the
whole 0..2.3 rad sweep.
"""

from __future__ import annotations

from eliza_robot.erobot.subsystems.base import (
    DOF,
    Mate,
    MechPart,
    Subsystem,
    prove_subsystem,
)

# --- principal dimensions (m) ---
PIVOT = (0.0, 0.0, 0.0)
FLEX_AXIS = (0.0, 1.0, 0.0)
FLEX_MIN = 0.0
FLEX_MAX = 2.3

_SHAFT_DIA = 0.018          # 18 mm knee pivot shaft
_SHAFT_R = _SHAFT_DIA / 2.0
_BORE_DIA = 0.018035        # +35 um running clearance for the bearing bore (spec)
# The bearing inner-race MESH radius is drawn with a larger radial gap than the
# 35 um engineering fit so that the faceted shaft and faceted bore cannot graze
# each other in the collision proof (the running fit above is the real spec).
_BEAR_BORE_MESH_R = _SHAFT_R + 0.00045
_BEAR_OUTER_R = 0.015       # 30 mm OD bearing
_BEAR_H = 0.010
_CHEEK_BORE_R = _BEAR_OUTER_R + 0.0003   # cheek bearing-housing bore (press seat)
_CHEEK_OUTER_R = 0.020                    # outer radius of each cheek ring
_THRUST_OUTER_R = 0.013
_THRUST_H = 0.0015
_CIRCLIP_MINOR = 0.0011
_TUBE_R = 0.048
_HUB_R = 0.015              # shank yoke hub outer radius

# cheeks straddle the pivot in +y / -y; the shank hub rides in the central gap.
_CHEEK_HY = 0.006           # half-thickness of each cheek ring (in y)
_GAP_HY = 0.020             # half-width of the central gap that holds the hub
_CHEEK_CY = _GAP_HY + _CHEEK_HY          # y-center of each cheek ring
_CHEEK_OUTER_Y = _GAP_HY + 2 * _CHEEK_HY  # outer y face of the cheeks


def build() -> Subsystem:
    parts: list[MechPart] = []

    # ===== thigh side (fixed / proximal) ==========================================
    # Thigh tube enters from above (+z), set forward so it stays clear of the
    # rearward-and-up shank sweep. It stops well above the pivot.
    parts.append(MechPart(
        name="thigh_tube_stub", kind="structural", mesh_type="cylinder",
        size=(_TUBE_R,), pose={"fromto": (0.044, 0.0, 0.135, 0.044, 0.0, 0.075)},
        note="thigh tube entering the knee from above (+z), set forward 44 mm",
    ))
    # Clevis body: a forward+up block bridging the thigh tube to the two cheeks.
    # Kept clear of both the pivot shaft (z=0) and the up-swung shank.
    parts.append(MechPart(
        name="thigh_clevis", kind="structural", mesh_type="box",
        size=(0.020, _CHEEK_OUTER_Y, 0.024),
        pose={"pos": (0.040, 0.0, 0.046)},
        note="clevis body joining the thigh tube to the two pivot cheeks",
    ))
    # Two cheeks: bearing-housing rings straddling the pivot in +y / -y. Modeled
    # as annuli (axis along y) so the bore is real: the shaft passes through the
    # empty center, the bearing OD seats in the bore.
    for sign, tag in ((+1.0, "left"), (-1.0, "right")):
        cy = sign * _CHEEK_CY
        parts.append(MechPart(
            name=f"clevis_cheek_{tag}", kind="structural", mesh_type="annulus",
            size=(_CHEEK_BORE_R, _CHEEK_OUTER_R, 2 * _CHEEK_HY),
            pose={"fromto": (0.0, cy - 1e-4, 0.0, 0.0, cy + 1e-4, 0.0)},
            note=f"{tag} pivot cheek: bearing-housing ring coaxial with the pivot",
        ))

    # ===== bearings (qty 2): pressed into the cheek bores, embrace the shaft =====
    parts.append(MechPart(
        name="knee_bearing", kind="bearing", mesh_type="annulus",
        size=(_BEAR_BORE_MESH_R, _BEAR_OUTER_R, _BEAR_H), qty=2,
        pose={"fromto": (0.0, _CHEEK_CY - 1e-4, 0.0, 0.0, _CHEEK_CY + 1e-4, 0.0)},
        material="bearing_steel",
        note="deep-groove ball bearing in each cheek bore (mirror at -y)",
    ))

    # ===== thrust washers (qty 2): seat between cheek inner face and the hub =====
    _washer_y = _GAP_HY + _THRUST_H
    parts.append(MechPart(
        name="thrust_washer", kind="washer", mesh_type="annulus",
        size=(_SHAFT_R + 0.0003, _THRUST_OUTER_R, _THRUST_H), qty=2,
        pose={"fromto": (0.0, _washer_y - 1e-4, 0.0, 0.0, _washer_y + 1e-4, 0.0)},
        material="PTFE_bronze",
        note="axial thrust washer between cheek and yoke hub (mirror at -y)",
    ))

    # ===== AK80-64 actuator: coaxial with the pivot, bolted to the left cheek ====
    _act_y0 = _CHEEK_OUTER_Y + 0.003
    parts.append(MechPart(
        name="knee_actuator", kind="actuator", mesh_type="cylinder",
        size=(0.049,),
        pose={"fromto": (0.0, _act_y0, 0.0, 0.0, _act_y0 + 0.040, 0.0)},
        material="AK80_64",
        note="CubeMars AK80-64 QDD motor (Ø98x40), coaxial with the pivot",
    ))

    # ===== hard-stop bumpers fixed to the clevis, limiting travel to [0, 2.3] ====
    # Both bosses sit in the central gap, just outside the hub's circular envelope
    # (radius > _HUB_R), bracketing the shank neck's front face. The neck seats on
    # them only at the travel limits; through 0..2.3 it swings clear between them.
    # Extension stop: forward-low boss, just ahead of the neck's front face at
    # 0 rad. Over-extension (theta < 0) would drive the neck into it.
    parts.append(MechPart(
        name="hardstop_extension", kind="hardstop", mesh_type="box",
        size=(0.003, _GAP_HY - 0.004, 0.006), pose={"pos": (0.0075, 0.0, -0.030)},
        material="TPU",
        note="extension hard-stop bumper (0 rad limit)",
    ))
    # Flexion stop: upper-forward boss the neck's front-upper corner seats against
    # just past 2.3 rad. Beyond the hub envelope and inside the fat tube clearance.
    parts.append(MechPart(
        name="hardstop_flexion", kind="hardstop", mesh_type="box",
        size=(0.003, _GAP_HY - 0.004, 0.005), pose={"pos": (0.020, 0.0, 0.006)},
        material="TPU",
        note="flexion hard-stop bumper (2.3 rad limit)",
    ))

    # ===== shank side (moves with knee_flex) =====================================
    # Knee pivot shaft: spins with the shank (keyed to the hub, driven by the
    # actuator output). It lies on the rotation axis, so it is rotation-invariant.
    # It stops just shy of the actuator face on +y and just past the right cheek.
    _shaft_y = _act_y0 - 0.001
    parts.append(MechPart(
        name="knee_pivot_shaft", kind="shaft", mesh_type="cylinder",
        size=(_SHAFT_R,),
        pose={"fromto": (0.0, -_CHEEK_OUTER_Y - 0.002, 0.0, 0.0, _shaft_y, 0.0)},
        material="42CrMo4", moves_with="knee_flex",
        note="hardened pivot shaft; keyed to the hub, driven by the actuator",
    ))
    # Retaining circlips (qty 2): external rings in shaft grooves; spin with shaft.
    _clip_y = _CHEEK_OUTER_Y + 0.001
    parts.append(MechPart(
        name="circlip", kind="circlip", mesh_type="torus",
        size=(_SHAFT_R + 0.0006, _CIRCLIP_MINOR), qty=2,
        pose={"fromto": (0.0, _clip_y - 1e-4, 0.0, 0.0, _clip_y + 1e-4, 0.0)},
        material="spring_steel", moves_with="knee_flex",
        note="external retaining ring locating the shaft axially (mirror at -y)",
    ))
    # Shank yoke hub: a sleeve clamped on the shaft, in the central gap. On the
    # axis, so rotation-invariant; the shank neck/tube hangs off its lower lobe.
    parts.append(MechPart(
        name="shank_yoke", kind="structural", mesh_type="annulus",
        size=(_SHAFT_R + 0.0006, _HUB_R, 2 * _GAP_HY - 0.004),
        pose={"fromto": (0.0, -_GAP_HY + 0.002, 0.0, 0.0, _GAP_HY - 0.002, 0.0)},
        moves_with="knee_flex",
        note="shank yoke hub clamped on the pivot shaft, in the central gap",
    ))
    # Shank neck: a slim tang bridging the hub down to the fat tube, riding in the
    # central gap so it never reaches the cheeks. Rearward-set (-x).
    parts.append(MechPart(
        name="shank_neck", kind="structural", mesh_type="box",
        size=(0.012, _GAP_HY - 0.003, 0.024),
        pose={"pos": (-0.010, 0.0, -0.034)},
        moves_with="knee_flex",
        note="slim shank neck linking the yoke hub to the shank tube",
    ))
    # Shank tube hangs straight down at full extension (0 rad). Its top is set well
    # below the pivot and rearward (-x) so its rear-and-up flexion arc clears the
    # forward thigh tube/clevis and the side-mounted actuator.
    parts.append(MechPart(
        name="shank_tube_stub", kind="structural", mesh_type="cylinder",
        size=(_TUBE_R,), pose={"fromto": (-0.012, 0.0, -0.062, -0.012, 0.0, -0.130)},
        moves_with="knee_flex",
        note="shank tube leaving the knee downward (-z) at full extension",
    ))

    # --- mates ---
    # Load path: shaft -> bearing inner race -> bearing OD -> cheek bore -> clevis.
    # The hub is keyed to the shaft; both rotate as the single revolute joint.
    mates = [
        Mate("knee_pivot_shaft", "knee_bearing", "bearing_fit",
             fit={"shaft_dia": _SHAFT_DIA, "bore_dia": _BORE_DIA},
             note="shaft journals running in the two bearing inner races (+35 um)"),
        Mate("knee_bearing", "clevis_cheek_left", "press_fit",
             fit={"shaft_dia": 2 * _BEAR_OUTER_R, "bore_dia": 2 * _BEAR_OUTER_R - 2.4e-5},
             note="left bearing OD pressed into the left cheek housing bore"),
        Mate("knee_bearing", "clevis_cheek_right", "press_fit",
             fit={"shaft_dia": 2 * _BEAR_OUTER_R, "bore_dia": 2 * _BEAR_OUTER_R - 2.4e-5},
             note="right bearing OD pressed into the right cheek housing bore"),
        Mate("knee_pivot_shaft", "shank_yoke", "press_fit",
             fit={"shaft_dia": _SHAFT_DIA, "bore_dia": _SHAFT_DIA - 1.2e-5},
             note="yoke hub keyed/pressed onto the shaft (rotates with it)"),
        Mate("shank_yoke", "clevis_cheek_left", "revolute", axis=FLEX_AXIS,
             note="the single knee revolute joint (shank hub about the clevis)"),
        Mate("thigh_clevis", "knee_actuator", "bolted",
             fit={"bolt_dia": 0.005, "hole_dia": 0.0054},
             note="M5 bolts fixing the actuator stator housing to the clevis"),
        Mate("knee_actuator", "knee_pivot_shaft", "bolted",
             fit={"bolt_dia": 0.006, "hole_dia": 0.0064},
             note="actuator output hub clamped to the shaft end"),
        Mate("knee_pivot_shaft", "circlip", "running_fit",
             fit={"shaft_dia": _SHAFT_DIA - 0.0006, "bore_dia": _SHAFT_DIA - 0.0006 + 4e-5},
             note="retaining circlips seated in the shaft groove"),
        Mate("clevis_cheek_left", "thrust_washer", "fixed",
             note="thrust washers seat against the cheek inner faces"),
        Mate("shank_yoke", "hardstop_flexion", "hardstop", axis=FLEX_AXIS,
             note="hub front lobe meets the flexion bumper at 2.3 rad"),
        Mate("shank_yoke", "hardstop_extension", "hardstop", axis=FLEX_AXIS,
             note="hub front lobe meets the extension bumper at 0 rad"),
    ]

    # --- DOF ---
    dofs = [
        DOF(name="knee_flex", axis=FLEX_AXIS, origin=PIVOT,
            lower_rad=FLEX_MIN, upper_rad=FLEX_MAX,
            moving_parts=("knee_pivot_shaft", "circlip", "shank_yoke",
                          "shank_neck", "shank_tube_stub")),
    ]

    return Subsystem(
        name="knee",
        parts=tuple(parts),
        mates=tuple(mates),
        dofs=tuple(dofs),
        note="single-axis revolute knee (flexion 0..2.3 rad) driven by AK80-64",
    )


def proof() -> dict:
    return prove_subsystem(build())


if __name__ == "__main__":
    import json

    print(json.dumps(proof(), indent=2)[:1600])
