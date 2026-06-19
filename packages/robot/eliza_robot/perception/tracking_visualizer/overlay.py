"""Detection overlay rendering for camera frames.

Draws ArUco markers, face boxes, skeleton poses, and object detection
boxes on camera frames.
"""

from __future__ import annotations

import numpy as np

try:
    import cv2

    _HAS_CV2 = True
except ImportError:
    _HAS_CV2 = False

# COCO body limb connections (17-keypoint model)
SKELETON_LIMBS = [
    (0, 1), (0, 2), (1, 3), (2, 4),        # head
    (5, 6), (5, 11), (6, 12), (11, 12),     # torso
    (5, 7), (7, 9),                          # left arm
    (6, 8), (8, 10),                         # right arm
    (11, 13), (13, 15),                      # left leg
    (12, 14), (14, 16),                      # right leg
]

LIMB_COLORS = [
    (0, 255, 255), (0, 255, 255), (0, 255, 255), (0, 255, 255),  # head
    (0, 200, 255), (0, 200, 255), (0, 200, 255), (0, 200, 255),  # torso
    (255, 0, 0), (255, 0, 0),                                      # left arm
    (0, 0, 255), (0, 0, 255),                                      # right arm
    (255, 100, 0), (255, 100, 0),                                  # left leg
    (0, 100, 255), (0, 100, 255),                                  # right leg
]

# Detection colors (BGR)
COLOR_ARUCO = (0, 255, 0)
COLOR_FACE = (255, 200, 0)
COLOR_SKELETON = (0, 165, 255)
COLOR_OBJECT = (255, 0, 255)


def draw_aruco_markers(
    frame: np.ndarray,
    detections: list,
    intrinsics=None,
    axis_length: float | None = None,
) -> np.ndarray:
    """Draw ArUco marker outlines, IDs, corner dots, and coordinate axes."""
    if not _HAS_CV2 or not detections:
        return frame

    vis = frame
    corner_colors = [(0, 0, 255), (0, 255, 0), (255, 0, 0), (255, 255, 0)]

    for det in detections:
        corners = det.corners.astype(np.int32).reshape((-1, 1, 2))
        cv2.polylines(vis, [corners], True, COLOR_ARUCO, 2)

        for i, pt in enumerate(det.corners.astype(np.int32)):
            cv2.circle(vis, tuple(pt), 4, corner_colors[i % 4], -1)

        if intrinsics is not None:
            length = axis_length or 0.03
            cv2.drawFrameAxes(
                vis,
                intrinsics.camera_matrix,
                intrinsics.dist_array,
                det.rvec.reshape(3, 1),
                det.tvec.reshape(3, 1),
                length,
            )

        center = det.center_pixel.astype(int)
        label = f"ID:{det.marker_id} {det.distance:.2f}m"
        _draw_label(vis, label, (center[0] - 40, center[1] - 20), COLOR_ARUCO)

    return vis


def draw_faces(frame: np.ndarray, face_detections: list) -> np.ndarray:
    """Draw face bounding boxes and landmarks."""
    if not _HAS_CV2 or not face_detections:
        return frame

    vis = frame
    for det in face_detections:
        bbox = det.bbox.astype(int)
        x1, y1, x2, y2 = bbox
        cv2.rectangle(vis, (x1, y1), (x2, y2), COLOR_FACE, 2)

        if det.landmarks is not None:
            for pt in det.landmarks:
                px, py = int(pt[0]), int(pt[1])
                if px > 0 and py > 0:
                    cv2.circle(vis, (px, py), 3, (0, 255, 255), -1)

        label = f"Face {det.confidence:.0%}"
        _draw_label(vis, label, (x1, y1 - 8), COLOR_FACE)

    return vis


def draw_skeletons(
    frame: np.ndarray, skeletons: list, threshold: float = 0.3
) -> np.ndarray:
    """Draw skeleton keypoints and limb connections."""
    if not _HAS_CV2 or not skeletons:
        return frame

    vis = frame
    for skel in skeletons:
        kps = skel.keypoints
        scores = skel.scores

        # Limbs
        for idx, (i, j) in enumerate(SKELETON_LIMBS):
            if i >= len(kps) or j >= len(kps):
                continue
            if scores[i] < threshold or scores[j] < threshold:
                continue
            pt1 = tuple(kps[i][:2].astype(int))
            pt2 = tuple(kps[j][:2].astype(int))
            color = LIMB_COLORS[idx % len(LIMB_COLORS)]
            cv2.line(vis, pt1, pt2, color, 2, cv2.LINE_AA)

        # Keypoints
        for kp, score in zip(kps, scores):
            if score < threshold:
                continue
            x, y = int(kp[0]), int(kp[1])
            cv2.circle(vis, (x, y), 4, (255, 255, 255), -1)
            cv2.circle(vis, (x, y), 3, COLOR_SKELETON, -1)

        # Person bbox
        bbox = skel.bbox.astype(int)
        cv2.rectangle(vis, (bbox[0], bbox[1]), (bbox[2], bbox[3]), COLOR_SKELETON, 1)

    return vis


def draw_objects(frame: np.ndarray, object_detections: list) -> np.ndarray:
    """Draw object detection boxes with class labels."""
    if not _HAS_CV2 or not object_detections:
        return frame

    vis = frame
    for det in object_detections:
        bbox = det.bbox.astype(int)
        x1, y1, x2, y2 = bbox

        hue = hash(det.class_name) % 180
        color_hsv = np.array([[[hue, 200, 255]]], dtype=np.uint8)
        color_bgr = cv2.cvtColor(color_hsv, cv2.COLOR_HSV2BGR)[0][0]
        color = tuple(int(c) for c in color_bgr)

        cv2.rectangle(vis, (x1, y1), (x2, y2), color, 2)
        label = f"{det.class_name} {det.confidence:.0%}"
        _draw_label(vis, label, (x1, y1 - 8), color)

    return vis


def draw_all_overlays(
    frame: np.ndarray,
    aruco=None,
    faces=None,
    skeletons=None,
    objects=None,
    intrinsics=None,
    show_aruco: bool = True,
    show_faces: bool = True,
    show_skeletons: bool = True,
    show_objects: bool = True,
) -> np.ndarray:
    """Composite all detection overlays onto a frame copy."""
    vis = frame.copy()
    if show_aruco and aruco:
        vis = draw_aruco_markers(vis, aruco, intrinsics)
    if show_objects and objects:
        vis = draw_objects(vis, objects)
    if show_skeletons and skeletons:
        vis = draw_skeletons(vis, skeletons)
    if show_faces and faces:
        vis = draw_faces(vis, faces)
    return vis


def _draw_label(
    frame: np.ndarray,
    text: str,
    position: tuple[int, int],
    color: tuple[int, ...],
    bg_alpha: float = 0.6,
) -> None:
    """Draw a text label with semi-transparent background."""
    if not _HAS_CV2:
        return
    x, y = position
    (w, h), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
    y = max(y, h + 4)
    overlay = frame.copy()
    cv2.rectangle(overlay, (x - 2, y - h - 4), (x + w + 2, y + 2), (0, 0, 0), -1)
    cv2.addWeighted(overlay, bg_alpha, frame, 1 - bg_alpha, 0, frame)
    cv2.putText(
        frame, text, (x, y - 2),
        cv2.FONT_HERSHEY_SIMPLEX, 0.45, color, 1, cv2.LINE_AA,
    )
