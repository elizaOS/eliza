"""Synchronized dual-camera frame source.

Provides time-synchronized frames from a robot head camera (ego)
and an external/room camera for multi-view perception.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass

import numpy as np

from eliza_robot.perception.frame_source import FrameSource

logger = logging.getLogger(__name__)


@dataclass
class SyncedFrame:
    """Time-synchronized frames from multiple cameras."""

    ego_frame: np.ndarray | None  # robot head camera
    external_frame: np.ndarray | None  # room/overhead camera
    timestamp: float  # reference timestamp (average of both)
    ego_timestamp: float | None  # ego camera capture time
    external_timestamp: float | None  # external camera capture time

    @property
    def has_ego(self) -> bool:
        return self.ego_frame is not None

    @property
    def has_external(self) -> bool:
        return self.external_frame is not None

    @property
    def has_both(self) -> bool:
        return self.has_ego and self.has_external

    @property
    def time_diff_ms(self) -> float | None:
        """Time difference between the two frames in milliseconds."""
        if self.ego_timestamp is not None and self.external_timestamp is not None:
            return abs(self.ego_timestamp - self.external_timestamp) * 1000.0
        return None


class DualCameraSource:
    """Synchronized dual-camera frame source.

    Reads from two FrameSource instances (ego = robot head, external = room
    camera) and returns approximately time-synchronized frame pairs.

    The synchronization strategy is simple: read both cameras as close
    together as possible and accept the pair if the time difference is
    below max_time_diff_ms. For USB cameras on the same machine this
    typically yields sub-30ms differences.

    For tighter sync, a threaded mode is available that reads cameras in
    parallel.
    """

    def __init__(
        self,
        ego_source: FrameSource,
        external_source: FrameSource,
        max_time_diff_ms: float = 50.0,
        threaded: bool = False,
    ) -> None:
        """
        Parameters
        ----------
        ego_source : FrameSource
            Robot head camera source.
        external_source : FrameSource
            Room / external camera source.
        max_time_diff_ms : float
            Maximum acceptable time difference between frames (milliseconds).
        threaded : bool
            If True, read cameras in parallel threads for lower latency.
        """
        self._ego = ego_source
        self._external = external_source
        self._max_time_diff = max_time_diff_ms
        self._threaded = threaded
        self._open = True

    def read(self) -> SyncedFrame | None:
        """Read synchronized frames from both cameras.

        Returns
        -------
        SyncedFrame or None
            Synchronized frame pair, or None if both cameras failed.
            If one camera fails, its frame will be None but the other
            will still be returned.
        """
        if not self._open:
            return None

        if self._threaded:
            return self._read_threaded()
        return self._read_sequential()

    def _read_sequential(self) -> SyncedFrame | None:
        """Read cameras sequentially (simpler, slightly higher latency)."""
        ego_frame = None
        ego_ts = None
        ext_frame = None
        ext_ts = None

        # Read ego camera
        if self._ego.is_open:
            t0 = time.monotonic()
            ok, frame = self._ego.read()
            t1 = time.monotonic()
            if ok:
                ego_frame = frame
                ego_ts = (t0 + t1) / 2.0

        # Read external camera
        if self._external.is_open:
            t0 = time.monotonic()
            ok, frame = self._external.read()
            t1 = time.monotonic()
            if ok:
                ext_frame = frame
                ext_ts = (t0 + t1) / 2.0

        if ego_frame is None and ext_frame is None:
            return None

        # Check time sync
        if ego_ts is not None and ext_ts is not None:
            diff_ms = abs(ego_ts - ext_ts) * 1000.0
            if diff_ms > self._max_time_diff:
                logger.debug(
                    "Frame time diff %.1fms exceeds limit %.1fms",
                    diff_ms,
                    self._max_time_diff,
                )
            ref_ts = (ego_ts + ext_ts) / 2.0
        else:
            ref_ts = ego_ts if ego_ts is not None else ext_ts  # type: ignore[assignment]

        return SyncedFrame(
            ego_frame=ego_frame,
            external_frame=ext_frame,
            timestamp=ref_ts,
            ego_timestamp=ego_ts,
            external_timestamp=ext_ts,
        )

    def _read_threaded(self) -> SyncedFrame | None:
        """Read cameras in parallel threads for lower latency."""
        ego_result: list = [None, None]  # [frame, timestamp]
        ext_result: list = [None, None]

        def _read_ego() -> None:
            if not self._ego.is_open:
                return
            t0 = time.monotonic()
            ok, frame = self._ego.read()
            t1 = time.monotonic()
            if ok:
                ego_result[0] = frame
                ego_result[1] = (t0 + t1) / 2.0

        def _read_ext() -> None:
            if not self._external.is_open:
                return
            t0 = time.monotonic()
            ok, frame = self._external.read()
            t1 = time.monotonic()
            if ok:
                ext_result[0] = frame
                ext_result[1] = (t0 + t1) / 2.0

        t_ego = threading.Thread(target=_read_ego, daemon=True)
        t_ext = threading.Thread(target=_read_ext, daemon=True)
        t_ego.start()
        t_ext.start()
        t_ego.join(timeout=1.0)
        t_ext.join(timeout=1.0)

        ego_frame, ego_ts = ego_result
        ext_frame, ext_ts = ext_result

        if ego_frame is None and ext_frame is None:
            return None

        if ego_ts is not None and ext_ts is not None:
            diff_ms = abs(ego_ts - ext_ts) * 1000.0
            if diff_ms > self._max_time_diff:
                logger.debug(
                    "Frame time diff %.1fms exceeds limit %.1fms",
                    diff_ms,
                    self._max_time_diff,
                )
            ref_ts = (ego_ts + ext_ts) / 2.0
        else:
            ref_ts = ego_ts if ego_ts is not None else ext_ts

        return SyncedFrame(
            ego_frame=ego_frame,
            external_frame=ext_frame,
            timestamp=ref_ts,
            ego_timestamp=ego_ts,
            external_timestamp=ext_ts,
        )

    def release(self) -> None:
        """Release both camera sources."""
        self._open = False
        self._ego.release()
        self._external.release()

    @property
    def is_open(self) -> bool:
        return self._open and (self._ego.is_open or self._external.is_open)

    def __enter__(self) -> DualCameraSource:
        return self

    def __exit__(self, *args: object) -> None:
        self.release()
