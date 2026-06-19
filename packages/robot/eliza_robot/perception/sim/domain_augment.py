"""Visual domain randomization for sim-to-real transfer.

Applies random visual augmentations to MuJoCo renders to bridge
the domain gap with real camera images.
"""

from __future__ import annotations

import numpy as np


class DomainAugmenter:
    """Apply visual augmentations to bridge sim-real domain gap.

    Augmentations: blur, noise, vignette, color jitter, JPEG compression.
    """

    def __init__(
        self,
        blur_range: tuple[int, int] = (0, 3),
        noise_std_range: tuple[float, float] = (0.0, 15.0),
        brightness_range: tuple[float, float] = (0.8, 1.2),
        contrast_range: tuple[float, float] = (0.8, 1.2),
        jpeg_quality_range: tuple[int, int] = (60, 95),
        vignette_strength: float = 0.3,
        seed: int | None = None,
    ) -> None:
        self._blur_range = blur_range
        self._noise_range = noise_std_range
        self._bright_range = brightness_range
        self._contrast_range = contrast_range
        self._jpeg_range = jpeg_quality_range
        self._vignette = vignette_strength
        self._rng = np.random.default_rng(seed)

    def augment(self, image: np.ndarray) -> np.ndarray:
        """Apply random augmentations to an image (H, W, 3) uint8."""
        img = image.astype(np.float32)

        # Gaussian blur
        k = self._rng.integers(self._blur_range[0], self._blur_range[1] + 1)
        if k > 0:
            try:
                import cv2
                ksize = k * 2 + 1
                img = cv2.GaussianBlur(img, (ksize, ksize), 0)
            except ImportError:
                pass

        # Gaussian noise
        std = self._rng.uniform(*self._noise_range)
        if std > 0:
            noise = self._rng.normal(0, std, img.shape).astype(np.float32)
            img = img + noise

        # Brightness
        bright = self._rng.uniform(*self._bright_range)
        img = img * bright

        # Contrast
        contrast = self._rng.uniform(*self._contrast_range)
        mean = img.mean()
        img = (img - mean) * contrast + mean

        # Vignette
        if self._vignette > 0:
            h, w = img.shape[:2]
            y, x = np.ogrid[:h, :w]
            cy, cx = h / 2, w / 2
            dist = np.sqrt((x - cx) ** 2 + (y - cy) ** 2)
            max_dist = np.sqrt(cx ** 2 + cy ** 2)
            vignette = 1.0 - self._vignette * (dist / max_dist) ** 2
            img = img * vignette[:, :, None]

        img = np.clip(img, 0, 255).astype(np.uint8)

        # JPEG compression artifact simulation
        try:
            import cv2
            quality = self._rng.integers(*self._jpeg_range)
            _, encoded = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, int(quality)])
            img = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
        except ImportError:
            pass

        return img
