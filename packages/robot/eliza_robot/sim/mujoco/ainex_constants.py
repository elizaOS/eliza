"""Constants for AiNex MuJoCo environment (following Playground OP3 pattern)."""

from pathlib import Path

from eliza_robot.sim.mujoco import _resolve_mjcf

# Kept for backward-compat callers; points at the package dir so any
# residual ``ROOT_PATH / "<some>.xml"`` lookups still find the local copy.
ROOT_PATH = Path(__file__).resolve().parent

# Scene XMLs (resolved via the profile-aware helper).
SCENE_XML = _resolve_mjcf("ainex.xml")                          # Full mesh version (for rendering)
SCENE_MJX_XML = _resolve_mjcf("ainex_mjx.xml")                  # MJX-optimized (primitive collisions + mesh visuals)
SCENE_PRIMITIVES_XML = _resolve_mjcf("ainex_primitives.xml")    # Pure primitives (fastest, for training)
SCENE_REALISTIC_XML = _resolve_mjcf("ainex_primitives_realistic.xml")  # Realistic mass/force limits
SCENE_GRASP_XML = _resolve_mjcf("ainex_grasp_scene.xml")        # Primitives + graspable object (for manipulation)

# Foot sites for contact detection and clearance tracking
FEET_SITES = [
    "left_foot",
    "right_foot",
]

# Foot geoms for floor contact detection
LEFT_FEET_GEOMS = [
    "l_foot1",
    "l_foot2",
]
RIGHT_FEET_GEOMS = [
    "r_foot1",
    "r_foot2",
]

# Root body name
ROOT_BODY = "body_link"

# Sensor names (matching ainex.xml)
GRAVITY_SENSOR = "upvector"
GLOBAL_LINVEL_SENSOR = "global_linvel"
GLOBAL_ANGVEL_SENSOR = "global_angvel"
LOCAL_LINVEL_SENSOR = "local_linvel"
ACCELEROMETER_SENSOR = "accelerometer"
GYRO_SENSOR = "gyro"

# Joint groups
LEG_JOINT_NAMES = (
    "r_hip_yaw", "r_hip_roll", "r_hip_pitch", "r_knee", "r_ank_pitch", "r_ank_roll",
    "l_hip_yaw", "l_hip_roll", "l_hip_pitch", "l_knee", "l_ank_pitch", "l_ank_roll",
)

ARM_JOINT_NAMES = (
    "r_sho_pitch", "r_sho_roll", "r_el_pitch", "r_el_yaw", "r_gripper",
    "l_sho_pitch", "l_sho_roll", "l_el_pitch", "l_el_yaw", "l_gripper",
)

HEAD_JOINT_NAMES = (
    "head_pan", "head_tilt",
)

# All actuated joints in actuator order
ALL_JOINT_NAMES = LEG_JOINT_NAMES + HEAD_JOINT_NAMES + ARM_JOINT_NAMES

# Number of actuators per group
NUM_LEG_ACTUATORS = 12
NUM_HEAD_ACTUATORS = 2
NUM_ARM_ACTUATORS = 10
NUM_ACTUATORS = 24

# Entity body names for perception training
# These bodies exist in ainex_primitives.xml as static obstacles
ENTITY_BODY_NAMES = (
    "entity_box_0",
    "entity_box_1",
    "entity_cylinder_0",
    "entity_person_0",
)

# Entity types matching perception/entity_slots/slot_config.py EntityType
# 0=UNKNOWN, 1=PERSON, 2=OBJECT, 3=LANDMARK, 4=FURNITURE, 5=DOOR
ENTITY_BODY_TYPES = (
    2,  # entity_box_0 -> OBJECT
    2,  # entity_box_1 -> OBJECT
    4,  # entity_cylinder_0 -> FURNITURE
    1,  # entity_person_0 -> PERSON
)

# Entity sizes (width, height, depth) in meters
ENTITY_BODY_SIZES = (
    (0.30, 0.30, 0.30),    # box 0
    (0.30, 0.30, 0.30),    # box 1
    (0.20, 0.50, 0.20),    # cylinder
    (0.40, 1.70, 0.30),    # person capsule
)
