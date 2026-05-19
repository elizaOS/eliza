"""Monocular metric depth estimation using Depth Anything V2.

Produces dense metric depth maps from single RGB images.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from eliza_robot.perception.calibration import CameraIntrinsics


@dataclass
class DepthResult:
    """Depth estimation output."""
    depth_map: np.ndarray     # (H, W) float32, meters
    confidence: float         # overall confidence estimate

    def depth_at(self, u: int, v: int) -> float:
        """Get depth at pixel (u, v) in meters."""
        h, w = self.depth_map.shape
        u = max(0, min(u, w - 1))
        v = max(0, min(v, h - 1))
        return float(self.depth_map[v, u])

    def point_3d(
        self, u: int, v: int, intrinsics: CameraIntrinsics,
    ) -> np.ndarray:
        """Convert pixel + depth to 3D point."""
        depth = self.depth_at(u, v)
        return intrinsics.pixel_to_3d(float(u), float(v), depth)

    def roi_depth(self, bbox: np.ndarray, quantile: float = 0.3) -> float:
        """Robust depth within a bounding box ROI.

        Uses a lower quantile (default 30th percentile) rather than
        the median to prefer closer surfaces over background.
        """
        x1, y1, x2, y2 = bbox.astype(int)
        h, w = self.depth_map.shape
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(w, x2), min(h, y2)
        roi = self.depth_map[y1:y2, x1:x2]
        if roi.size == 0:
            return 0.0
        valid = roi[roi > 0]
        if valid.size == 0:
            return 0.0
        return float(np.quantile(valid, quantile))


class DepthEstimator:
    """Metric depth estimation using Depth Anything V2.

    Falls back to a uniform depth map if the model is unavailable or
    weights cannot be loaded.
    """

    # Known checkpoint filenames per model size (Depth Anything V2 Metric Indoor)
    _CHECKPOINT_NAMES = {
        "vits": "depth_anything_v2_metric_hypersim_vits.pth",
        "vitb": "depth_anything_v2_metric_hypersim_vitb.pth",
        "vitl": "depth_anything_v2_metric_hypersim_vitl.pth",
    }

    def __init__(
        self,
        model_size: str = "vits",
        max_depth: float = 20.0,
        device: str = "cuda",
        checkpoint_path: str | None = None,
    ) -> None:
        self._max_depth = max_depth
        self._model: Any = None
        self._device = device

        try:
            import torch
            from depth_anything_v2.dpt import DepthAnythingV2

            model_configs = {
                "vits": {"encoder": "vits", "features": 64, "out_channels": [48, 96, 192, 384]},
                "vitb": {"encoder": "vitb", "features": 128, "out_channels": [96, 192, 384, 768]},
                "vitl": {"encoder": "vitl", "features": 256, "out_channels": [256, 512, 1024, 1024]},
            }
            cfg = model_configs.get(model_size, model_configs["vits"])
            model = DepthAnythingV2(**cfg, max_depth=max_depth)

            # Load pretrained weights
            ckpt = self._find_checkpoint(checkpoint_path, model_size)
            if ckpt is not None:
                state_dict = torch.load(ckpt, map_location="cpu", weights_only=True)
                model.load_state_dict(state_dict)
                model = model.to(device).eval()
                self._model = model
                self._torch = torch
            else:
                import logging
                logging.getLogger(__name__).warning(
                    "Depth Anything V2 weights not found. "
                    "Download from https://github.com/DepthAnything/Depth-Anything-V2 "
                    "and place in ~/.cache/depth_anything_v2/ or pass checkpoint_path. "
                    "Using fallback depth estimation."
                )
                self._model = None
        except ImportError:
            self._model = None
        except Exception:
            import logging
            logging.getLogger(__name__).warning(
                "Failed to initialize Depth Anything V2", exc_info=True,
            )
            self._model = None

    @classmethod
    def _find_checkpoint(cls, explicit_path: str | None, model_size: str) -> str | None:
        """Search for checkpoint file in common locations."""
        import os
        if explicit_path and os.path.isfile(explicit_path):
            return explicit_path
        filename = cls._CHECKPOINT_NAMES.get(model_size, cls._CHECKPOINT_NAMES["vits"])
        search_dirs = [
            os.path.expanduser("~/.cache/depth_anything_v2"),
            os.path.expanduser("~/.cache/torch/hub/checkpoints"),
            "checkpoints",
        ]
        for d in search_dirs:
            path = os.path.join(d, filename)
            if os.path.isfile(path):
                return path
        return None

    def estimate(self, frame: np.ndarray) -> DepthResult:
        """Estimate metric depth from a BGR frame."""
        if self._model is not None:
            return self._estimate_model(frame)
        return self._estimate_fallback(frame)

    def _estimate_model(self, frame: np.ndarray) -> DepthResult:
        depth = self._model.infer_image(frame)
        depth = np.clip(depth, 0.0, self._max_depth).astype(np.float32)
        # Confidence based on fraction of valid (non-zero, non-max) pixels
        valid = (depth > 0.01) & (depth < self._max_depth - 0.1)
        confidence = float(np.mean(valid))
        return DepthResult(depth_map=depth, confidence=confidence)

    def _estimate_fallback(self, frame: np.ndarray) -> DepthResult:
        """Uniform depth fallback when model is unavailable."""
        h, w = frame.shape[:2]
        depth = np.ones((h, w), dtype=np.float32) * 2.0
        return DepthResult(depth_map=depth, confidence=0.1)

    @property
    def is_available(self) -> bool:
        return self._model is not None
