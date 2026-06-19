"""Random object spawning in MuJoCo scenes.

Creates randomized scene configurations for training with diverse
entity layouts — objects, obstacles, and target markers.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np


@dataclass
class SpawnedObject:
    """A randomly placed object in the scene."""
    name: str
    geom_type: str
    position: np.ndarray
    size: np.ndarray
    color: np.ndarray
    body_id: int = -1


class SimSceneRandomizer:
    """Spawn random objects in a MuJoCo scene for perception training.

    Generates MJCF XML fragments that can be injected into scenes,
    or directly modifies model geometry.
    """

    def __init__(
        self,
        num_objects_range: tuple[int, int] = (2, 8),
        spawn_radius: float = 3.0,
        min_distance: float = 0.3,
        seed: int | None = None,
    ) -> None:
        self._num_range = num_objects_range
        self._spawn_radius = spawn_radius
        self._min_dist = min_distance
        self._rng = np.random.default_rng(seed)

    def generate_objects(self) -> list[SpawnedObject]:
        """Generate a random set of objects to place in the scene."""
        n = self._rng.integers(self._num_range[0], self._num_range[1] + 1)
        objects = []
        positions = []

        for i in range(n):
            # Random position (on ground plane)
            for _attempt in range(20):
                angle = self._rng.uniform(0, 2 * np.pi)
                radius = self._rng.uniform(0.5, self._spawn_radius)
                pos = np.array([
                    radius * np.cos(angle),
                    radius * np.sin(angle),
                    0.0,
                ])
                # Check minimum distance
                if all(np.linalg.norm(pos[:2] - p[:2]) >= self._min_dist for p in positions):
                    break

            geom_type = self._rng.choice(["box", "sphere", "cylinder"])
            if geom_type == "box":
                size = self._rng.uniform(0.03, 0.15, size=3)
                pos[2] = size[2]  # sit on ground
            elif geom_type == "sphere":
                r = self._rng.uniform(0.02, 0.1)
                size = np.array([r, r, r])
                pos[2] = r
            else:
                r = self._rng.uniform(0.02, 0.08)
                h = self._rng.uniform(0.05, 0.2)
                size = np.array([r, r, h])
                pos[2] = h

            color = self._rng.uniform(0.2, 1.0, size=3)
            color = np.append(color, 1.0)

            objects.append(SpawnedObject(
                name=f"rand_obj_{i}",
                geom_type=geom_type,
                position=pos.astype(np.float32),
                size=size.astype(np.float32),
                color=color.astype(np.float32),
            ))
            positions.append(pos)

        return objects

    def to_mjcf_fragment(self, objects: list[SpawnedObject]) -> str:
        """Generate MJCF XML body elements for the spawned objects."""
        lines = []
        for obj in objects:
            pos_str = " ".join(f"{x:.4f}" for x in obj.position)
            size_str = " ".join(f"{x:.4f}" for x in obj.size)
            rgba_str = " ".join(f"{x:.3f}" for x in obj.color)
            lines.append(
                f'    <body name="{obj.name}" pos="{pos_str}">'
                f'\n      <geom type="{obj.geom_type}" size="{size_str}" rgba="{rgba_str}" '
                f'contype="1" conaffinity="1"/>'
                f"\n    </body>"
            )
        return "\n".join(lines)
