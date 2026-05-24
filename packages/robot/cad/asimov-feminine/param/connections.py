"""
Connection points per link, in each link's LOCAL frame (metres).

Derived from packages/robot/assets/profiles/asimov-1/mjcf/asimov_eliza.xml.
Every link's own joint origin is (0,0,0) — its interface to the PARENT.
`children` lists each child joint position in this link's local frame — the
interface to each CHILD. These positions are the connection points that MUST be
preserved (radii unchanged) so the assembled robot still mates correctly.

`spine` is the recommended slicing axis for the parametric pipeline.
`intent` is the feminization brief for that part.
"""

LINKS = {
    # ── Torso / core ────────────────────────────────────────────────────────
    'IMU_ORIGIN': dict(  # pelvis
        spine='z',
        children={'waist': (-0.052, 0.0, 0.074755),
                  'left_hip': (-0.052, 0.0675, -0.044045),
                  'right_hip': (-0.052, -0.0675, -0.044045)},
        intent="Pelvis: narrow the waist top, allow slight hip-socket flare at the "
               "two hip connection points. Keep waist mating ring (top) exact."),
    'WAIST_YAW': dict(  # chest + torso column
        spine='z',
        children={'neck': (-0.016599, 0.0, 0.378167),
                  'left_shoulder': (-0.026213, 0.0965, 0.261140),
                  'right_shoulder': (-0.026213, -0.0965, 0.261140)},
        intent="Chest/torso: cinch the waist (low Z), widen/round the bust band "
               "(upper-mid Z ~0.22-0.31) by pushing the FRONT (+X) sector outward "
               "via sector_scale, taper the ribcage. Sculpt a slight back arch by "
               "shifting centroid -X in the mid torso (spine_shift). DO NOT model "
               "the front 'M' cutout. Preserve neck + both shoulder connection rings."),
    'NECK_YAW': dict(
        spine='z',
        children={'neck_pitch': (0.0, 0.0, 0.037350)},
        intent="Neck base: slim slightly (0.88) for a slender neck. Preserve both ends."),
    'NECK_PITCH': dict(  # head
        spine='z',
        children={},  # head end, no child joint
        intent="Head/skull: slim jaw/cheek band (~0.88), keep cranium. Preserve neck mate (bottom)."),

    # ── Left leg ──────────────────────────────────────────────────────────────
    'LEFT_HIP_PITCH': dict(
        spine='y',
        children={'hip_roll': (0.042250, 0.040000, 0.0)},
        intent="Hip yoke: allow gentle Y flare (1.08) for hip width. Preserve both joints."),
    'LEFT_HIP_ROLL': dict(
        spine='z',
        children={'hip_yaw': (-0.042250, 0.0, -0.052000)},
        intent="Hip link: modest flare (1.05). Preserve both joints."),
    'LEFT_HIP_YAW': dict(
        spine='z',
        children={'knee': (0.0, 0.0, -0.195640)},
        intent="Upper thigh: flare the outer/upper thigh (Y 1.10) for hips, taper toward knee. Preserve hip + knee."),
    'LEFT_KNEE': dict(
        spine='z',
        children={'ankle': (0.0, 0.0, -0.294662)},
        intent="Thigh+calf shaft: slim the shaft (0.82), keep a soft calf swell. Preserve knee + ankle rings."),
    'LEFT_ANKLE_A': dict(  # ankle pitch
        spine='z',
        children={'ankle_roll': (-0.001500, 0.0, -0.010000)},
        intent="Ankle pitch: slim (0.92). Preserve both joints."),
    'LEFT_ANKLE_B': dict(  # ankle roll / foot
        spine='x',
        children={'toe': (0.102530, -0.004366, -0.006732)},
        intent="Ankle roll/foot: slim the ankle column (0.90), keep foot sole footprint. Preserve ankle + toe."),
    'LEFT_TOE': dict(
        spine='x',
        children={},
        intent="Toe/forefoot: narrow slightly (Y 0.96). Preserve heel mate."),

    # ── Left arm ────────────────────────────────────────────────────────────
    'LEFT_SHOULDER_PITCH': dict(
        spine='y',
        children={'shoulder_roll': (0.000100, 0.065353, 0.0)},
        intent="Shoulder yoke: keep as pauldron-ish (mild 0.97). Preserve both joints."),
    'LEFT_SHOULDER_ROLL': dict(
        spine='z',
        children={'shoulder_yaw': (0.0, 0.0, -0.128999)},
        intent="Upper arm (deltoid/bicep): slim (0.85) for a slender arm. Preserve both joints."),
    'LEFT_SHOULDER_YAW': dict(
        spine='z',
        children={'elbow': (0.0, 0.0, -0.096301)},
        intent="Upper arm lower: slim (0.84). Preserve both joints."),
    'LEFT_ELBOW': dict(
        spine='z',
        children={'wrist': (0.086563, 0.0, -0.072635)},
        intent="Forearm: slim (0.82), taper toward wrist. Preserve elbow + wrist."),
    'LEFT_WRIST_YAW': dict(
        spine='z',
        children={},
        intent="Wrist/hand: slim (0.80). Preserve wrist mate."),
}

# Right-side links mirror the left across Y (negate the Y of every child point
# and the Y intent direction). Build them programmatically.
def _mirror_y(spec):
    m = dict(spine=spec['spine'], intent=spec['intent'].replace('left', 'right'),
             children={})
    for k, (x, y, z) in spec['children'].items():
        m['children'][k] = (x, -y, z)
    return m

for _name in list(LINKS.keys()):
    if _name.startswith('LEFT_'):
        LINKS[_name.replace('LEFT_', 'RIGHT_')] = _mirror_y(LINKS[_name])


def reserved_levels(link_name):
    """Connection Z (or spine-axis) levels for a link: self-joint at 0 plus each
    child joint's coordinate along the link's spine axis."""
    spec = LINKS[link_name]
    axis = {'x': 0, 'y': 1, 'z': 2}[spec['spine']]
    levels = [0.0]
    for pos in spec['children'].values():
        levels.append(pos[axis])
    return sorted(set(levels))
