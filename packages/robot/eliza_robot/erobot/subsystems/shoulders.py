"""Shoulder subsystem: a 3-DOF serial gimbal mounting the arm on the torso side.

The shoulder is a compact serial gimbal so the upper arm can pitch, roll and
twist (yaw). Three near-coincident, mutually perpendicular axes are stacked
down the shoulder so the arm hangs below:

  * **pitch** about the body ``y`` axis  [-3.0 .. +1.5 rad]   (top)
  * **roll**  about the body ``x`` axis  [-1.6 .. +1.6 rad]   (middle)
  * **yaw**   about the body ``z`` axis  [-1.6 .. +1.6 rad]   (bottom)

Mechanical stack (proximal -> distal):

    torso_shoulder_bracket  (fixed to torso)
      -> SHOULDER PITCH shaft (y) + 2 bearings -> pitch_yoke
        -> SHOULDER ROLL shaft (x) + 2 bearings -> roll_yoke
          -> SHOULDER YAW shaft (z) + 1 bearing -> upper_arm_mount

Each stage is driven by a CubeMars AK70-10 (Ø80x35), rides a pair of annulus
journal bearings on a stub shaft, and has a hard-stop bumper and a retaining
circlip. The three axes are offset slightly along ``-z`` (pitch at the top,
then roll, then yaw) so the rotating shafts never intersect; each stage is
radially compact about its own axis so it clears the previous stage across the
full (wide) rotation range.

Frame: subsystem-local, right-handed, x=forward, y=left, z=up. The torso is on
the +y side; the upper arm hangs down -z.
"""

from __future__ import annotations

from eliza_robot.erobot.subsystems.base import (
    DOF,
    Mate,
    MechPart,
    Subsystem,
    prove_subsystem,
)

# --- shaft / bore diameters (m) ---
# Bores carry a wide running clearance (~140-160 um diametral). The collision
# proof tessellates cylinders/annuli at 28 sections; a faceted shaft's vertices
# sit ~0.6 % of radius proud of nominal, so a tight 20-40 um bore would clip the
# shaft as it spins. A ~150 um clearance keeps the faceted shaft clear of the
# faceted bore while staying within a real running-fit (still < 200 um).
_PITCH_SHAFT_DIA = 0.020
_PITCH_BORE_DIA = 0.02016      # +160 um clearance
_ROLL_SHAFT_DIA = 0.016
_ROLL_BORE_DIA = 0.016150      # +150 um
_YAW_SHAFT_DIA = 0.014
_YAW_BORE_DIA = 0.014150       # +150 um

_BOLT_DIA = 0.005
_BOLT_HOLE = 0.0053

# AK70-10 actuator envelope (Ø80 x 35)
_AK_R = 0.040
_AK_H = 0.035

# DOF ranges (rad)
_PITCH_LO, _PITCH_HI = -3.0, 1.5
_ROLL_LO, _ROLL_HI = -1.6, 1.6
_YAW_LO, _YAW_HI = -1.6, 1.6

# axis heights (z) — stacked down the shoulder, near-coincident in x/y
_Z_PITCH = 0.040
_Z_ROLL = 0.0
_Z_YAW_TOP = 0.0           # yaw axis runs vertically through center

# pivots (each DOF rotates about its own axis line)
_PITCH_PIVOT = (0.0, 0.0, _Z_PITCH)
_ROLL_PIVOT = (0.0, 0.0, _Z_ROLL)
_YAW_PIVOT = (0.0, 0.0, _Z_ROLL)

Y = (0.0, 1.0, 0.0)
X = (1.0, 0.0, 0.0)
Z = (0.0, 0.0, 1.0)


def _bearing(name, center, axis, r_in, r_out, height, moves_with, note=""):
    """Annulus journal bearing centered at `center`, axis along unit `axis`."""
    cx, cy, cz = center
    ax, ay, az = axis
    half = height / 2.0
    fromto = (cx - half * ax, cy - half * ay, cz - half * az,
              cx + half * ax, cy + half * ay, cz + half * az)
    return MechPart(name=name, kind="bearing", mesh_type="annulus",
                    size=(r_in, r_out, height), pose={"fromto": fromto},
                    moves_with=moves_with, note=note)


# Parts that twist with the yaw output (rigidly fixed to the upper-arm mount).
# The yaw shaft is fixed to the mount and spins inside the (roll-borne) bearing.
_YAW_MOVERS = (
    "yaw_shaft", "upper_arm_mount", "yaw_circlip",
)
# Parts carried by the roll yoke (everything distal to the roll axis). Includes
# the whole yaw stage plus the yaw bearing/actuator/hardstop fixed to roll_yoke.
_ROLL_MOVERS = (
    "roll_yoke", "roll_circlip",
    "yaw_bearing", "yaw_actuator", "yaw_hardstop",
    *_YAW_MOVERS,
)
# Parts carried by the pitch yoke (everything distal to the pitch axis). Includes
# the pitch shaft itself (clamped in the yoke, spinning in the fixed clevis
# bearings) plus the whole roll + yaw stack.
_PITCH_MOVERS = (
    "pitch_shaft", "pitch_yoke", "pitch_circlip",
    "roll_shaft", "roll_bearing_pos", "roll_bearing_neg", "roll_actuator",
    "roll_hardstop",
    *_ROLL_MOVERS,
)


def build() -> Subsystem:
    parts: list[MechPart] = []

    # ===============================================================
    # FIXED — torso shoulder bracket.
    # A clevis on the +y (outboard) torso wall straddling the pitch
    # axis (y) at z=_Z_PITCH. A back plate bolts to the torso; two ring
    # bosses (annuli concentric with the pitch shaft, bores clearing it)
    # carry the pitch bearings, joined to the back plate by a top rail
    # routed above the shaft. Everything sits at +y / up high so the
    # pitching arm (hanging -z near the centerline) clears it.
    # ===============================================================
    _CLEVIS_OD = 0.024
    parts.append(MechPart(
        name="torso_shoulder_bracket", kind="structural", mesh_type="box",
        size=(0.028, 0.012, 0.030), pose={"pos": (0.0, 0.120, _Z_PITCH)},
        note="bolts to torso side; root of the gimbal"))
    # top rail joining back plate to the bearing bosses (above the shaft)
    parts.append(MechPart(
        name="pitch_clevis_rail", kind="structural", mesh_type="box",
        size=(0.024, 0.040, 0.008),
        pose={"pos": (0.0, 0.075, _Z_PITCH + 0.026)},
        note="rail tying clevis bosses to the back plate, routed over the shaft"))
    # ring bosses concentric with the pitch shaft (bore clears the shaft)
    parts.append(_bearing("pitch_clevis_pos", (0.0, 0.086, _Z_PITCH), Y,
                          _PITCH_SHAFT_DIA / 2 + 0.0015, _CLEVIS_OD, 0.012,
                          moves_with=None, note="clevis boss carrying pitch bearing +y"))
    parts.append(_bearing("pitch_clevis_neg", (0.0, 0.048, _Z_PITCH), Y,
                          _PITCH_SHAFT_DIA / 2 + 0.0015, _CLEVIS_OD, 0.012,
                          moves_with=None, note="clevis boss carrying pitch bearing -y"))

    # PITCH shaft along y at z=_Z_PITCH
    parts.append(MechPart(
        name="pitch_shaft", kind="shaft", mesh_type="cylinder",
        size=(_PITCH_SHAFT_DIA / 2,),
        pose={"fromto": (0.0, 0.022, _Z_PITCH, 0.0, 0.094, _Z_PITCH)},
        moves_with="shoulder_pitch", note="pitch axis (y)"))
    parts.append(_bearing("pitch_bearing_pos", (0.0, 0.086, _Z_PITCH), Y,
                          _PITCH_BORE_DIA / 2, _PITCH_BORE_DIA / 2 + 0.003, 0.011,
                          moves_with=None, note="pitch bearing +y"))
    parts.append(_bearing("pitch_bearing_neg", (0.0, 0.048, _Z_PITCH), Y,
                          _PITCH_BORE_DIA / 2, _PITCH_BORE_DIA / 2 + 0.003, 0.011,
                          moves_with=None, note="pitch bearing -y"))
    parts.append(MechPart(
        name="pitch_actuator", kind="actuator", mesh_type="cylinder",
        size=(_AK_R,),
        pose={"fromto": (0.0, 0.100, _Z_PITCH, 0.0, 0.100 + _AK_H, _Z_PITCH)},
        note="AK70-10 driving pitch (coaxial y)"))
    parts.append(MechPart(
        name="pitch_hardstop", kind="hardstop", mesh_type="box",
        size=(0.006, 0.008, 0.005), pose={"pos": (0.0, 0.067, _Z_PITCH + 0.024)},
        note="pitch hard-stop bumper (rides under the rail)"))

    # ===============================================================
    # PITCH OUTPUT — pitch_yoke: a thin arm hanging from the pitch axis
    # at z=_Z_PITCH down to the roll axis at z=0, where it grips the roll
    # shaft (x). Compact about y: lives in a thin x/y band near the
    # vertical centerline so pitching keeps it clear of the fixed clevis.
    # ===============================================================
    parts.append(MechPart(
        name="pitch_yoke", kind="structural", mesh_type="box",
        size=(0.014, 0.014, 0.026),
        pose={"pos": (0.0, 0.030, _Z_PITCH - 0.022)},
        moves_with="shoulder_pitch", note="pitch arm: pitch axis -> roll shaft"))
    parts.append(_bearing("pitch_circlip", (0.0, 0.030, _Z_PITCH), Y,
                          _PITCH_SHAFT_DIA / 2, _PITCH_SHAFT_DIA / 2 + 0.002, 0.0015,
                          moves_with="shoulder_pitch", note="pitch shaft circlip"))

    # ROLL shaft along x at z=0
    parts.append(MechPart(
        name="roll_shaft", kind="shaft", mesh_type="cylinder",
        size=(_ROLL_SHAFT_DIA / 2,),
        pose={"fromto": (-0.052, 0.0, _Z_ROLL, 0.052, 0.0, _Z_ROLL)},
        moves_with="shoulder_pitch", note="roll axis (x)"))
    parts.append(_bearing("roll_bearing_pos", (0.040, 0.0, _Z_ROLL), X,
                          _ROLL_BORE_DIA / 2, _ROLL_BORE_DIA / 2 + 0.005, 0.009,
                          moves_with="shoulder_pitch", note="roll bearing +x"))
    parts.append(_bearing("roll_bearing_neg", (-0.040, 0.0, _Z_ROLL), X,
                          _ROLL_BORE_DIA / 2, _ROLL_BORE_DIA / 2 + 0.005, 0.009,
                          moves_with="shoulder_pitch", note="roll bearing -x"))
    parts.append(MechPart(
        name="roll_actuator", kind="actuator", mesh_type="cylinder",
        size=(_AK_R,),
        pose={"fromto": (0.052, 0.0, _Z_ROLL, 0.052 + _AK_H, 0.0, _Z_ROLL)},
        moves_with="shoulder_pitch", note="AK70-10 driving roll (coaxial x)"))
    parts.append(MechPart(
        name="roll_hardstop", kind="hardstop", mesh_type="box",
        size=(0.006, 0.006, 0.008), pose={"pos": (0.030, 0.0, _Z_ROLL + 0.016)},
        moves_with="shoulder_pitch", note="roll hard-stop bumper"))

    # ===============================================================
    # ROLL OUTPUT — roll_yoke: grips the yaw shaft (z), reaching from the
    # roll axis (x, z=0) down toward the upper-arm mount. Compact about x.
    # ===============================================================
    parts.append(MechPart(
        name="roll_yoke", kind="structural", mesh_type="box",
        size=(0.013, 0.013, 0.022),
        pose={"pos": (0.0, 0.0, _Z_ROLL - 0.020)},
        moves_with="shoulder_roll", note="roll arm: roll axis -> yaw shaft"))
    parts.append(_bearing("roll_circlip", (0.030, 0.0, _Z_ROLL), X,
                          _ROLL_SHAFT_DIA / 2, _ROLL_SHAFT_DIA / 2 + 0.002, 0.0015,
                          moves_with="shoulder_roll", note="roll shaft circlip"))

    # YAW shaft along z, descending into the arm
    parts.append(MechPart(
        name="yaw_shaft", kind="shaft", mesh_type="cylinder",
        size=(_YAW_SHAFT_DIA / 2,),
        pose={"fromto": (0.0, 0.0, _Z_ROLL - 0.012, 0.0, 0.0, _Z_ROLL - 0.070)},
        moves_with="shoulder_yaw", note="yaw/twist axis (z)"))
    parts.append(_bearing("yaw_bearing", (0.0, 0.0, _Z_ROLL - 0.046), Z,
                          _YAW_BORE_DIA / 2, _YAW_BORE_DIA / 2 + 0.005, 0.009,
                          moves_with="shoulder_roll", note="yaw bearing"))
    parts.append(MechPart(
        name="yaw_actuator", kind="actuator", mesh_type="cylinder",
        size=(_AK_R,),
        pose={"fromto": (0.0, 0.0, _Z_ROLL - 0.034, 0.0, 0.0, _Z_ROLL - 0.034 - _AK_H)},
        moves_with="shoulder_roll", note="AK70-10 driving yaw (coaxial z)"))
    parts.append(MechPart(
        name="yaw_hardstop", kind="hardstop", mesh_type="box",
        size=(0.006, 0.006, 0.006), pose={"pos": (0.012, 0.0, _Z_ROLL - 0.030)},
        moves_with="shoulder_roll", note="yaw hard-stop bumper"))

    # ===============================================================
    # YAW OUTPUT — upper_arm_mount: the ~Ø96 stub the upper arm bolts
    # onto, hanging below the gimbal. Concentric with z => yaw-invariant.
    # ===============================================================
    parts.append(MechPart(
        name="upper_arm_mount", kind="structural", mesh_type="cylinder",
        size=(0.048,),
        pose={"fromto": (0.0, 0.0, _Z_ROLL - 0.078, 0.0, 0.0, _Z_ROLL - 0.108)},
        moves_with="shoulder_yaw", note="Ø96 stub the upper arm bolts to"))
    parts.append(_bearing("yaw_circlip", (0.0, 0.0, _Z_ROLL - 0.064), Z,
                          _YAW_SHAFT_DIA / 2, _YAW_SHAFT_DIA / 2 + 0.002, 0.0015,
                          moves_with="shoulder_yaw", note="yaw shaft circlip"))

    # ===============================================================
    # MATES
    # ===============================================================
    mates: list[Mate] = [
        Mate("pitch_shaft", "pitch_bearing_pos", "bearing_fit", axis=Y,
             fit={"shaft_dia": _PITCH_SHAFT_DIA, "bore_dia": _PITCH_BORE_DIA}),
        Mate("pitch_shaft", "pitch_bearing_neg", "bearing_fit", axis=Y,
             fit={"shaft_dia": _PITCH_SHAFT_DIA, "bore_dia": _PITCH_BORE_DIA}),
        Mate("roll_shaft", "roll_bearing_pos", "bearing_fit", axis=X,
             fit={"shaft_dia": _ROLL_SHAFT_DIA, "bore_dia": _ROLL_BORE_DIA}),
        Mate("roll_shaft", "roll_bearing_neg", "bearing_fit", axis=X,
             fit={"shaft_dia": _ROLL_SHAFT_DIA, "bore_dia": _ROLL_BORE_DIA}),
        Mate("yaw_shaft", "yaw_bearing", "bearing_fit", axis=Z,
             fit={"shaft_dia": _YAW_SHAFT_DIA, "bore_dia": _YAW_BORE_DIA}),
        # revolute joints
        Mate("torso_shoulder_bracket", "pitch_yoke", "revolute", axis=Y,
             note="shoulder pitch"),
        Mate("pitch_yoke", "roll_yoke", "revolute", axis=X, note="shoulder roll"),
        Mate("roll_yoke", "upper_arm_mount", "revolute", axis=Z, note="shoulder yaw"),
        # actuator bolt-downs
        Mate("torso_shoulder_bracket", "pitch_actuator", "bolted",
             fit={"bolt_dia": _BOLT_DIA, "hole_dia": _BOLT_HOLE}),
        Mate("pitch_yoke", "roll_actuator", "bolted",
             fit={"bolt_dia": _BOLT_DIA, "hole_dia": _BOLT_HOLE}),
        Mate("roll_yoke", "yaw_actuator", "bolted",
             fit={"bolt_dia": _BOLT_DIA, "hole_dia": _BOLT_HOLE}),
        # hard stops
        Mate("pitch_yoke", "pitch_hardstop", "hardstop", axis=Y),
        Mate("roll_yoke", "roll_hardstop", "hardstop", axis=X),
        Mate("upper_arm_mount", "yaw_hardstop", "hardstop", axis=Z),
    ]

    dofs = (
        DOF("shoulder_pitch", Y, _PITCH_PIVOT, _PITCH_LO, _PITCH_HI, _PITCH_MOVERS),
        DOF("shoulder_roll", X, _ROLL_PIVOT, _ROLL_LO, _ROLL_HI, _ROLL_MOVERS),
        DOF("shoulder_yaw", Z, _YAW_PIVOT, _YAW_LO, _YAW_HI, _YAW_MOVERS),
    )

    return Subsystem(name="shoulder", parts=tuple(parts), mates=tuple(mates),
                     dofs=dofs, note="3-DOF serial gimbal: pitch(y) roll(x) yaw(z)")


def proof() -> dict:
    return prove_subsystem(build())


if __name__ == "__main__":
    import json
    print(json.dumps(proof(), indent=2)[:1600])
