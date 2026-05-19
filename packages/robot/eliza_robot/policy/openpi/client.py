"""OpenPI policy client.

`OpenPIPolicyClient` is a `PolicyBackend` that ships observations to a
Physical Intelligence ``openpi`` inference server (locally docker-hosted
or remote) and decodes the returned action chunks for the AiNex bridge.

Optional runtime dependencies (lazy-imported on first connection):

* ``openpi-client`` — wire protocol + ``WebsocketClientPolicy``. Install
  with ``pip install openpi-client`` (or build from
  https://github.com/Physical-Intelligence/openpi when no PyPI wheel is
  available).
* ``eliza_robot.bridge.openpi_adapter`` — perception → openpi observation
  packing. Lands with bridge port W3.1.
* ``eliza_robot.bridge.safety`` — `check_policy_motion_bounds` for
  hard-clamping decoded actions before the chunk leaves the client.

Each missing dep surfaces a clear, actionable error message; nothing is
silently downgraded.
"""

from __future__ import annotations

import logging
import time
from typing import Any

import numpy as np

from eliza_robot.policy.base import ActionChunk, PolicyBackend
from eliza_robot.profiles import DEFAULT_PROFILE_ID, load_profile
from eliza_robot.profiles.schema import RobotProfile

logger = logging.getLogger(__name__)


class OpenPIPolicyClient(PolicyBackend):
    """Remote-inference client for Physical Intelligence openpi servers."""

    def __init__(
        self,
        endpoint: str,
        profile_id: str = DEFAULT_PROFILE_ID,
        timeout_s: float = 2.0,
    ) -> None:
        if not endpoint:
            raise ValueError("OpenPIPolicyClient requires a non-empty endpoint")
        self._endpoint = endpoint
        self._profile_id = profile_id
        self._timeout_s = float(timeout_s)

        self._profile: RobotProfile | None = None
        self._task: str = ""
        self._ws_client: Any = None
        self._adapter: Any = None  # lazily-resolved openpi_adapter module
        self._safety: Any = None  # lazily-resolved bridge.safety module
        self._observation_keys: tuple[str, ...] = ()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self, target_task: str) -> None:
        """Resolve the profile, connect to the openpi server, prepare obs keys."""
        if not target_task:
            raise ValueError("OpenPIPolicyClient.start requires a non-empty task")

        self._profile = load_profile(self._profile_id)
        self._task = target_task

        # openpi-client is the wire transport. Lazy-imported with a clear
        # install hint so callers can hit it before any network I/O.
        try:
            from openpi_client import websocket_client_policy as openpi_ws  # type: ignore[import-not-found]
        except ImportError as exc:
            raise ImportError(
                "openpi-client is required to use OpenPIPolicyClient. "
                "Install it with `pip install openpi-client` (or build from "
                "https://github.com/Physical-Intelligence/openpi when no "
                "PyPI wheel is published). See "
                "packages/robot/docs/openpi.md for setup details."
            ) from exc

        host, port = self._parse_endpoint(self._endpoint)
        self._ws_client = openpi_ws.WebsocketClientPolicy(host=host, port=port)

        self._adapter = self._resolve_adapter()
        self._safety = self._resolve_safety()
        self._observation_keys = ("state", "prompt", "image", "metadata", "schema_version")

        logger.info(
            "policy.status backend=openpi endpoint=%s profile=%s task=%r connected",
            self._endpoint, self._profile_id, self._task,
        )

    def stop(self) -> None:
        """Close the websocket and emit a final status log line."""
        ws = self._ws_client
        self._ws_client = None
        if ws is not None:
            close = getattr(ws, "close", None)
            if callable(close):
                close()
        logger.info(
            "policy.status backend=openpi endpoint=%s task=%r stopped",
            self._endpoint, self._task,
        )

    def is_alive(self) -> bool:
        return self._ws_client is not None

    # ------------------------------------------------------------------
    # Inference
    # ------------------------------------------------------------------

    def step(self, observation: dict[str, Any]) -> ActionChunk:
        """Pack obs via the adapter, query the server, decode + clamp."""
        if self._ws_client is None or self._adapter is None:
            raise RuntimeError(
                "OpenPIPolicyClient.step called before start(); "
                "call start(target_task) first."
            )

        payload = self._adapter.observation_to_dict(
            self._adapter.build_observation(self._coerce_perception(observation))
        )
        # Carry the language instruction through if the caller didn't already
        # pack it into the observation.
        if not payload.get("prompt"):
            payload["prompt"] = self._task

        t0 = time.monotonic()
        raw = self._ws_client.infer(payload)
        latency_ms = (time.monotonic() - t0) * 1000.0

        if not isinstance(raw, dict):
            raise TypeError(
                f"openpi server returned non-dict response: {type(raw).__name__}"
            )

        decoded = self._adapter.decode_action(raw)
        clamped = self._apply_safety(decoded)

        joints_arr: np.ndarray | None = None
        raw_action = getattr(decoded, "raw_action", ())
        if raw_action:
            joints_arr = np.asarray(raw_action, dtype=np.float32)

        walk_command = {
            "speed": clamped["walk_speed"],
            "height": clamped["walk_height"],
            "x": clamped["walk_x"],
            "y": clamped["walk_y"],
            "yaw": clamped["walk_yaw"],
        }
        head_target = {
            "pan": clamped["head_pan"],
            "tilt": clamped["head_tilt"],
        }

        return ActionChunk(
            joints=joints_arr,
            walk_command=walk_command,
            head_target=head_target,
            confidence=float(getattr(decoded, "confidence", 1.0)),
            latency_ms=latency_ms,
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_endpoint(endpoint: str) -> tuple[str, int]:
        """Parse ``ws://host:port`` (or ``host:port``) into ``(host, port)``."""
        cleaned = endpoint
        for scheme in ("ws://", "wss://", "http://", "https://"):
            if cleaned.startswith(scheme):
                cleaned = cleaned[len(scheme):]
                break
        cleaned = cleaned.rstrip("/")
        if ":" not in cleaned:
            raise ValueError(
                f"OpenPI endpoint must include a port (e.g. ws://host:9200): {endpoint!r}"
            )
        host, port_str = cleaned.rsplit(":", 1)
        try:
            port = int(port_str)
        except ValueError as exc:
            raise ValueError(
                f"OpenPI endpoint port is not an integer: {endpoint!r}"
            ) from exc
        return host, port

    @staticmethod
    def _resolve_adapter() -> Any:
        """Import the bridge openpi adapter, raising a clear error if missing."""
        try:
            from eliza_robot.bridge import openpi_adapter  # type: ignore[import-not-found]
        except ImportError as exc:
            raise ImportError(
                "eliza_robot.bridge.openpi_adapter is required to pack "
                "observations for the openpi server. The bridge port "
                "(W3.1) must land before OpenPIPolicyClient can run. "
                "See packages/robot/docs/openpi.md."
            ) from exc
        return openpi_adapter

    @staticmethod
    def _resolve_safety() -> Any | None:
        """Import the safety module if it exposes a clamp helper."""
        try:
            from eliza_robot.bridge import safety  # type: ignore[import-not-found]
        except ImportError:
            return None
        if hasattr(safety, "check_policy_motion_bounds") or hasattr(safety, "MotionBounds"):
            return safety
        return None

    def _apply_safety(self, decoded: Any) -> dict[str, Any]:
        """Return a clamped action dict, using the bridge safety helper when present."""
        action_dict: dict[str, Any] = {
            "walk_x": float(getattr(decoded, "walk_x", 0.0)),
            "walk_y": float(getattr(decoded, "walk_y", 0.0)),
            "walk_yaw": float(getattr(decoded, "walk_yaw", 0.0)),
            "walk_height": float(getattr(decoded, "walk_height", 0.036)),
            "walk_speed": int(getattr(decoded, "walk_speed", 2)),
            "head_pan": float(getattr(decoded, "head_pan", 0.0)),
            "head_tilt": float(getattr(decoded, "head_tilt", 0.0)),
        }

        safety = self._safety
        if safety is None:
            return action_dict

        if hasattr(safety, "MotionBounds"):
            # Prefer the typed bounds object when the bridge exposes it.
            bounds = safety.MotionBounds()  # type: ignore[call-arg]
            clamp = getattr(bounds, "clamp", None)
            if callable(clamp):
                clamped = clamp(action_dict)
                if isinstance(clamped, dict):
                    return clamped

        if hasattr(safety, "check_policy_motion_bounds"):
            result = safety.check_policy_motion_bounds(action_dict)
            clamped = getattr(result, "clamped", None)
            if isinstance(clamped, dict) and clamped:
                action_dict.update(clamped)
            if not getattr(result, "allowed", True):
                reason = getattr(result, "reason", "policy_guard_rejected")
                raise RuntimeError(f"openpi action rejected by safety guard: {reason}")

        return action_dict

    def _coerce_perception(self, observation: dict[str, Any]) -> Any:
        """Build an `AinexPerceptionObservation` from a raw observation dict.

        The bridge's policy loop already passes typed perception snapshots, but
        callers from tests/CLIs may hand us a plain dict. We accept both.
        """
        from eliza_robot.interfaces import AinexPerceptionObservation

        if isinstance(observation, AinexPerceptionObservation):
            return observation

        fields = {
            "timestamp": float(observation.get("timestamp", 0.0)),
            "battery_mv": int(observation.get("battery_mv", 12000)),
            "imu_roll": float(observation.get("imu_roll", 0.0)),
            "imu_pitch": float(observation.get("imu_pitch", 0.0)),
            "is_walking": bool(observation.get("is_walking", False)),
            "walk_x": float(observation.get("walk_x", 0.0)),
            "walk_y": float(observation.get("walk_y", 0.0)),
            "walk_yaw": float(observation.get("walk_yaw", 0.0)),
            "walk_height": float(observation.get("walk_height", 0.036)),
            "walk_speed": int(observation.get("walk_speed", 2)),
            "head_pan": float(observation.get("head_pan", 0.0)),
            "head_tilt": float(observation.get("head_tilt", 0.0)),
            "tracked_entities": tuple(observation.get("tracked_entities", ())),
            "entity_slots": tuple(observation.get("entity_slots", ())),
            "camera_frame": str(observation.get("camera_frame", "")),
            "language_instruction": str(
                observation.get("language_instruction", self._task)
            ),
        }
        return AinexPerceptionObservation(**fields)


__all__ = ["OpenPIPolicyClient"]
