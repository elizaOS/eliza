"""Hyperscape game entity adapter -- maps game types to canonical schema.

This module converts Hyperscape game world snapshots into the
``ContextEntity`` representation defined in
:mod:`eliza_robot.schema.embodied_context`.

Responsibilities
----------------
* **Entity type mapping** -- game-specific types (``"player"``, ``"npc"``,
  ``"resource"``, ``"tree"``, ...) to generic types (``"person"``,
  ``"object"``, ``"landmark"``, ``"door"``, ``"unknown"``).
* **Coordinate transform** -- Hyperscape uses a Y-up coordinate system;
  the canonical schema is Z-up.  ``transform_game_position`` swaps axes.
  ``coordinate_game_to_robot`` provides the alternative robot-frame
  mapping (X-forward, Y-left, Z-up).
* **Property extraction** -- game-specific fields (health, level, rarity)
  are preserved in the ``properties`` dict of each ``ContextEntity``.
* **Full snapshot normalization** -- ``normalize_hyperscape_snapshot``
  converts an entire game world snapshot into an EmbodiedContext-compatible
  dict.
"""

from __future__ import annotations

import logging
import math
import time as _time
from typing import Any

from eliza_robot.schema.embodied_context import ContextEntity

logger = logging.getLogger(__name__)

# ── Entity type mapping ──────────────────────────────────────────────────

_GAME_TYPE_TO_GENERIC: dict[str, str] = {
    # Persons
    "player": "person",
    "npc": "person",
    "enemy": "person",
    "ally": "person",
    "villager": "person",
    "merchant": "person",
    "guard": "person",
    "monster": "person",
    "goblin": "person",
    "skeleton": "person",
    "knight": "person",
    "mage": "person",
    "archer": "person",
    "bandit": "person",
    "boss": "person",
    # Objects
    "resource": "object",
    "item": "object",
    "chest": "object",
    "loot": "object",
    "pickup": "object",
    "weapon": "object",
    "tool": "object",
    "food": "object",
    "potion": "object",
    "ore": "object",
    "herb": "object",
    "fish": "object",
    "coin": "object",
    "gem": "object",
    "log": "object",
    "armor": "object",
    "equipment": "object",
    "scroll": "object",
    # Landmarks
    "tree": "landmark",
    "rock": "landmark",
    "building": "landmark",
    "structure": "landmark",
    "mountain": "landmark",
    "river": "landmark",
    "bridge": "landmark",
    "tower": "landmark",
    "wall": "landmark",
    "fence": "landmark",
    "sign": "landmark",
    "statue": "landmark",
    # Landmark -- functional buildings
    "bank": "landmark",
    "shop": "landmark",
    "tavern": "landmark",
    "forge": "landmark",
    "temple": "landmark",
    "market": "landmark",
    "warehouse": "landmark",
    "house": "landmark",
    "castle": "landmark",
    "inn": "landmark",
    # Doors / portals
    "door": "door",
    "gate": "door",
    "portal": "door",
    "entrance": "door",
    "exit": "door",
    "ladder": "door",
    "staircase": "door",
    # Furniture (inside buildings)
    "table": "furniture",
    "chair": "furniture",
    "bed": "furniture",
    "bench": "furniture",
    "shelf": "furniture",
    "counter": "furniture",
    "anvil": "furniture",
    "furnace": "furniture",
}


# Public alias for external consumers.
HYPERSCAPE_TYPE_MAP: dict[str, str] = _GAME_TYPE_TO_GENERIC


def map_entity_type(game_type: str) -> str:
    """Map a Hyperscape game entity type to a generic canonical type.

    Falls back to ``"unknown"`` for unrecognised types.
    """
    return _GAME_TYPE_TO_GENERIC.get(game_type.lower(), "unknown")


# ── Coordinate transform ────────────────────────────────────────────────

def transform_game_position(
    pos: list[float] | tuple[float, ...] | dict[str, float],
) -> tuple[float, float, float]:
    """Convert a Hyperscape Y-up position to canonical Z-up.

    Hyperscape:  (X_game, Y_game, Z_game)  --  Y is up
    Canonical:   (X_can, Y_can, Z_can)     --  Z is up

    Mapping:
        X_can =  X_game
        Y_can = -Z_game   (Hyperscape Z is "forward", mapped to -Y for right-hand Z-up)
        Z_can =  Y_game   (Hyperscape Y-up -> canonical Z-up)
    """
    if isinstance(pos, dict):
        xg = float(pos.get("x", 0.0))
        yg = float(pos.get("y", 0.0))
        zg = float(pos.get("z", 0.0))
    else:
        seq = list(pos) if not isinstance(pos, list) else pos
        xg = float(seq[0]) if len(seq) > 0 else 0.0
        yg = float(seq[1]) if len(seq) > 1 else 0.0
        zg = float(seq[2]) if len(seq) > 2 else 0.0

    return (xg, -zg, yg)


# ── Property extraction ─────────────────────────────────────────────────

_PASSTHROUGH_PROPERTY_KEYS = frozenset({
    "health",
    "maxHealth",
    "max_health",
    "level",
    "rarity",
    "quantity",
    "damage",
    "defense",
    "speed",
    "faction",
    "dialogue",
    "quest",
    "interactable",
    "stackSize",
    "stack_size",
    "value",
    "durability",
    "respawnTime",
    "respawn_time",
    "owner",
    "state",
    "isHostile",
    "is_hostile",
    "isOpen",
    "is_open",
    "isLocked",
    "is_locked",
})


def extract_properties(raw: dict[str, Any]) -> dict[str, Any]:
    """Extract game-specific properties into a flat dict.

    Only known property keys are passed through so we don't leak internal
    engine fields.  Both camelCase and snake_case variants are accepted.
    """
    props: dict[str, Any] = {}
    for key, value in raw.items():
        if key in _PASSTHROUGH_PROPERTY_KEYS:
            props[key] = value
    return props


# ── High-level adapter ───────────────────────────────────────────────────

def adapt_hyperscape_entities(
    raw_entities: list[dict[str, Any]],
    agent_position: tuple[float, float, float],
    agent_yaw: float,
) -> list[ContextEntity]:
    """Convert a list of raw Hyperscape entity dicts to ``ContextEntity`` list.

    Parameters
    ----------
    raw_entities:
        List of entity dicts from the Hyperscape snapshot.  Supports
        camelCase keys from the TypeScript side.
    agent_position:
        Agent position in **canonical** (Z-up) frame.
    agent_yaw:
        Agent heading in canonical frame (radians).

    Returns
    -------
    list[ContextEntity]
    """
    result: list[ContextEntity] = []

    for raw in raw_entities:
        if not isinstance(raw, dict):
            logger.warning("Skipping non-dict entity: %r", raw)
            continue

        eid = str(raw.get("entityId", raw.get("entity_id", raw.get("id", ""))))
        if not eid:
            continue

        # Type
        game_type = str(raw.get("entityType", raw.get("entity_type", raw.get("type", "unknown"))))
        generic_type = map_entity_type(game_type)

        # Label
        label = str(raw.get("label", raw.get("name", game_type)))

        # Position (transform from game Y-up to canonical Z-up)
        raw_pos = raw.get("position", raw.get("pos", [0, 0, 0]))
        position = transform_game_position(raw_pos)

        # Velocity (same axis transform)
        raw_vel = raw.get("velocity", raw.get("vel", [0, 0, 0]))
        velocity = transform_game_position(raw_vel)

        # Size
        raw_size = raw.get("size", raw.get("dimensions", [0, 0, 0]))
        if isinstance(raw_size, dict):
            size = (
                float(raw_size.get("width", raw_size.get("x", 0.0))),
                float(raw_size.get("height", raw_size.get("y", 0.0))),
                float(raw_size.get("depth", raw_size.get("z", 0.0))),
            )
        else:
            s = list(raw_size) if not isinstance(raw_size, list) else raw_size
            size = (
                float(s[0]) if len(s) > 0 else 0.0,
                float(s[1]) if len(s) > 1 else 0.0,
                float(s[2]) if len(s) > 2 else 0.0,
            )

        # Confidence
        confidence = float(raw.get("confidence", 1.0))

        # Distance and bearing in agent frame
        dx = position[0] - agent_position[0]
        dy = position[1] - agent_position[1]
        dz = position[2] - agent_position[2]
        distance = math.sqrt(dx * dx + dy * dy + dz * dz)
        world_bearing = math.atan2(dy, dx)
        bearing = _normalize_angle(world_bearing - agent_yaw)

        # Source
        source = str(raw.get("source", "game"))

        # Properties
        properties = extract_properties(raw)

        result.append(ContextEntity(
            entity_id=eid,
            entity_type=generic_type,
            label=label,
            position=position,
            velocity=velocity,
            size=size,
            confidence=confidence,
            distance_to_agent=distance,
            bearing_to_agent=bearing,
            source=source,
            properties=properties,
        ))

    return result


# ── Robot-frame coordinate transform ────────────────────────────────────

def coordinate_game_to_robot(
    game_pos: dict[str, Any] | list | tuple,
) -> tuple[float, float, float]:
    """Convert game coordinates to robot-frame coordinates.

    Hyperscape uses: X-right, Y-up, Z-forward (typical game coords)
    Robot uses:      X-forward, Y-left, Z-up

    The transform is::

        robot_x =  game_z   (forward)
        robot_y = -game_x   (left)
        robot_z =  game_y   (up)

    This is an alternative mapping to ``transform_game_position`` which
    uses a different convention (X-right, Y-back, Z-up).  Use this
    function when you specifically need the robot body-frame convention.
    """
    if isinstance(game_pos, dict):
        gx = float(game_pos.get("x", game_pos.get("X", 0.0)))
        gy = float(game_pos.get("y", game_pos.get("Y", 0.0)))
        gz = float(game_pos.get("z", game_pos.get("Z", 0.0)))
    elif isinstance(game_pos, (list, tuple)) and len(game_pos) >= 3:
        gx, gy, gz = float(game_pos[0]), float(game_pos[1]), float(game_pos[2])
    elif isinstance(game_pos, (list, tuple)) and len(game_pos) == 2:
        gx, gy, gz = float(game_pos[0]), 0.0, float(game_pos[1])
    else:
        return (0.0, 0.0, 0.0)

    return (gz, -gx, gy)


# ── Full snapshot normalization ─────────────────────────────────────────

def normalize_hyperscape_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Convert a full Hyperscape world snapshot to EmbodiedContext-compatible dict.

    This is a lower-level function that returns a plain dict rather than an
    ``EmbodiedContext`` instance.  Use
    :meth:`EmbodiedContext.from_hyperscape_snapshot` for the dataclass version.

    Handles:
    - Game coordinate system (Y-up) to robot coordinate system (Z-up)
    - Game entity types to generic entity types
    - Agent state (health, stamina, level) to properties dict
    - Nearby players/NPCs to person entities
    - Resources/items to object entities
    """
    if not isinstance(snapshot, dict):
        logger.warning("normalize_hyperscape_snapshot received non-dict: %r", type(snapshot))
        snapshot = {}

    ts = float(snapshot.get("timestamp", snapshot.get("time", _time.time())))

    # -- Agent / player state --------------------------------------------------
    player = snapshot.get("player", snapshot.get("agent", {}))
    if not isinstance(player, dict):
        player = {}

    raw_pos = player.get("position", player.get("pos", [0, 0, 0]))
    agent_pos = transform_game_position(raw_pos)
    agent_yaw = float(player.get("yaw", player.get("heading", 0.0)))
    is_walking = bool(player.get("isWalking", player.get("isMoving", False)))

    raw_ori = player.get("orientation", player.get("rotation", [0, 0, 0, 1]))
    if isinstance(raw_ori, (list, tuple)) and len(raw_ori) == 4:
        agent_ori = [float(v) for v in raw_ori]
    else:
        agent_ori = [0.0, 0.0, 0.0, 1.0]

    # Agent properties (game-specific)
    agent_properties: dict[str, Any] = {}
    for key in ("health", "maxHealth", "stamina", "maxStamina", "level",
                "combat_level", "skills", "equipment", "inventory"):
        if key in player:
            agent_properties[key] = player[key]

    # -- Entities --------------------------------------------------------------
    raw_entities = snapshot.get("entities", snapshot.get("objects", []))
    if not isinstance(raw_entities, list):
        raw_entities = []

    entities = adapt_hyperscape_entities(raw_entities, agent_pos, agent_yaw)
    entities_dicts = [e.to_dict() for e in entities]

    # -- Task context ----------------------------------------------------------
    task_desc = str(snapshot.get("taskDescription", snapshot.get("task", "")))
    lang_inst = str(snapshot.get("languageInstruction", snapshot.get("instruction", "")))

    return {
        "schema_version": "1.0",
        "source": "hyperscape",
        "timestamp": ts,
        "agent_position": list(agent_pos),
        "agent_orientation": agent_ori,
        "agent_yaw": agent_yaw,
        "imu_roll": 0.0,
        "imu_pitch": 0.0,
        "gyro": [0.0, 0.0, 0.0],
        "is_walking": is_walking,
        "battery_mv": 0,
        "joint_positions": [],
        "entities": entities_dicts,
        "entity_slots": [],
        "task_description": task_desc,
        "language_instruction": lang_inst,
        "agent_properties": agent_properties,
    }


# ── Private helpers ──────────────────────────────────────────────────────

def _normalize_angle(angle: float) -> float:
    """Wrap angle to [-pi, pi]."""
    while angle > math.pi:
        angle -= 2.0 * math.pi
    while angle < -math.pi:
        angle += 2.0 * math.pi
    return angle
