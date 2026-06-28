"""Hip subsystem — a compact 3-DOF serial gimbal under the pelvis.

The hip lets the leg pitch, roll and twist (yaw) about three axes that
intersect at a common hip centre. The serial stack, from the pelvis down:

    pelvis_bracket (fixed)
      -> HIP PITCH  journals + 2 crossed-roller bearings + pitch_yoke  (about +Y)
        -> HIP ROLL  journals + 2 crossed-roller bearings + roll_yoke   (about +X)
          -> HIP YAW shaft + 1 crossed-roller bearing + thigh_mount     (about +Z)
            -> thigh tube bolts under the thigh_mount stub.

Pitch and roll are CubeMars AK80-64 actuators (Ø98 x 40, high torque); yaw is
an AK70-10 (Ø80 x 35). Each high (pitch/roll) joint also carries a THK RB5013
crossed-roller bearing (Ø50 bore x Ø80 OD x 13 mm) modelled as an annulus.

This is a true trunnion gimbal: rather than one rod crossing the hip centre per
axis (which would have three shafts fighting for the same point), each axis is
carried on a pair of short journal stubs sitting *on* its own axis. A journal on
the rotation axis is invariant under that rotation, so the hip centre stays open
for the inner stages and every yoke can straddle the stage below it through the
full sweep.

Clearance design:
  * Pitch about +Y: the entire moving assembly is kept inside |y| < 0.052 m and
    all fixed pitch hardware lives outside |y| > 0.055 m, so the swept fan never
    shares y-extent with the bracket regardless of pitch angle.
  * Roll about +X and yaw about +Z have smaller travel and nest inside the yoke
    cheeks with generous radial gaps.
"""

from __future__ import annotations

import numpy as np

from eliza_robot.erobot.subsystems.base import (
    DOF,
    Mate,
    MechPart,
    Subsystem,
    prove_subsystem,
)

# --- canonical actuator + bearing dimensions (m) ---
AK80_R = 0.049          # CubeMars AK80-64 outer radius (Ø98)
AK80_H = 0.040          # AK80-64 height
AK70_R = 0.040          # CubeMars AK70-10 outer radius (Ø80)
AK70_H = 0.035          # AK70-10 height

# THK RB5013 crossed-roller bearing: Ø50 bore x Ø80 OD x 13 mm.
BRG_BORE_R = 0.025      # Ø50 bore  -> r_in 25
BRG_OD_R = 0.040        # Ø80 OD    -> r_out 40
BRG_H = 0.013           # 13 mm axial thickness

# Journals run in the RB5013 bore (Ø50). The declared fit is Ø49.96 (a ~40 µm
# crossed-roller running clearance); the collision *mesh* is modelled a touch
# thinner so the coarse 28-gon facets cannot clip the bore facets as the journal
# rotates inside it (the mesh is a proxy, the fit dict carries the real number).
JOURNAL_FIT_DIA = 0.04996   # Ø49.96 nominal journal (for the fit check)
JOURNAL_MESH_R = 0.0247     # collision-mesh radius (clears the bore tessellation)
CLIP_FIT_DIA = 0.0500       # circlip groove rides the journal nominal Ø50 shoulder
THIGH_R = 0.058             # thigh tube radius (the mount carries it)


def _annulus_pose(center: np.ndarray, axis: np.ndarray) -> dict:
    """Thin-fromto pose centring an annulus/bearing at `center` along `axis`."""
    a = axis / np.linalg.norm(axis)
    return {"fromto": (*(center - 1e-4 * a), *(center + 1e-4 * a))}


def build() -> Subsystem:
    YA = (0.0, 1.0, 0.0)   # pitch axis (+Y)
    XA = (1.0, 0.0, 0.0)   # roll axis  (+X)
    ZA = (0.0, 0.0, 1.0)   # yaw axis   (+Z)
    yv, xv, zv = np.array(YA), np.array(XA), np.array(ZA)
    O = (0.0, 0.0, 0.0)    # common hip centre

    # --- DOF moving groups (parts distal to each pivot) ---
    pitch_moving = (
        "pitch_journal_left", "pitch_journal_right", "pitch_circlip",
        "pitch_yoke", "pitch_yoke_saddle_left", "pitch_yoke_saddle_right",
        "roll_journal_left", "roll_journal_right", "roll_circlip",
        "roll_brg_left", "roll_brg_right", "roll_actuator", "roll_hardstop", "roll_yoke",
        "yaw_shaft", "yaw_brg", "yaw_actuator", "yaw_hardstop", "yaw_circlip",
        "thigh_mount", "thigh_stub",
    )
    roll_moving = (
        "roll_journal_left", "roll_journal_right", "roll_circlip", "roll_yoke",
        "yaw_shaft", "yaw_brg", "yaw_actuator", "yaw_hardstop", "yaw_circlip",
        "thigh_mount", "thigh_stub",
    )
    yaw_moving = ("thigh_mount", "thigh_stub")

    parts: list[MechPart] = []

    # ===================================================================
    # FIXED: pelvis bracket — bearing-cap rings concentric with the pitch axis
    # (the journals pass through their bores), tied by two outboard arms and a
    # back-set top web. Everything fixed lives outboard of |y| = 0.064 or behind
    # the swing, so the x-z pitch fan never meets it.
    # ===================================================================
    cap_y = 0.066          # bearing-cap ring plane (just outboard of the bearing)
    arm_y = 0.072          # outboard arm centre
    parts += [
        MechPart("pelvis_cap_left", "structural", "annulus", (BRG_OD_R, 0.052, 0.012),
                 _annulus_pose(np.array([0.0, cap_y, 0.0]), yv),
                 note="left pitch bearing cap (journal passes through)"),
        MechPart("pelvis_cap_right", "structural", "annulus", (BRG_OD_R, 0.052, 0.012),
                 _annulus_pose(np.array([0.0, -cap_y, 0.0]), yv),
                 note="right pitch bearing cap"),
        MechPart("pelvis_arm_left", "structural", "box", (0.030, 0.010, 0.058),
                 {"pos": (-0.004, arm_y, 0.064)},
                 note="left arm tying the cap up to the pelvis"),
        MechPart("pelvis_arm_right", "structural", "box", (0.030, 0.010, 0.058),
                 {"pos": (-0.004, -arm_y, 0.064)},
                 note="right arm tying the cap up to the pelvis"),
        MechPart("pelvis_bracket_top", "structural", "box", (0.030, arm_y + 0.010, 0.012),
                 {"pos": (-0.004, 0.0, 0.118)},
                 note="top web tying the arms to the pelvis, set back from the fan"),
    ]

    # ===================================================================
    # STAGE 1: HIP PITCH (about +Y)
    # Journals sit on the +/-Y axis (invariant under pitch) and ride the bracket
    # bearings. They are keyed to the pitch_yoke, which carries the roll stage.
    # ===================================================================
    brg_y = 0.052
    parts += [
        MechPart("pitch_journal_left", "shaft", "cylinder", (JOURNAL_MESH_R,),
                 {"fromto": (0.0, 0.034, 0.0, 0.0, 0.070, 0.0)},
                 moves_with="hip_pitch", note="pitch journal stub, rides left bearing"),
        MechPart("pitch_journal_right", "shaft", "cylinder", (JOURNAL_MESH_R,),
                 {"fromto": (0.0, -0.070, 0.0, 0.0, -0.034, 0.0)},
                 moves_with="hip_pitch", note="pitch journal stub, rides right bearing"),
        MechPart("pitch_circlip", "circlip", "annulus",
                 (JOURNAL_MESH_R, JOURNAL_MESH_R + 0.0025, 0.0015),
                 _annulus_pose(np.array([0.0, 0.060, 0.0]), yv),
                 moves_with="hip_pitch", note="retains pitch journal axially"),
        MechPart("pitch_brg_left", "bearing", "annulus", (BRG_BORE_R, BRG_OD_R, BRG_H),
                 _annulus_pose(np.array([0.0, brg_y, 0.0]), yv),
                 note="THK RB5013 crossed-roller, left"),
        MechPart("pitch_brg_right", "bearing", "annulus", (BRG_BORE_R, BRG_OD_R, BRG_H),
                 _annulus_pose(np.array([0.0, -brg_y, 0.0]), yv),
                 note="THK RB5013 crossed-roller, right"),
        MechPart("pitch_actuator", "actuator", "cylinder", (AK80_R,),
                 {"fromto": (0.0, 0.084, 0.0, 0.0, 0.084 + AK80_H, 0.0)},
                 note="CubeMars AK80-64 pitch drive (outboard, +Y)"),
        MechPart("pitch_hardstop", "hardstop", "box", (0.010, 0.012, 0.008),
                 {"pos": (0.0, cap_y, -0.052)},
                 note="pitch hard-stop bumper on the cap, below the axis"),
    ]

    # pitch_yoke: a plate set ABOVE the roll axis (z > 0) spanning the two pitch
    # journals, with two saddle pads dropping to the roll bearings. The roll
    # journals run along the x-axis at z=0, clear below the yoke plate. Kept
    # inside |y| < 0.060 so the pitch fan never meets the bracket.
    parts += [
        MechPart("pitch_yoke", "structural", "box", (0.024, 0.050, 0.009),
                 {"pos": (0.0, 0.0, 0.026)},
                 moves_with="hip_pitch",
                 note="pitch yoke plate, above the roll axis"),
        MechPart("pitch_yoke_saddle_left", "structural", "box", (0.013, 0.010, 0.020),
                 {"pos": (0.040, 0.0, 0.013)},
                 moves_with="hip_pitch",
                 note="saddle dropping to the +X roll bearing"),
        MechPart("pitch_yoke_saddle_right", "structural", "box", (0.013, 0.010, 0.020),
                 {"pos": (-0.040, 0.0, 0.013)},
                 moves_with="hip_pitch",
                 note="saddle dropping to the -X roll bearing"),
    ]

    # ===================================================================
    # STAGE 2: HIP ROLL (about +X)
    # Roll journals sit on the +/-X axis (invariant under roll), riding bearings
    # carried by the pitch-yoke saddles. They key into the roll_yoke below.
    # ===================================================================
    roll_brg_x = 0.040
    parts += [
        MechPart("roll_journal_left", "shaft", "cylinder", (JOURNAL_MESH_R,),
                 {"fromto": (0.022, 0.0, 0.0, 0.050, 0.0, 0.0)},
                 moves_with="hip_pitch", note="roll journal stub, +X"),
        MechPart("roll_journal_right", "shaft", "cylinder", (JOURNAL_MESH_R,),
                 {"fromto": (-0.050, 0.0, 0.0, -0.022, 0.0, 0.0)},
                 moves_with="hip_pitch", note="roll journal stub, -X"),
        MechPart("roll_circlip", "circlip", "annulus",
                 (JOURNAL_MESH_R, JOURNAL_MESH_R + 0.0025, 0.0015),
                 _annulus_pose(np.array([0.048, 0.0, 0.0]), xv),
                 moves_with="hip_roll", note="retains roll journal axially"),
        MechPart("roll_brg_left", "bearing", "annulus", (BRG_BORE_R, BRG_OD_R, BRG_H),
                 _annulus_pose(np.array([roll_brg_x, 0.0, 0.0]), xv),
                 moves_with="hip_pitch", note="THK RB5013 crossed-roller, roll +X"),
        MechPart("roll_brg_right", "bearing", "annulus", (BRG_BORE_R, BRG_OD_R, BRG_H),
                 _annulus_pose(np.array([-roll_brg_x, 0.0, 0.0]), xv),
                 moves_with="hip_pitch", note="THK RB5013 crossed-roller, roll -X"),
        MechPart("roll_actuator", "actuator", "cylinder", (AK80_R,),
                 {"fromto": (0.052, 0.0, 0.0, 0.052 + AK80_H, 0.0, 0.0)},
                 moves_with="hip_pitch", note="CubeMars AK80-64 roll drive (outboard, +X)"),
        MechPart("roll_hardstop", "hardstop", "box", (0.008, 0.010, 0.008),
                 {"pos": (roll_brg_x, 0.0, 0.030)},
                 moves_with="hip_pitch", note="roll hard-stop bumper, above the axis"),
    ]

    # roll_yoke: web well below the hip centre carrying the single yaw bearing.
    parts += [
        MechPart("roll_yoke", "structural", "box", (0.022, 0.022, 0.008),
                 {"pos": (0.0, 0.0, -0.030)},
                 moves_with="hip_roll",
                 note="roll yoke web carrying the yaw bearing"),
    ]

    # ===================================================================
    # STAGE 3: HIP YAW (about +Z)
    # The yaw shaft drops straight down the +Z axis into the thigh_mount.
    # ===================================================================
    yaw_brg_z = -0.052
    parts += [
        MechPart("yaw_shaft", "shaft", "cylinder", (JOURNAL_MESH_R,),
                 {"fromto": (0.0, 0.0, -0.038, 0.0, 0.0, -0.072)},
                 moves_with="hip_roll", note="hip yaw shaft, down -Z"),
        MechPart("yaw_circlip", "circlip", "annulus",
                 (JOURNAL_MESH_R, JOURNAL_MESH_R + 0.0025, 0.0015),
                 _annulus_pose(np.array([0.0, 0.0, -0.040]), zv),
                 moves_with="hip_roll", note="retains yaw shaft axially"),
        MechPart("yaw_brg", "bearing", "annulus", (BRG_BORE_R, BRG_OD_R, BRG_H),
                 _annulus_pose(np.array([0.0, 0.0, yaw_brg_z]), zv),
                 moves_with="hip_roll", note="THK RB5013 crossed-roller, yaw"),
        MechPart("yaw_actuator", "actuator", "cylinder", (AK70_R,),
                 {"fromto": (0.0, 0.0, -0.072, 0.0, 0.0, -0.072 - AK70_H)},
                 moves_with="hip_roll", note="CubeMars AK70-10 yaw drive"),
        MechPart("yaw_hardstop", "hardstop", "box", (0.010, 0.008, 0.006),
                 {"pos": (0.030, 0.0, yaw_brg_z)},
                 moves_with="hip_roll", note="yaw hard-stop bumper"),
    ]

    # thigh_mount: the Ø116 stub the thigh bolts to, plus the thigh tube root.
    parts += [
        MechPart("thigh_mount", "structural", "cylinder", (0.058,),
                 {"fromto": (0.0, 0.0, -0.100, 0.0, 0.0, -0.122)},
                 moves_with="hip_yaw", note="Ø116 thigh mounting stub"),
        MechPart("thigh_stub", "structural", "cylinder", (THIGH_R,),
                 {"fromto": (0.0, 0.0, -0.122, 0.0, 0.0, -0.165)},
                 moves_with="hip_yaw", note="thigh tube root bolted under the mount"),
    ]

    # ===================================================================
    # MATES
    # ===================================================================
    fit_jrnl = {"shaft_dia": JOURNAL_FIT_DIA, "bore_dia": 2 * BRG_BORE_R}
    fit_press = {"shaft_dia": 2 * BRG_OD_R, "bore_dia": 2 * BRG_OD_R - 1e-4}

    mates: list[Mate] = [
        # --- pitch ---
        Mate("pitch_journal_left", "pitch_brg_left", "bearing_fit", axis=YA, fit=fit_jrnl),
        Mate("pitch_journal_right", "pitch_brg_right", "bearing_fit", axis=YA, fit=fit_jrnl),
        Mate("pitch_brg_left", "pelvis_cap_left", "press_fit", axis=YA, fit=fit_press,
             note="bearing OD pressed into the left bearing cap"),
        Mate("pitch_brg_right", "pelvis_cap_right", "press_fit", axis=YA, fit=fit_press),
        Mate("pitch_journal_left", "pitch_yoke", "fixed", note="journal keyed to pitch yoke"),
        Mate("pitch_journal_right", "pitch_yoke", "fixed"),
        Mate("pitch_circlip", "pitch_journal_left", "fixed"),
        Mate("pitch_actuator", "pelvis_cap_left", "bolted",
             fit={"bolt_dia": 0.006, "hole_dia": 0.0066}, note="AK80-64 face bolts"),
        Mate("pelvis_cap_left", "pelvis_arm_left", "fixed"),
        Mate("pelvis_cap_right", "pelvis_arm_right", "fixed"),
        Mate("pelvis_arm_left", "pelvis_bracket_top", "fixed"),
        Mate("pelvis_arm_right", "pelvis_bracket_top", "fixed"),
        Mate("pelvis_cap_left", "pitch_journal_left", "revolute", axis=YA,
             note="hip pitch revolute"),
        Mate("pitch_hardstop", "pelvis_cap_left", "hardstop", axis=YA),

        # --- roll ---
        Mate("pitch_yoke", "pitch_yoke_saddle_left", "fixed"),
        Mate("pitch_yoke", "pitch_yoke_saddle_right", "fixed"),
        Mate("roll_journal_left", "roll_brg_left", "bearing_fit", axis=XA, fit=fit_jrnl),
        Mate("roll_journal_right", "roll_brg_right", "bearing_fit", axis=XA, fit=fit_jrnl),
        Mate("roll_brg_left", "pitch_yoke_saddle_left", "press_fit", axis=XA, fit=fit_press,
             note="roll bearing OD pressed into the pitch-yoke saddle"),
        Mate("roll_brg_right", "pitch_yoke_saddle_right", "press_fit", axis=XA, fit=fit_press),
        Mate("roll_journal_left", "roll_yoke", "fixed", note="journal keyed to roll yoke"),
        Mate("roll_journal_right", "roll_yoke", "fixed"),
        Mate("roll_circlip", "roll_journal_left", "fixed"),
        Mate("roll_actuator", "pitch_yoke_saddle_left", "bolted",
             fit={"bolt_dia": 0.006, "hole_dia": 0.0066}, note="AK80-64 face bolts"),
        Mate("pitch_yoke_saddle_left", "roll_journal_left", "revolute", axis=XA,
             note="hip roll revolute"),
        Mate("roll_hardstop", "roll_yoke", "hardstop", axis=XA),

        # --- yaw ---
        Mate("yaw_shaft", "yaw_brg", "bearing_fit", axis=ZA, fit=fit_jrnl),
        Mate("yaw_brg", "roll_yoke", "press_fit", axis=ZA, fit=fit_press,
             note="yaw bearing OD pressed into roll yoke"),
        Mate("yaw_shaft", "thigh_mount", "fixed", note="yaw shaft keyed to thigh mount"),
        Mate("yaw_circlip", "yaw_shaft", "fixed"),
        Mate("yaw_actuator", "roll_yoke", "bolted",
             fit={"bolt_dia": 0.005, "hole_dia": 0.0056}, note="AK70-10 face bolts"),
        Mate("roll_yoke", "yaw_shaft", "revolute", axis=ZA, note="hip yaw revolute"),
        Mate("yaw_hardstop", "thigh_mount", "hardstop", axis=ZA),
        Mate("thigh_mount", "thigh_stub", "fixed", note="thigh tube bolts under the stub"),
    ]

    dofs = (
        DOF("hip_pitch", YA, O, -2.0, 1.0, pitch_moving),
        DOF("hip_roll", XA, O, -0.2, 0.5, roll_moving),
        DOF("hip_yaw", ZA, O, -0.8, 0.8, yaw_moving),
    )

    return Subsystem(
        name="hip",
        parts=tuple(parts),
        mates=tuple(mates),
        dofs=dofs,
        note="3-DOF serial trunnion gimbal: pitch (Y) -> roll (X) -> yaw (Z), AK80/AK70 driven.",
    )


def proof() -> dict:
    return prove_subsystem(build())


if __name__ == "__main__":
    import json

    print(json.dumps(proof(), indent=2)[:1600])
