"""erobot FOOT + ANKLE subsystem.

A mechanically real 2-DOF ankle gimbal (universal joint) plus a cable-driven toe.

Kinematic chain (proximal -> distal), subsystem frame x=fwd, y=left, z=up (m):

    shank tube (fixed, +z)
      -> SHANK FORK (fixed) with two pillow-block arms straddling the joint in y
        -> ANKLE PITCH cross-shaft (about y) running in the fork pillow blocks
          -> ANKLE GIMBAL RING (vertical bracket keyed to the pitch shaft)
            -> ANKLE ROLL shaft (about x, set ~32 mm below the pitch axis)
              -> FOOT CLEVIS yoke on 2 roll bearings -> FOOT PLATE (heel + mid)
                -> TOE LINK on a toe PIN (about y, 2 bearings) at the ball,
                   driven by a CABLE from a shank anchor over an ankle PULLEY,
                   returned by a stand-in spring, bounded by hard stops.

The ankle pivot region sits ~0.07 m above the sole (sole plane z = 0). It is a
*stacked* gimbal: the pitch axis (y) is the upper hinge in the fork; the roll
axis (x) is the lower hinge carried by the gimbal bracket. Offsetting the two
axes vertically keeps the central cluster (pitch shaft, pulley, bracket) clear
of the foot clevis as it rolls. The foot can pitch [-0.9, 0.5] rad and roll
[-0.3, 0.3] rad with no moving part striking the fork; the toe flexes
[-0.6, 0.2] rad clear of the foot plate.
"""

from __future__ import annotations

from eliza_robot.erobot.subsystems.base import (
    DOF,
    Mate,
    MechPart,
    Subsystem,
    prove_subsystem,
)

# --- key geometry (m) ---
PITCH_Z = 0.078     # ankle PITCH axis height above sole
ROLL_Z = 0.046      # ankle ROLL axis height (lower hinge of the stacked gimbal)
PITCH_AXIS = (0.0, 1.0, 0.0)
ROLL_AXIS = (1.0, 0.0, 0.0)
TOE_AXIS = (0.0, 1.0, 0.0)
PITCH_PIVOT = (0.0, 0.0, PITCH_Z)
ROLL_PIVOT = (0.0, 0.0, ROLL_Z)

# shaft / bore diameters. Bore clearance is opened to ~0.12 mm so the coarse
# (28-section) collision facets of a moving shaft clear the facets of the fixed
# bore it spins in; still a valid running fit (<0.2 mm) per the mate checker.
PITCH_SHAFT_D = 0.012
PITCH_BORE_D = 0.01212      # +120 um clearance
ROLL_SHAFT_D = 0.010
ROLL_BORE_D = 0.01012       # +120 um clearance
TOE_SHAFT_D = 0.008
TOE_BORE_D = 0.00812        # +120 um clearance

# fork / pillow blocks
FORK_Y = 0.052              # pillow-block centre offset in y
PILLOW_OUT = 0.013          # pillow-block outer radius
PITCH_HALF = 0.057          # pitch shaft half length along y (through pillow blocks)

# gimbal bracket (vertical, links pitch shaft at top to roll shaft at bottom)
BRK_HX = 0.010
BRK_HY = 0.009
BRK_TOP = PITCH_Z
BRK_BOT = ROLL_Z

# roll shaft / foot clevis
ROLL_HALF = 0.026           # roll shaft half length along x
CLEVIS_EAR_X = 0.020        # clevis ear centre offset in x (outboard of bracket)

# foot plate (heel + mid) ~0.16 x 0.10 x 0.045
PLATE_HX = 0.080
PLATE_HY = 0.050
PLATE_HZ = 0.0125
PLATE_CZ = 0.0125           # sole at z=0, top at z=0.025

# toe
TOE_HINGE_X = 0.090         # ball-of-foot hinge, just ahead of plate front
TOE_HINGE_Z = 0.010
TOE_HX = 0.038              # toe segment ~0.08 long
# toe_link box starts just forward of the hinge pin so the solid box never
# overlaps the pin; a thin knuckle annulus bridges the box back onto the pin.
TOE_LINK_BACK = TOE_HINGE_X + 0.006
TOE_CX = TOE_LINK_BACK + TOE_HX


def build() -> Subsystem:
    parts: list[MechPart] = []
    mates: list[Mate] = []

    # ---- shank tube (fixed, extends +z above the fork) ----
    parts.append(MechPart(
        "shank_tube", "structural", "cylinder", (0.048,),
        {"fromto": (0.0, 0.0, PITCH_Z + 0.060, 0.0, 0.0, PITCH_Z + 0.200)},
        moves_with=None, note="shank tube r~0.048, extends +z",
    ))

    # ---- shank fork: yoke + two pillow-block arms straddling the joint in y ----
    parts.append(MechPart(
        "shank_fork", "structural", "box", (0.024, FORK_Y, 0.011),
        {"pos": (0.0, 0.0, PITCH_Z + 0.060)},
        moves_with=None, note="fork yoke above pivot",
    ))
    # pillow blocks = annular bosses around the pitch shaft (fixed)
    for side, yy in (("l", FORK_Y), ("r", -FORK_Y)):
        parts.append(MechPart(
            f"shank_fork_arm_{side}", "structural", "annulus",
            (PITCH_BORE_D / 2 + 0.006, PILLOW_OUT, 0.010),
            {"fromto": (0.0, yy - 0.005, PITCH_Z, 0.0, yy + 0.005, PITCH_Z)},
            moves_with=None, note=f"fork pillow block {side} (pitch bearing housing)",
        ))
    # web posts tying each pillow block up to the fork yoke (fixed, off the shaft)
    for side, yy in (("l", FORK_Y), ("r", -FORK_Y)):
        parts.append(MechPart(
            f"shank_fork_web_{side}", "structural", "box", (0.010, 0.006, 0.022),
            {"pos": (0.0, yy, PITCH_Z + 0.033)},
            moves_with=None, note=f"web post {side}",
        ))

    # ---- ankle pitch cross-shaft (about y), keyed to the bracket -> moves w/ pitch ----
    parts.append(MechPart(
        "ankle_pitch_shaft", "shaft", "cylinder", (PITCH_SHAFT_D / 2,),
        {"fromto": (0.0, -PITCH_HALF, PITCH_Z, 0.0, PITCH_HALF, PITCH_Z)},
        moves_with="ankle_pitch", note="pitch cross-shaft, axis y",
    ))
    # 2 pitch bearings inside the pillow blocks (fixed; shaft spins inside)
    parts.append(MechPart(
        "ankle_pitch_bearing", "bearing", "annulus",
        (PITCH_BORE_D / 2, PITCH_BORE_D / 2 + 0.005, 0.009),
        {"fromto": (0.0, FORK_Y - 0.0045, PITCH_Z, 0.0, FORK_Y + 0.0045, PITCH_Z)},
        moves_with=None, qty=2, note="pitch shaft bearings (pillow blocks)",
    ))

    # ---- ankle gimbal ring: vertical bracket linking the two axes (moves w/ pitch) ----
    parts.append(MechPart(
        "ankle_gimbal_ring", "structural", "box",
        (BRK_HX, BRK_HY, (BRK_TOP - BRK_BOT) / 2 + 0.004),
        {"pos": (0.0, 0.0, (BRK_TOP + BRK_BOT) / 2)},
        moves_with="ankle_pitch", note="gimbal bracket: pitch shaft -> roll shaft",
    ))

    # ---- ankle roll shaft (about x), carried by the bracket -> moves w/ pitch ----
    parts.append(MechPart(
        "ankle_roll_shaft", "shaft", "cylinder", (ROLL_SHAFT_D / 2,),
        {"fromto": (-ROLL_HALF, 0.0, ROLL_Z, ROLL_HALF, 0.0, ROLL_Z)},
        moves_with="ankle_pitch", note="roll shaft, axis x",
    ))
    # 2 roll bearings: outer race in the foot clevis ears -> move with roll
    parts.append(MechPart(
        "ankle_roll_bearing", "bearing", "annulus",
        (ROLL_BORE_D / 2, ROLL_BORE_D / 2 + 0.004, 0.006),
        {"fromto": (CLEVIS_EAR_X - 0.003, 0.0, ROLL_Z, CLEVIS_EAR_X + 0.003, 0.0, ROLL_Z)},
        moves_with="ankle_roll", qty=2, note="roll bearings (foot clevis ears)",
    ))

    # ---- foot clevis: yoke straddling the roll shaft, hanging to the plate (roll) ----
    # left + right ears = annular bosses at +/-x seating the roll bearings; their
    # bores clear the roll shaft so only the bearings contact it.
    for side, xx in (("l", CLEVIS_EAR_X), ("r", -CLEVIS_EAR_X)):
        parts.append(MechPart(
            f"foot_clevis_ear_{side}", "structural", "annulus",
            (ROLL_BORE_D / 2 + 0.004, 0.011, 0.008),
            {"fromto": (xx - 0.004, 0.0, ROLL_Z, xx + 0.004, 0.0, ROLL_Z)},
            moves_with="ankle_roll", note=f"clevis ear {side} (roll bearing seat)",
        ))
    parts.append(MechPart(
        "foot_clevis", "structural", "box",
        (CLEVIS_EAR_X + 0.007, 0.014, 0.006),
        {"pos": (0.0, 0.0, ROLL_Z - 0.018)},
        moves_with="ankle_roll", note="clevis web tying ears to the plate",
    ))

    # ---- foot plate (heel + mid), moves with roll ----
    parts.append(MechPart(
        "foot_plate", "structural", "box", (PLATE_HX, PLATE_HY, PLATE_HZ),
        {"pos": (0.0, 0.0, PLATE_CZ)},
        moves_with="ankle_roll", note="heel+mid plate ~0.16x0.10x0.045",
    ))

    # ---- TPU sole pad under the plate ----
    parts.append(MechPart(
        "sole_pad", "structural", "box", (PLATE_HX, PLATE_HY, 0.004),
        {"pos": (0.0, 0.0, -0.004)},
        material="TPU", moves_with="ankle_roll", note="TPU sole pad",
    ))

    # ---- toe link (cable driven), moves with toe_flex ----
    parts.append(MechPart(
        "toe_link", "structural", "box", (TOE_HX, PLATE_HY, 0.010),
        {"pos": (TOE_CX, 0.0, TOE_HINGE_Z)},
        moves_with="toe_flex", note="toe segment ~0.08 long at the ball",
    ))
    # knuckle annulus wrapping the toe pin (moves with toe); bore clears the pin
    parts.append(MechPart(
        "toe_knuckle", "structural", "annulus",
        (TOE_BORE_D / 2 + 0.0035, 0.008, 0.030),
        {"fromto": (TOE_HINGE_X, -0.030, TOE_HINGE_Z, TOE_HINGE_X, 0.030, TOE_HINGE_Z)},
        moves_with="toe_flex", note="toe knuckle riding the toe pin",
    ))

    # ---- toe hinge pin (about y) at the ball; fixed to the foot -> roll group ----
    parts.append(MechPart(
        "toe_pin", "shaft", "cylinder", (TOE_SHAFT_D / 2,),
        {"fromto": (TOE_HINGE_X, -PLATE_HY - 0.004, TOE_HINGE_Z,
                    TOE_HINGE_X, PLATE_HY + 0.004, TOE_HINGE_Z)},
        moves_with="ankle_roll", note="toe hinge pin, axis y",
    ))
    # toe bearings = outer race in the knuckle -> move with toe_flex
    parts.append(MechPart(
        "toe_bearing", "bearing", "annulus",
        (TOE_BORE_D / 2, TOE_BORE_D / 2 + 0.0035, 0.006),
        {"fromto": (TOE_HINGE_X, 0.030, TOE_HINGE_Z, TOE_HINGE_X, 0.042, TOE_HINGE_Z)},
        moves_with="toe_flex", qty=2, note="toe pin bearings",
    ))

    # ---- ankle pulley (torus) on the pitch axis, routes the toe cable ----
    parts.append(MechPart(
        "ankle_pulley", "pulley", "torus", (0.013, 0.0035),
        {"fromto": (0.0, -0.0045, PITCH_Z, 0.0, 0.0045, PITCH_Z)},
        moves_with="ankle_pitch", note="cable pulley about the pitch axis",
    ))

    # ---- toe cable: shank anchor -> over pulley -> toe link (excluded from FCL) ----
    parts.append(MechPart(
        "toe_cable", "cable", "cylinder", (0.0012,),
        {"fromto": (0.013, 0.0, PITCH_Z + 0.050, TOE_HINGE_X + 0.020, 0.0, TOE_HINGE_Z + 0.006)},
        material="steel_cable", moves_with=None, note="cable: anchor -> pulley -> toe",
    ))

    # ---- toe return spring stand-in (moves with the toe assembly, outboard) ----
    parts.append(MechPart(
        "toe_return_spring", "spacer", "cylinder", (0.003,),
        {"fromto": (PLATE_HX - 0.004, 0.060, 0.026,
                    TOE_HINGE_X + 0.004, 0.060, 0.026)},
        material="spring_steel", moves_with="ankle_roll", note="toe return spring stand-in",
    ))

    # ---- circlips: retain the pitch shaft against the pillow blocks ----
    parts.append(MechPart(
        "circlip", "circlip", "annulus",
        (PITCH_SHAFT_D / 2, PITCH_SHAFT_D / 2 + 0.0015, 0.0008),
        {"fromto": (0.0, FORK_Y + 0.0085, PITCH_Z, 0.0, FORK_Y + 0.0093, PITCH_Z)},
        material="spring_steel", moves_with="ankle_pitch", qty=4,
        note="shaft retaining circlips",
    ))

    # ---- hard stops ----
    parts.append(MechPart(
        "hardstop_pitch", "hardstop", "box", (0.005, 0.009, 0.004),
        {"pos": (0.0, 0.0, PITCH_Z + 0.045)},
        moves_with=None, note="pitch hard stop under the fork yoke",
    ))
    parts.append(MechPart(
        "hardstop_roll", "hardstop", "box", (0.004, 0.004, 0.004),
        {"pos": (CLEVIS_EAR_X + 0.012, 0.0, ROLL_Z),
         },
        moves_with="ankle_roll", note="roll hard stop on the clevis",
    ))

    # ---- actuators: 2x CubeMars AK70-10 (O80 x 35 mm) ----
    parts.append(MechPart(
        "ankle_pitch_actuator", "actuator", "cylinder", (0.040,),
        {"fromto": (0.0, FORK_Y + 0.016, PITCH_Z + 0.090, 0.0, FORK_Y + 0.051, PITCH_Z + 0.090)},
        material="AK70_10", moves_with=None, note="AK70-10 pitch actuator",
    ))
    parts.append(MechPart(
        "ankle_roll_actuator", "actuator", "cylinder", (0.040,),
        {"fromto": (0.0, -FORK_Y - 0.051, PITCH_Z + 0.090, 0.0, -FORK_Y - 0.016, PITCH_Z + 0.090)},
        material="AK70_10", moves_with=None, note="AK70-10 roll actuator",
    ))

    # ============================ MATES ============================
    mates.append(Mate("ankle_pitch_shaft", "ankle_pitch_bearing", "bearing_fit",
                      axis=PITCH_AXIS, fit={"shaft_dia": PITCH_SHAFT_D, "bore_dia": PITCH_BORE_D},
                      note="pitch shaft running fit in fork bearings"))
    mates.append(Mate("ankle_roll_shaft", "ankle_roll_bearing", "bearing_fit",
                      axis=ROLL_AXIS, fit={"shaft_dia": ROLL_SHAFT_D, "bore_dia": ROLL_BORE_D},
                      note="roll shaft running fit in clevis bearings"))
    mates.append(Mate("toe_pin", "toe_bearing", "bearing_fit",
                      axis=TOE_AXIS, fit={"shaft_dia": TOE_SHAFT_D, "bore_dia": TOE_BORE_D},
                      note="toe pin running fit in bearings"))

    mates.append(Mate("shank_fork", "ankle_gimbal_ring", "revolute", axis=PITCH_AXIS,
                      note="ankle pitch: fork -> gimbal bracket"))
    mates.append(Mate("ankle_gimbal_ring", "foot_clevis", "revolute", axis=ROLL_AXIS,
                      note="ankle roll: gimbal bracket -> foot clevis/plate"))
    mates.append(Mate("foot_plate", "toe_link", "revolute", axis=TOE_AXIS,
                      note="toe flex: foot plate -> toe link"))

    mates.append(Mate("foot_clevis", "foot_plate", "fixed", note="clevis bolted to plate"))
    mates.append(Mate("foot_clevis", "foot_clevis_ear_l", "fixed", note="clevis ear weld"))
    mates.append(Mate("foot_clevis", "foot_clevis_ear_r", "fixed", note="clevis ear weld"))
    mates.append(Mate("toe_cable", "toe_link", "cable", note="cable pulls the toe link"))
    mates.append(Mate("circlip", "ankle_pitch_shaft", "fixed", note="circlip retains pitch shaft"))

    mates.append(Mate("hardstop_pitch", "ankle_gimbal_ring", "hardstop", axis=PITCH_AXIS,
                      note="limits ankle pitch"))
    mates.append(Mate("hardstop_roll", "ankle_gimbal_ring", "hardstop", axis=ROLL_AXIS,
                      note="limits ankle roll"))

    mates.append(Mate("ankle_pitch_actuator", "shank_fork", "bolted",
                      fit={"bolt_dia": 0.005, "hole_dia": 0.0054}, note="AK70-10 pitch bolted to fork"))
    mates.append(Mate("ankle_roll_actuator", "shank_fork", "bolted",
                      fit={"bolt_dia": 0.005, "hole_dia": 0.0054}, note="AK70-10 roll bolted to fork"))

    # ============================ DOFs ============================
    roll_assembly = (
        "foot_clevis", "foot_clevis_ear_l", "foot_clevis_ear_r", "foot_plate",
        "sole_pad", "ankle_roll_bearing", "toe_link", "toe_pin", "toe_bearing",
        "toe_return_spring", "hardstop_roll",
    )
    pitch_moving = (
        "ankle_pitch_shaft", "ankle_gimbal_ring", "ankle_roll_shaft",
        "ankle_pulley", "circlip", *roll_assembly,
    )
    dofs = (
        DOF("ankle_pitch", PITCH_AXIS, PITCH_PIVOT, -0.9, 0.5, moving_parts=pitch_moving),
        DOF("ankle_roll", ROLL_AXIS, ROLL_PIVOT, -0.3, 0.3, moving_parts=roll_assembly),
        DOF("toe_flex", TOE_AXIS, (TOE_HINGE_X, 0.0, TOE_HINGE_Z), -0.6, 0.2,
            moving_parts=("toe_link",)),
    )

    return Subsystem(
        name="feet",
        parts=tuple(parts),
        mates=tuple(mates),
        dofs=dofs,
        note="2-DOF stacked ankle gimbal (pitch+roll) + cable-driven toe; AK70-10 actuators.",
    )


def proof() -> dict:
    return prove_subsystem(build())


if __name__ == "__main__":
    import json

    print(json.dumps(proof(), indent=2)[:1600])
