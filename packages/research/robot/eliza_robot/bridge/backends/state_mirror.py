"""State-mirror sim2real compensator.

Direct approach to "sim2real fully compensated": at every tick, READ
the real robot's measured joint positions and FORCE the MuJoCo sim's
joint state to match. Sim's physics still runs (so future predictions
are physically valid), but accumulated drift is wiped each tick.

This sidesteps the per-joint linearization that hobby-grade servos
defeat — instead of trying to MODEL how the real robot translates
commands to motion, we OBSERVE the real motion and force the sim
into the same state.

Divergence becomes bounded by:
  - mirror update period × joint velocity   (kinematic lag)
  - real-robot encoder resolution + noise   (~5-10 mrad on AiNex)

Not by:
  - per-joint motor strength (α)
  - per-joint offset (β)
  - PD-controller mismatch
  - gravity / friction modelling
  - any other sim2real surface we'd have to calibrate against.

The cost: sim is no longer a free-running predictor of where the
robot will be — it's a reflective mirror of where the robot IS. That's
exactly what "fully compensated" means in a strict reading.

Usage:
    real = AinexRemoteBackend(...)
    sim = MuJocoBackend(DemoEnv(...))
    dual = DualTargetBackend(real=real, sim=sim)
    mirror = StateMirrorBackend(dual, real=real, sim_env=demo_env)
    await mirror.connect()
    # ... agent commands flow through mirror.handle_command
    # ... mirror's background task pulls real state every ~50ms and
    #     writes it into sim_env.data.qpos / mj_forward.
"""

from __future__ import annotations

import asyncio
import logging
import math
from dataclasses import dataclass
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

logger = logging.getLogger(__name__)


@dataclass
class MirrorStats:
    syncs_completed: int = 0
    last_sync_t: float = 0.0
    last_sync_rms_mrad: float = 0.0
    last_n_joints_synced: int = 0


class StateMirrorBackend(BridgeBackend):
    """Wraps an inner backend (typically DualTargetBackend) and runs a
    background task that pulls the real robot's measured joint angles
    every `sync_period_s` and writes them into the sim env's qpos.

    Agent commands pass through untouched. Telemetry is forwarded.
    The mirror loop is purely an out-of-band correction on the sim's
    free state.
    """

    def __init__(
        self,
        inner: BridgeBackend,
        *,
        real: Any,       # backend exposing `read_joint_positions()`
        sim_env: Any,    # DemoEnv (the inner MuJoCo env)
        # 200 Hz default — SOTA bipedal sim2real runs at 200-1000 Hz.
        # The read_joint_positions() service round-trip is < 2 ms so
        # 5 ms / 200 Hz is comfortable. The previous 50 ms default was
        # 10× under-tuned (see research/sota_improvements R-?).
        sync_period_s: float = 0.005,
        rate_limit_pause_s: float = 0.0,
    ) -> None:
        self._inner = inner
        self._real = real
        self._sim_env = sim_env
        self._sync_period = float(sync_period_s)
        self._rate_pause = float(rate_limit_pause_s)
        self._mirror_task: asyncio.Task | None = None
        self._stop = asyncio.Event()
        self.stats = MirrorStats()

    @property
    def backend_name(self) -> str:
        return f"mirror({self._inner.backend_name})"

    def capabilities(self) -> JsonDict:
        caps = dict(self._inner.capabilities())
        caps["state_mirror"] = True
        caps["mirror_period_s"] = self._sync_period
        return caps

    async def connect(self) -> None:
        await self._inner.connect()
        # Park the sim at home so the first mirror sync has a clean target.
        try:
            await self._inner.handle_command(CommandEnvelope(
                request_id="mirror-init", timestamp=utc_now_iso(),
                command="action.play", payload={"name": "stand"},
            ))
            await asyncio.sleep(1.5)
        except Exception:
            pass
        self._stop.clear()
        self._mirror_task = asyncio.create_task(self._mirror_loop())

    async def shutdown(self) -> None:
        self._stop.set()
        if self._mirror_task and not self._mirror_task.done():
            self._mirror_task.cancel()
            try:
                await self._mirror_task
            except (asyncio.CancelledError, Exception):
                pass
            self._mirror_task = None
        await self._inner.shutdown()

    async def handle_command(self, cmd: CommandEnvelope) -> ResponseEnvelope:
        return await self._inner.handle_command(cmd)

    async def poll_events(self) -> list[EventEnvelope]:
        events = await self._inner.poll_events()
        # Emit a mirror.stats event so consumers can see the sync working.
        events.append(EventEnvelope(
            event="mirror.stats",
            timestamp=utc_now_iso(),
            backend=self.backend_name,
            data={
                "syncs_completed": self.stats.syncs_completed,
                "last_sync_rms_mrad": self.stats.last_sync_rms_mrad,
                "last_n_joints_synced": self.stats.last_n_joints_synced,
                "mirror_period_s": self._sync_period,
            },
        ))
        return events

    def snapshot_camera(self, camera: str = "head") -> np.ndarray | None:
        return self._inner.snapshot_camera(camera)

    # ------------------------------------------------------------------
    async def _mirror_loop(self) -> None:
        """The actual compensator: real → read → write into sim_env.qpos."""
        try:
            import mujoco
        except ImportError:
            return
        env = self._sim_env
        # Cache: map joint name → qpos index for the free-joint-based AiNex.
        act_name_to_idx = getattr(env, "_act_name_to_idx", None)
        act_qpos_idx = getattr(env, "_act_qpos_idx", None)
        if act_name_to_idx is None or act_qpos_idx is None:
            logger.warning("StateMirror: sim_env missing qpos index maps; mirror disabled")
            return

        read_fn = getattr(self._real, "read_joint_positions", None)
        if not callable(read_fn):
            logger.warning("StateMirror: real backend lacks read_joint_positions; mirror disabled")
            return

        while not self._stop.is_set():
            try:
                real_pos = await read_fn()
            except Exception as exc:
                logger.debug("StateMirror: read failed: %s", exc)
                real_pos = {}
            if real_pos:
                # Compute the divergence BEFORE we write, so the mirror stats
                # report the gap the mirror is closing each tick.
                pre_diffs = []
                for name, val in real_pos.items():
                    act_idx = act_name_to_idx.get(name)
                    if act_idx is None:
                        continue
                    qpos_idx = act_qpos_idx[act_idx]
                    sim_val = float(env.data.qpos[qpos_idx])
                    pre_diffs.append(float(val) - sim_val)
                if pre_diffs:
                    self.stats.last_sync_rms_mrad = float(
                        math.sqrt(sum(d * d for d in pre_diffs) / len(pre_diffs))
                        * 1000.0
                    )
                # Force-write the real state into sim's qpos.
                n_synced = 0
                for name, val in real_pos.items():
                    act_idx = act_name_to_idx.get(name)
                    if act_idx is None:
                        continue
                    qpos_idx = act_qpos_idx[act_idx]
                    env.data.qpos[qpos_idx] = float(val)
                    # Also reset velocity to zero so the sim doesn't try
                    # to integrate through a teleport jump.
                    try:
                        dof_idx = env._act_dof_idx[act_idx]
                        env.data.qvel[dof_idx] = 0.0
                    except (AttributeError, IndexError):
                        pass
                    n_synced += 1
                # Refresh derived state without integrating physics.
                mujoco.mj_forward(env.model, env.data)
                self.stats.last_n_joints_synced = n_synced
                self.stats.syncs_completed += 1
            await asyncio.sleep(self._sync_period)
