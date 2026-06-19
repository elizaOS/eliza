"""Frame source abstraction: OpenCV, image directory, MuJoCo renders.

Provides a uniform interface for getting camera frames regardless of source.
"""

from __future__ import annotations

import abc
from pathlib import Path
from typing import Any, Iterator

import numpy as np


class FrameSource(abc.ABC):
    """Abstract base class for frame sources."""

    @abc.abstractmethod
    def read(self) -> tuple[bool, np.ndarray]:
        """Read a single frame. Returns (success, frame_bgr)."""

    @abc.abstractmethod
    def release(self) -> None:
        """Release the frame source."""

    @property
    @abc.abstractmethod
    def is_open(self) -> bool:
        """Whether the source is currently open."""

    def __iter__(self) -> Iterator[np.ndarray]:
        while self.is_open:
            ok, frame = self.read()
            if not ok:
                break
            yield frame

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.release()


class OpenCVSource(FrameSource):
    """USB/CSI camera via OpenCV VideoCapture."""

    def __init__(self, device: int = 0, width: int = 640, height: int = 480) -> None:
        import cv2
        self._cap = cv2.VideoCapture(device)
        self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)

    def read(self) -> tuple[bool, np.ndarray]:
        return self._cap.read()

    def release(self) -> None:
        self._cap.release()

    @property
    def is_open(self) -> bool:
        return self._cap.isOpened()


class ImageDirSource(FrameSource):
    """Iterate over images in a directory (for offline testing)."""

    def __init__(self, directory: Path, extensions: tuple[str, ...] = (".jpg", ".png", ".bmp")) -> None:
        self._files = sorted(
            f for f in directory.iterdir()
            if f.suffix.lower() in extensions
        )
        self._idx = 0

    def read(self) -> tuple[bool, np.ndarray]:
        if self._idx >= len(self._files):
            return False, np.array([])
        import cv2
        frame = cv2.imread(str(self._files[self._idx]))
        self._idx += 1
        if frame is None:
            return False, np.array([])
        return True, frame

    def release(self) -> None:
        self._idx = len(self._files)

    @property
    def is_open(self) -> bool:
        return self._idx < len(self._files)


class ArraySource(FrameSource):
    """Frame source from a list of numpy arrays (for testing)."""

    def __init__(self, frames: list[np.ndarray]) -> None:
        self._frames = frames
        self._idx = 0

    def read(self) -> tuple[bool, np.ndarray]:
        if self._idx >= len(self._frames):
            return False, np.array([])
        frame = self._frames[self._idx]
        self._idx += 1
        return True, frame

    def release(self) -> None:
        self._idx = len(self._frames)

    @property
    def is_open(self) -> bool:
        return self._idx < len(self._frames)
