"""IP camera frame source for WebSocket, MJPEG, RTSP, and HTTP snapshot streams.

Provides a FrameSource-compatible interface for the robot's IP camera,
supporting HTTP MJPEG, RTSP, WebSocket JPEG, and HTTP snapshot polling.
"""

from __future__ import annotations

import logging
import threading
import time
import urllib.parse
import urllib.request

import numpy as np

from eliza_robot.perception.frame_source import FrameSource

logger = logging.getLogger(__name__)


class IPCameraSource(FrameSource):
    """Connects to a robot IP camera via multiple protocols.

    Uses a background thread for continuous frame acquisition with
    automatic reconnection on failure.

    Supported URL schemes / modes:
    - ``http://`` MJPEG stream — OpenCV VideoCapture (``?type=mjpeg``)
    - ``http://`` snapshot polling — fetches individual JPEGs in a loop
    - ``rtsp://`` — OpenCV RTSP capture
    - ``ws://`` / ``wss://`` — WebSocket binary JPEG frames

    For a ROS ``web_video_server`` behind a proxy (like AiNex), pass the
    base URL and the class will automatically discover / build the right
    snapshot or MJPEG URL.  When given a bare host URL (e.g.
    ``http://192.168.1.218:8888/``) it probes common paths.
    """

    def __init__(
        self,
        url: str,
        reconnect_interval: float = 3.0,
        timeout: float = 10.0,
        topic: str = "/camera/image_raw",
    ) -> None:
        self._url = url.rstrip("/")
        self._reconnect_interval = reconnect_interval
        self._timeout = timeout
        self._topic = topic

        self._frame: np.ndarray | None = None
        self._frame_lock = threading.Lock()
        self._running = False
        self._connected = False
        self._thread: threading.Thread | None = None

        # Determine mode
        if url.startswith("ws://") or url.startswith("wss://"):
            self._mode = "websocket"
        elif "/snapshot" in url or "/stream" in url:
            # Explicit stream / snapshot URL
            if "/snapshot" in url:
                self._mode = "snapshot"
            else:
                self._mode = "opencv"
        else:
            # Bare URL — auto-detect
            self._mode = "auto"

        self._start()

    def _start(self) -> None:
        self._running = True
        self._thread = threading.Thread(target=self._reader_loop, daemon=True)
        self._thread.start()

    # ------------------------------------------------------------------
    # Reader loop
    # ------------------------------------------------------------------

    def _reader_loop(self) -> None:
        while self._running:
            try:
                if self._mode == "auto":
                    self._auto_detect_and_read()
                elif self._mode == "snapshot":
                    self._read_snapshot()
                elif self._mode == "websocket":
                    self._read_websocket()
                else:
                    self._read_opencv()
            except Exception as e:
                logger.warning("Camera %s error: %s", self._url, e)
                self._connected = False
            if self._running:
                time.sleep(self._reconnect_interval)

    def _auto_detect_and_read(self) -> None:
        """Probe the URL to figure out what kind of camera server it is."""
        base = self._url
        enc_topic = urllib.parse.quote(self._topic, safe="")

        # Candidate URLs to try (in order of preference)
        candidates = [
            # Direct MJPEG stream through camera_proxy
            (
                "opencv",
                f"{base}/camera_proxy/stream?topic={enc_topic}&type=mjpeg&quality=70",
            ),
            # Snapshot polling through camera_proxy
            (
                "snapshot",
                f"{base}/camera_proxy/snapshot?topic={enc_topic}&quality=70",
            ),
            # Direct web_video_server MJPEG (if port is 8080 on robot)
            (
                "opencv",
                f"{base}/stream?topic={enc_topic}&type=mjpeg&quality=70",
            ),
            # Plain URL (maybe it IS an MJPEG stream itself)
            ("opencv", base),
        ]

        for mode, url in candidates:
            logger.info("Trying robot camera: %s [%s]", url, mode)
            try:
                if mode == "snapshot":
                    ok = self._test_snapshot(url)
                    if ok:
                        self._mode = "snapshot"
                        self._url = url
                        logger.info("Robot camera: using snapshot polling at %s", url)
                        self._read_snapshot()
                        return
                else:
                    import cv2

                    cap = cv2.VideoCapture(url)
                    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                    # Give it 5 seconds to connect
                    cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 5000)
                    if cap.isOpened():
                        ret, frame = cap.read()
                        if ret and frame is not None:
                            self._mode = "opencv"
                            self._url = url
                            logger.info(
                                "Robot camera: using OpenCV stream at %s", url
                            )
                            self._connected = True
                            with self._frame_lock:
                                self._frame = frame
                            # Continue reading from this cap
                            while self._running:
                                ret, frame = cap.read()
                                if not ret:
                                    break
                                with self._frame_lock:
                                    self._frame = frame
                            cap.release()
                            self._connected = False
                            return
                    cap.release()
            except Exception as e:
                logger.debug("Candidate %s failed: %s", url, e)
                continue

        logger.warning(
            "Could not connect to robot camera at %s (tried %d candidates)",
            base,
            len(candidates),
        )

    # ------------------------------------------------------------------
    # Snapshot polling
    # ------------------------------------------------------------------

    def _test_snapshot(self, url: str) -> bool:
        """Quick test if a snapshot URL returns a valid JPEG."""
        try:
            req = urllib.request.Request(url)
            resp = urllib.request.urlopen(req, timeout=self._timeout)
            data = resp.read()
            if len(data) > 100:
                import cv2

                arr = np.frombuffer(data, dtype=np.uint8)
                frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
                return frame is not None
        except Exception:
            pass
        return False

    def _read_snapshot(self) -> None:
        """Poll individual JPEG snapshots over HTTP."""
        import cv2

        url = self._url
        logger.info("Snapshot polling: %s", url)
        self._connected = True
        fail_count = 0

        while self._running:
            try:
                req = urllib.request.Request(url)
                resp = urllib.request.urlopen(req, timeout=self._timeout)
                data = resp.read()
                arr = np.frombuffer(data, dtype=np.uint8)
                frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
                if frame is not None:
                    with self._frame_lock:
                        self._frame = frame
                    fail_count = 0
                else:
                    fail_count += 1
            except Exception as e:
                fail_count += 1
                if fail_count % 10 == 1:
                    logger.warning("Snapshot fetch error (%d): %s", fail_count, e)

            if fail_count > 30:
                logger.warning("Too many snapshot failures, reconnecting")
                self._connected = False
                return

            # ~15 FPS polling rate
            time.sleep(0.066)

    # ------------------------------------------------------------------
    # OpenCV (MJPEG / RTSP)
    # ------------------------------------------------------------------

    def _read_opencv(self) -> None:
        import cv2

        cap = cv2.VideoCapture(self._url)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        if not cap.isOpened():
            logger.warning("Cannot open camera: %s", self._url)
            return

        self._connected = True
        logger.info("Connected to camera: %s", self._url)

        while self._running:
            ret, frame = cap.read()
            if not ret:
                break
            with self._frame_lock:
                self._frame = frame

        cap.release()
        self._connected = False

    # ------------------------------------------------------------------
    # WebSocket
    # ------------------------------------------------------------------

    def _read_websocket(self) -> None:
        try:
            import websocket  # websocket-client package
        except ImportError:
            logger.warning(
                "websocket-client not installed; falling back to OpenCV for %s",
                self._url,
            )
            self._mode = "opencv"
            self._read_opencv()
            return

        import cv2

        ws = websocket.WebSocket()
        ws.settimeout(self._timeout)
        try:
            ws.connect(self._url)
            self._connected = True
            logger.info("WebSocket connected: %s", self._url)

            while self._running:
                data = ws.recv()
                if isinstance(data, bytes):
                    arr = np.frombuffer(data, dtype=np.uint8)
                    frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
                    if frame is not None:
                        with self._frame_lock:
                            self._frame = frame
        finally:
            ws.close()
            self._connected = False

    # ------------------------------------------------------------------
    # FrameSource interface
    # ------------------------------------------------------------------

    def read(self) -> tuple[bool, np.ndarray]:
        with self._frame_lock:
            if self._frame is not None:
                return True, self._frame.copy()
        return False, np.array([])

    def release(self) -> None:
        self._running = False
        if self._thread is not None:
            self._thread.join(timeout=3.0)

    @property
    def is_open(self) -> bool:
        return self._running

    @property
    def is_connected(self) -> bool:
        return self._connected
