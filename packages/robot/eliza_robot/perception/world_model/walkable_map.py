"""Walkable map: floor plane estimation and occupancy grid.

Extracts floor plane from depth + SLAM point cloud and builds
a 2D occupancy grid for navigation planning.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class OccupancyGrid:
    """2D occupancy grid for navigation."""
    grid: np.ndarray          # (rows, cols) float32 [0=free, 1=occupied, 0.5=unknown]
    resolution: float         # meters per cell
    origin: np.ndarray        # (2,) world position of grid[0,0]

    @property
    def shape(self) -> tuple[int, int]:
        return self.grid.shape

    def world_to_cell(self, x: float, y: float) -> tuple[int, int]:
        """Convert world coordinates to grid cell indices."""
        col = int((x - self.origin[0]) / self.resolution)
        row = int((y - self.origin[1]) / self.resolution)
        return row, col

    def cell_to_world(self, row: int, col: int) -> tuple[float, float]:
        """Convert grid cell to world coordinates (center of cell)."""
        x = self.origin[0] + (col + 0.5) * self.resolution
        y = self.origin[1] + (row + 0.5) * self.resolution
        return x, y

    def is_free(self, row: int, col: int) -> bool:
        """Check if a cell is free (walkable)."""
        if 0 <= row < self.grid.shape[0] and 0 <= col < self.grid.shape[1]:
            return self.grid[row, col] < 0.3
        return False


class WalkableMapBuilder:
    """Builds a 2D walkable map from 3D point clouds.

    Estimates the floor plane and projects obstacles onto a grid.
    """

    def __init__(
        self,
        grid_size: float = 10.0,    # meters (square)
        resolution: float = 0.05,   # meters per cell
        floor_height: float = 0.02, # max height for floor points
        obstacle_max: float = 0.5,  # max height for obstacle points
    ) -> None:
        self._grid_size = grid_size
        self._resolution = resolution
        self._floor_h = floor_height
        self._obs_max = obstacle_max
        n = int(grid_size / resolution)
        self._grid = np.full((n, n), 0.5, dtype=np.float32)  # unknown
        self._origin = np.array([-grid_size / 2, -grid_size / 2], dtype=np.float32)

    def update(self, points: np.ndarray, robot_pos: np.ndarray | None = None) -> None:
        """Update the occupancy grid with new 3D points.

        Points should be in world frame. Floor plane is at z ≈ 0.
        """
        if points.shape[0] == 0:
            return

        n = self._grid.shape[0]

        # Classify points
        floor_mask = points[:, 2] < self._floor_h
        obstacle_mask = (points[:, 2] >= self._floor_h) & (points[:, 2] < self._obs_max)

        # Vectorized projection: compute grid indices for all points at once
        cols = ((points[:, 0] - self._origin[0]) / self._resolution).astype(np.intp)
        rows = ((points[:, 1] - self._origin[1]) / self._resolution).astype(np.intp)
        in_bounds = (rows >= 0) & (rows < n) & (cols >= 0) & (cols < n)

        # Floor points → decrease occupancy (free)
        floor_valid = floor_mask & in_bounds
        if np.any(floor_valid):
            np.subtract.at(self._grid, (rows[floor_valid], cols[floor_valid]), 0.1)

        # Obstacle points → increase occupancy
        obs_valid = obstacle_mask & in_bounds
        if np.any(obs_valid):
            np.add.at(self._grid, (rows[obs_valid], cols[obs_valid]), 0.2)

        np.clip(self._grid, 0.0, 1.0, out=self._grid)

    def get_grid(self) -> OccupancyGrid:
        """Return current occupancy grid."""
        return OccupancyGrid(
            grid=self._grid.copy(),
            resolution=self._resolution,
            origin=self._origin.copy(),
        )

    def reset(self) -> None:
        """Reset grid to unknown."""
        self._grid[:] = 0.5
