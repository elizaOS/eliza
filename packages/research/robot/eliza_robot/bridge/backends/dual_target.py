"""Dual-target backend: broadcast every command to BOTH a sim and a real
backend so the MuJoCo emulator runs alongside the physical robot in
lock-step.

The agent / plugin sees a single bridge URL. Internally:

  command  ──→  [real backend] ──→ physical AiNex
           └─→  [sim  backend] ──→ MuJoCo DemoEnv

The real backend's response is what we return to the client (real
hardware is the ground truth). Telemetry events from both are
interleaved with `[real]`/`[sim]` source tags so downstream sim2real
calibration can compare the two states.

`camera.snapshot` reads from the real backend by default; pass
`{"camera": "sim"}` to read the MuJoCo render instead, or
`{"camera": "both"}` to receive a side-by-side composite.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import numpy as np

from eliza_robot.bridge.backends.base import BridgeBackend
from eliza_robot.bridge.protocol import (
    CommandEnvelope,
    EventEnvelope,
    ResponseEnvelope,
    utc_now_iso,
)
from eliza_robot.bridge.types import JsonDict


class DualTargetBackend(BridgeBackend):
    """Broadcasts to a real + sim backend; real is the source of truth."""

    def __init__(
        self,
        real: BridgeBackend,
        sim: BridgeBackend,
        *,
        sim_optional: bool = True,
    ) -> None:
        self._real = real
        self._sim = sim
        self._sim_optional = sim_optional
        # Track the most recent state snapshot from each side so we can
        # compute live sim2real divergence in poll_events.
        self._last_real_state: JsonDict | None = None
        self._last_sim_state: JsonDict | None = None

    @property
    def backend_name(self) -> str:
        return "dual_target"

    def capabilities(self) -> JsonDict:
        real_caps = self._real.capabilities()
        sim_caps = self._sim.capabilities()
        return {
            "dual_target": True,
            "real": real_caps,
            "sim": sim_caps,
            # Boolean rollup so the unified contract test still passes:
            "walk_set": bool(real_caps.get("walk_set") and sim_caps.get("walk_set")),
            "walk_command": bool(
                real_caps.get("walk_command") and sim_caps.get("walk_command")
            ),
            "action_play": bool(
                real_caps.get("action_play") and sim_caps.get("action_play")
            ),
            "head_set": bool(real_caps.get("head_set") and sim_caps.get("head_set")),
            "servo_set": bool(real_caps.get("servo_set") and sim_caps.get("servo_set")),
            "camera_snapshot": bool(
                real_caps.get("camera_snapshot") or sim_caps.get("camera_snapshot")
            ),
        }

    async def connect(self) -> None:
        await self._real.connect()
        try:
            await self._sim.connect()
        except Exception as exc:
            if not self._sim_optional:
                raise
            # Sim is optional in degraded mode (e.g. no MuJoCo on host).
            # We still serve the real path.
            print(
                f"[dual_target] sim backend unavailable ({exc}); running real-only"
            )

    async def shutdown(self) -> None:
        await asyncio.gather(
            self._real.shutdown(),
            self._sim.shutdown(),
            return_exceptions=True,
        )

    async def handle_command(self, cmd: CommandEnvelope) -> ResponseEnvelope:
        # Real is authoritative for the response envelope; sim is a side
        # effect. We fire-and-forget the sim call (with a short timeout)
        # so a stuck sim never blocks the real path.
        real_task = asyncio.create_task(self._real.handle_command(cmd))
        sim_task = asyncio.create_task(self._sim.handle_command(cmd))
        try:
            real_response = await real_task
        except Exception as exc:
            real_response = ResponseEnvelope(
                request_id=cmd.request_id,
                timestamp=utc_now_iso(),
                ok=False,
                backend=self._real.backend_name,
                message=f"real backend error: {exc}",
                data={},
            )
        # Wait briefly for sim; cancel if it lags.
        try:
            sim_response = await asyncio.wait_for(sim_task, timeout=2.0)
            sim_ok = sim_response.ok
            sim_msg = sim_response.message
        except asyncio.TimeoutError:
            sim_task.cancel()
            sim_ok = False
            sim_msg = "sim timeout"
        except Exception as exc:
            sim_ok = False
            sim_msg = str(exc)

        # Annotate the response so the client can see sim status too.
        data = dict(real_response.data)
        data["sim"] = {"ok": sim_ok, "message": sim_msg}
        return ResponseEnvelope(
            request_id=real_response.request_id,
            timestamp=real_response.timestamp,
            ok=real_response.ok,
            backend=self.backend_name,
            message=real_response.message,
            data=data,
        )

    async def poll_events(self) -> list[EventEnvelope]:
        # Pull from both sides. Tag each event so downstream consumers
        # can tell real from sim.
        real_events, sim_events = await asyncio.gather(
            self._real.poll_events(),
            self._sim.poll_events(),
            return_exceptions=True,
        )
        out: list[EventEnvelope] = []
        if isinstance(real_events, list):
            for e in real_events:
                if e.event == "telemetry.basic":
                    self._last_real_state = e.data
                out.append(self._tag(e, "real"))
        if isinstance(sim_events, list):
            for e in sim_events:
                if e.event == "telemetry.basic":
                    self._last_sim_state = e.data
                out.append(self._tag(e, "sim"))
        # Synthesise a sim2real divergence event when we have both sides.
        if self._last_real_state and self._last_sim_state:
            out.append(self._divergence_event())
        return out

    def _tag(self, event: EventEnvelope, source: str) -> EventEnvelope:
        return EventEnvelope(
            event=event.event,
            timestamp=event.timestamp,
            backend=f"{self.backend_name}:{source}",
            data={**event.data, "source": source},
        )

    def _divergence_event(self) -> EventEnvelope:
        real = self._last_real_state or {}
        sim = self._last_sim_state or {}
        fields = (
            "walk_x", "walk_y", "walk_yaw",
            "imu_roll", "imu_pitch",
            "head_pan", "head_tilt",
        )
        deltas = {f: float(real.get(f, 0.0)) - float(sim.get(f, 0.0)) for f in fields}
        rms = float(np.sqrt(np.mean(np.square(list(deltas.values())))))
        return EventEnvelope(
            event="sim2real.divergence",
            timestamp=utc_now_iso(),
            backend=self.backend_name,
            data={"deltas": deltas, "rms": rms, "tracked_at": time.time()},
        )

    def snapshot_camera(self, camera: str = "head") -> np.ndarray | None:
        if camera == "sim":
            return self._sim.snapshot_camera("head")
        if camera == "real" or camera == "head":
            return self._real.snapshot_camera("head")
        if camera == "both":
            real = self._real.snapshot_camera("head")
            sim = self._sim.snapshot_camera("head")
            if real is None and sim is None:
                return None
            if real is None:
                return sim
            if sim is None:
                return real
            # Resize sim to real's height for a horizontal side-by-side.
            target_h = real.shape[0]
            target_w_sim = int(sim.shape[1] * target_h / sim.shape[0])
            try:
                import cv2

                sim_scaled = cv2.resize(sim, (target_w_sim, target_h))
            except Exception:
                sim_scaled = sim
            return np.concatenate([real, sim_scaled], axis=1)
        return self._real.snapshot_camera(camera)
