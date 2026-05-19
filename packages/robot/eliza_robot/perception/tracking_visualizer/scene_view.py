"""Real-time bird's-eye scene view renderer.

Renders a top-down view of the workspace showing floor markers,
robot position/heading, detected entities, and camera positions
using pure OpenCV drawing for real-time performance.
"""

from __future__ import annotations

import math
import time

import numpy as np

try:
    import cv2

    _HAS_CV2 = True
except ImportError:
    _HAS_CV2 = False

# Colors (BGR)
BG_COLOR = (30, 25, 20)
GRID_COLOR = (50, 45, 40)
GRID_MAJOR_COLOR = (70, 65, 55)
MARKER_COLOR = (0, 200, 0)
ROBOT_COLOR = (0, 140, 255)
ROBOT_HEAD_COLOR = (0, 200, 255)
TEXT_COLOR = (200, 200, 200)

ENTITY_COLORS = {
    "person": (0, 200, 0),
    "object": (255, 100, 0),
    "face": (255, 200, 0),
    "landmark": (0, 255, 255),
    "furniture": (100, 60, 200),
    "unknown": (150, 150, 150),
}


class SceneRenderer:
    """Renders a bird's-eye view of the tracked scene.

    All positions are in world-frame meters.  The canvas maps
    [-world_range, +world_range] on both X and Y axes.
    """

    def __init__(
        self,
        canvas_size: int = 800,
        world_range: float = 3.0,
    ) -> None:
        self._size = canvas_size
        self._range = world_range
        self._ppm = canvas_size / (2 * world_range)  # pixels per meter

        # Tracked state
        self._floor_markers: dict[int, np.ndarray] = {}
        self._robot_position: np.ndarray | None = None
        self._robot_heading: float = 0.0
        self._robot_head_position: np.ndarray | None = None
        self._entities: list[dict] = []
        self._camera_positions: dict[str, dict] = {}
        self._last_update = time.monotonic()

    # -- coordinate conversion --

    def world_to_pixel(self, x: float, y: float) -> tuple[int, int]:
        """World metres -> canvas pixels.  Y is flipped (up = -py)."""
        px = int(self._size / 2 + x * self._ppm)
        py = int(self._size / 2 - y * self._ppm)
        return px, py

    # -- state updates --

    def update_floor_markers(self, markers: dict[int, list[float]]) -> None:
        self._floor_markers = {
            mid: np.array(pos[:2]) for mid, pos in markers.items()
        }

    def update_robot_pose(
        self,
        position: np.ndarray | None,
        heading: float = 0.0,
        head_position: np.ndarray | None = None,
    ) -> None:
        self._robot_position = position
        self._robot_heading = heading
        self._robot_head_position = head_position

    def update_entities(self, entities: list[dict]) -> None:
        self._entities = entities
        self._last_update = time.monotonic()

    def update_camera(
        self, camera_id: str, position: np.ndarray, heading: float
    ) -> None:
        self._camera_positions[camera_id] = {
            "position": position,
            "heading": heading,
        }

    # -- rendering --

    def render(self) -> np.ndarray:
        """Render and return a BGR canvas image."""
        if not _HAS_CV2:
            return np.zeros((self._size, self._size, 3), dtype=np.uint8)

        canvas = np.full(
            (self._size, self._size, 3), BG_COLOR, dtype=np.uint8
        )

        self._draw_grid(canvas)
        self._draw_floor_markers(canvas)
        self._draw_camera_frustums(canvas)
        self._draw_entities(canvas)
        self._draw_robot(canvas)
        self._draw_legend(canvas)
        self._draw_scale_bar(canvas)
        self._draw_status(canvas)

        return canvas

    # -- private drawing helpers --

    def _draw_grid(self, canvas: np.ndarray) -> None:
        step = 0.5
        n = int(self._range / step) + 1
        for i in range(-n, n + 1):
            x = i * step
            px, _ = self.world_to_pixel(x, 0)
            _, py = self.world_to_pixel(0, x)
            is_major = abs(x) % 1.0 < 0.01
            color = GRID_MAJOR_COLOR if is_major else GRID_COLOR
            cv2.line(canvas, (px, 0), (px, self._size), color, 1)
            cv2.line(canvas, (0, py), (self._size, py), color, 1)

        # Origin cross-hair
        cx, cy = self.world_to_pixel(0, 0)
        cv2.line(canvas, (cx - 10, cy), (cx + 10, cy), (0, 0, 200), 1)
        cv2.line(canvas, (cx, cy - 10), (cx, cy + 10), (0, 0, 200), 1)
        cv2.putText(
            canvas, "O", (cx + 12, cy - 4),
            cv2.FONT_HERSHEY_SIMPLEX, 0.35, (0, 0, 200), 1,
        )

    def _draw_floor_markers(self, canvas: np.ndarray) -> None:
        for mid, pos in self._floor_markers.items():
            px, py = self.world_to_pixel(float(pos[0]), float(pos[1]))
            half = max(4, int(0.025 * self._ppm))
            cv2.rectangle(
                canvas, (px - half, py - half), (px + half, py + half),
                MARKER_COLOR, 2,
            )
            cv2.line(canvas, (px - half, py - half), (px + half, py + half), MARKER_COLOR, 1)
            cv2.line(canvas, (px + half, py - half), (px - half, py + half), MARKER_COLOR, 1)
            cv2.putText(
                canvas, f"M{mid}", (px + half + 4, py + 4),
                cv2.FONT_HERSHEY_SIMPLEX, 0.4, MARKER_COLOR, 1, cv2.LINE_AA,
            )
            cv2.putText(
                canvas, f"({pos[0]:.1f},{pos[1]:.1f})",
                (px + half + 4, py + 18),
                cv2.FONT_HERSHEY_SIMPLEX, 0.3, (100, 180, 100), 1, cv2.LINE_AA,
            )

        # Polygon connecting floor markers
        if len(self._floor_markers) >= 3:
            pts = [
                self.world_to_pixel(float(p[0]), float(p[1]))
                for p in self._floor_markers.values()
            ]
            arr = np.array(pts, dtype=np.int32).reshape((-1, 1, 2))
            cv2.polylines(canvas, [arr], True, (0, 100, 0), 1, cv2.LINE_AA)

    def _draw_robot(self, canvas: np.ndarray) -> None:
        if self._robot_position is None:
            return

        px, py = self.world_to_pixel(
            float(self._robot_position[0]),
            float(self._robot_position[1]),
        )

        # Triangle body pointing in heading direction
        size = 15
        h = self._robot_heading
        pts = []
        for offset_deg in [0, 140, -140]:
            a = math.radians(offset_deg) + h
            dx = int(size * math.cos(a))
            dy = int(-size * math.sin(a))
            pts.append([px + dx, py + dy])
        tri = np.array(pts, dtype=np.int32)
        cv2.fillPoly(canvas, [tri], ROBOT_COLOR)
        cv2.polylines(canvas, [tri], True, (255, 255, 255), 1, cv2.LINE_AA)

        # Heading arrow
        alen = 25
        ax = int(px + alen * math.cos(h))
        ay = int(py - alen * math.sin(h))
        cv2.arrowedLine(
            canvas, (px, py), (ax, ay), (255, 255, 255), 2,
            cv2.LINE_AA, tipLength=0.3,
        )

        cv2.putText(
            canvas, "Robot", (px + 18, py + 5),
            cv2.FONT_HERSHEY_SIMPLEX, 0.4, ROBOT_COLOR, 1, cv2.LINE_AA,
        )

        # Head marker
        if self._robot_head_position is not None:
            hx, hy = self.world_to_pixel(
                float(self._robot_head_position[0]),
                float(self._robot_head_position[1]),
            )
            cv2.circle(canvas, (hx, hy), 6, ROBOT_HEAD_COLOR, -1)
            cv2.circle(canvas, (hx, hy), 6, (255, 255, 255), 1)

    def _draw_entities(self, canvas: np.ndarray) -> None:
        for ent in self._entities:
            pos = ent.get("position", [0, 0, 0])
            px, py = self.world_to_pixel(float(pos[0]), float(pos[1]))
            etype = ent.get("type", "unknown").lower()
            color = ENTITY_COLORS.get(etype, ENTITY_COLORS["unknown"])
            conf = ent.get("confidence", 0.0)
            label = ent.get("label", etype)

            radius = max(5, int(8 * conf))
            cv2.circle(canvas, (px, py), radius, color, -1)
            cv2.circle(canvas, (px, py), radius, (255, 255, 255), 1)
            cv2.putText(
                canvas, label, (px + radius + 4, py + 4),
                cv2.FONT_HERSHEY_SIMPLEX, 0.35, color, 1, cv2.LINE_AA,
            )

            # Velocity arrow
            vel = ent.get("velocity", [0, 0, 0])
            if abs(vel[0]) > 0.05 or abs(vel[1]) > 0.05:
                vx = int(vel[0] * self._ppm * 0.5)
                vy = int(-vel[1] * self._ppm * 0.5)
                cv2.arrowedLine(
                    canvas, (px, py), (px + vx, py + vy),
                    color, 1, cv2.LINE_AA, tipLength=0.3,
                )

    def _draw_camera_frustums(self, canvas: np.ndarray) -> None:
        for cam_id, cam in self._camera_positions.items():
            pos = cam["position"]
            heading = cam["heading"]
            px, py = self.world_to_pixel(float(pos[0]), float(pos[1]))

            cv2.circle(canvas, (px, py), 5, (200, 200, 200), -1)

            fov_half = math.radians(30)
            flen = 40
            for angle in [heading - fov_half, heading + fov_half]:
                ex = int(px + flen * math.cos(angle))
                ey = int(py - flen * math.sin(angle))
                cv2.line(canvas, (px, py), (ex, ey), (100, 100, 100), 1, cv2.LINE_AA)

            cv2.putText(
                canvas, cam_id, (px + 8, py - 8),
                cv2.FONT_HERSHEY_SIMPLEX, 0.3, (150, 150, 150), 1, cv2.LINE_AA,
            )

    def _draw_legend(self, canvas: np.ndarray) -> None:
        x, y = self._size - 150, 15
        items = [
            ("Robot", ROBOT_COLOR),
            ("Person", ENTITY_COLORS["person"]),
            ("Object", ENTITY_COLORS["object"]),
            ("Marker", MARKER_COLOR),
            ("Landmark", ENTITY_COLORS["landmark"]),
        ]
        for label, color in items:
            cv2.circle(canvas, (x, y), 5, color, -1)
            cv2.putText(
                canvas, label, (x + 12, y + 4),
                cv2.FONT_HERSHEY_SIMPLEX, 0.35, TEXT_COLOR, 1, cv2.LINE_AA,
            )
            y += 18

    def _draw_scale_bar(self, canvas: np.ndarray) -> None:
        bar_px = int(1.0 * self._ppm)
        x1 = 20
        y = self._size - 25
        cv2.line(canvas, (x1, y), (x1 + bar_px, y), TEXT_COLOR, 2)
        cv2.line(canvas, (x1, y - 5), (x1, y + 5), TEXT_COLOR, 1)
        cv2.line(canvas, (x1 + bar_px, y - 5), (x1 + bar_px, y + 5), TEXT_COLOR, 1)
        cv2.putText(
            canvas, "1 meter", (x1 + bar_px // 2 - 25, y - 8),
            cv2.FONT_HERSHEY_SIMPLEX, 0.35, TEXT_COLOR, 1, cv2.LINE_AA,
        )

    def _draw_status(self, canvas: np.ndarray) -> None:
        age = time.monotonic() - self._last_update
        status = "LIVE" if age < 1.0 else f"{age:.0f}s ago"
        color = (0, 200, 0) if age < 1.0 else (0, 0, 200)
        cv2.putText(
            canvas, status, (10, 20),
            cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA,
        )
