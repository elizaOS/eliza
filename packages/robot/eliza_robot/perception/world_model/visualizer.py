"""3D scene visualization for the world model.

Renders tracked entities, point clouds, and occupancy grids
using matplotlib (fallback) or Open3D (if available).
"""

from __future__ import annotations

from typing import Any

import numpy as np

from eliza_robot.perception.world_model.entity import PersistentEntity
from eliza_robot.perception.entity_slots.slot_config import EntityType


# Entity type colors (RGB 0-1)
TYPE_COLORS = {
    EntityType.UNKNOWN: (0.5, 0.5, 0.5),
    EntityType.PERSON: (0.0, 0.8, 0.0),
    EntityType.OBJECT: (0.0, 0.0, 1.0),
    EntityType.LANDMARK: (1.0, 1.0, 0.0),
    EntityType.FURNITURE: (0.6, 0.3, 0.0),
    EntityType.DOOR: (0.8, 0.0, 0.8),
}


class SceneVisualizer:
    """Visualize 3D scene state with entities and point clouds."""

    def __init__(self, use_open3d: bool = True) -> None:
        self._o3d: Any = None
        if use_open3d:
            try:
                import open3d as o3d
                self._o3d = o3d
            except ImportError:
                pass

    def plot_entities_matplotlib(
        self,
        entities: list[PersistentEntity],
        points: np.ndarray | None = None,
        title: str = "World Model",
        save_path: str | None = None,
    ) -> None:
        """2D bird's-eye view using matplotlib."""
        import matplotlib.pyplot as plt

        fig, ax = plt.subplots(1, 1, figsize=(8, 8))

        # Point cloud
        if points is not None and points.shape[0] > 0:
            ax.scatter(points[:, 0], points[:, 1], c="lightgray", s=1, alpha=0.3)

        # Robot at origin
        ax.plot(0, 0, "k^", markersize=12, label="Robot")

        # Entities
        for e in entities:
            color = TYPE_COLORS.get(e.entity_type, (0.5, 0.5, 0.5))
            ax.plot(e.position[0], e.position[1], "o", color=color, markersize=8)
            ax.annotate(
                f"{e.label}\n{e.distance:.1f}m",
                (e.position[0], e.position[1]),
                fontsize=7,
                ha="center",
                va="bottom",
            )
            # Velocity arrow
            if np.linalg.norm(e.velocity[:2]) > 0.05:
                ax.arrow(
                    e.position[0], e.position[1],
                    e.velocity[0] * 0.5, e.velocity[1] * 0.5,
                    head_width=0.05, color=color, alpha=0.6,
                )

        ax.set_xlabel("X (m)")
        ax.set_ylabel("Y (m)")
        ax.set_title(title)
        ax.set_aspect("equal")
        ax.grid(True, alpha=0.3)
        ax.set_xlim(-5, 5)
        ax.set_ylim(-5, 5)

        if save_path:
            fig.savefig(save_path, dpi=150, bbox_inches="tight")
        plt.close(fig)

    def create_open3d_scene(
        self,
        entities: list[PersistentEntity],
        points: np.ndarray | None = None,
        colors: np.ndarray | None = None,
    ) -> Any | None:
        """Create Open3D geometries for the scene. Returns list of geometries."""
        if self._o3d is None:
            return None

        o3d = self._o3d
        geometries = []

        # Coordinate frame at robot origin
        frame = o3d.geometry.TriangleMesh.create_coordinate_frame(size=0.2)
        geometries.append(frame)

        # Point cloud
        if points is not None and points.shape[0] > 0:
            pcd = o3d.geometry.PointCloud()
            pcd.points = o3d.utility.Vector3dVector(points)
            if colors is not None and colors.shape[0] == points.shape[0]:
                pcd.colors = o3d.utility.Vector3dVector(colors / 255.0)
            else:
                pcd.paint_uniform_color([0.7, 0.7, 0.7])
            geometries.append(pcd)

        # Entity markers
        for e in entities:
            color = TYPE_COLORS.get(e.entity_type, (0.5, 0.5, 0.5))
            sphere = o3d.geometry.TriangleMesh.create_sphere(radius=0.05)
            sphere.paint_uniform_color(list(color))
            sphere.translate(e.position.tolist())
            geometries.append(sphere)

        return geometries
