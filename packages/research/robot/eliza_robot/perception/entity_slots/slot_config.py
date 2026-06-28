"""Entity slot constants for RL observation encoding.

8 slots x 19 dims = 152 total entity observation dims.

Per slot (19 dims):
- entity_type one-hot: 6 (unknown, person, object, landmark, furniture, door)
- position xyz robot-frame: 3 (normalized by max_distance=5m to [-1,1])
- velocity xyz robot-frame: 3 (normalized by max_velocity=2 m/s)
- size whd: 3 (normalized by max_size=2m)
- confidence: 1
- recency: 1 (seconds since last seen / recency_horizon)
- bearing: 2 (sin/cos of angle to entity)
"""

from enum import IntEnum

NUM_ENTITY_SLOTS = 8
SLOT_DIM = 19
TOTAL_ENTITY_DIMS = NUM_ENTITY_SLOTS * SLOT_DIM  # 152

# Entity type enum — indices match one-hot encoding order
class EntityType(IntEnum):
    UNKNOWN = 0
    PERSON = 1
    OBJECT = 2
    LANDMARK = 3
    FURNITURE = 4
    DOOR = 5

NUM_ENTITY_TYPES = len(EntityType)

# Field offsets within a single slot
TYPE_OFFSET = 0          # 6 dims (one-hot)
POSITION_OFFSET = 6      # 3 dims (x, y, z)
VELOCITY_OFFSET = 9      # 3 dims (vx, vy, vz)
SIZE_OFFSET = 12          # 3 dims (w, h, d)
CONFIDENCE_OFFSET = 15    # 1 dim
RECENCY_OFFSET = 16       # 1 dim
BEARING_OFFSET = 17       # 2 dims (sin, cos)

# Normalization ranges
MAX_DISTANCE = 5.0        # meters — positions normalized to [-1, 1]
MAX_VELOCITY = 2.0        # m/s — velocities normalized to [-1, 1]
MAX_SIZE = 2.0            # meters — sizes normalized to [0, 1]
RECENCY_HORIZON = 5.0     # seconds — recency normalized to [0, 1]

