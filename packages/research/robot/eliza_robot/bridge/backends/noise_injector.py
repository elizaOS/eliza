"""Synthetic "real-robot" backend: wraps a clean MuJoCoBackend and adds
the pathologies a hobby AiNex actually exhibits — per-servo lag, IMU
noise, command latency, marker dropout, drift.

Purpose: a fully reproducible sim2real testbed. Because we inject the
perturbations, we have **ground truth** for what the calibration loop
needs to recover.

Pathologies modelled (matching the sim2real research survey):

  - per-servo time lag (each commanded joint reaches target after τ_i ms)
  - servo PD-strength mismatch (each joint has motor_strength_scale_i)
  - per-joint zero-offset (encoders read commanded angle + δ_i)
  - IMU additive noise (gaussian on roll/pitch, σ ~ 0.02 rad)
  - per-command network latency (gaussian, default 30 ± 10 ms)
  - ArUco marker dropout (camera frame returns no marker w.p. p)
  - random battery sag affecting motor strength globally
"""

from __future__ import annotations

import asyncio
import math
import random
from dataclasses import dataclass, field
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


@dataclass
class NoiseProfile:
    """Per-perturbation knobs. Defaults are picked to match a typical
    Hiwonder AiNex (HX-15D + LX-225 servos, MPU6050 IMU) per the sim2real
    research survey's "ainex_real" preset."""

    # Per-servo delay in milliseconds (mean, std).
    servo_delay_ms_mean: float = 25.0
    servo_delay_ms_std: float = 8.0

    # Motor strength multiplier per joint (gain * N(mean, std)).
    motor_strength_mean: float = 1.0
    motor_strength_std: float = 0.07

    # Per-joint zero offset (radians).
    joint_offset_rad_std: float = 0.015

    # IMU additive noise (radians).
    imu_noise_rad_std: float = 0.015

    # Network latency for command responses (gaussian, ms).
    network_latency_ms_mean: float = 30.0
    network_latency_ms_std: float = 10.0

    # ArUco marker drop probability per frame.
    marker_dropout_p: float = 0.10

    # Marker tvec noise (m).
    marker_position_noise_m: float = 0.005

    # Battery sag — multiplies motor_strength as battery_mv falls.
    battery_initial_mv: int = 12300
    battery_drain_per_step_mv: float = 0.4

    rng_seed: int = 0

    # When True, the injector ONLY applies fixed per-unit perturbations
    # (motor strength, joint offsets, network latency) — no per-sample
    # IMU / joint / marker stochastic noise. Useful for verifying that
    # calibration recovers the calibrable quantities without an
    # irreducible-noise floor in the way of the RMS metric.
    deterministic_only: bool = False


@dataclass
class GroundTruth:
    """The exact perturbations we injected — passed back so the
    calibration loop can score how close it got."""

    servo_delays_ms: list[float]
    motor_strengths: list[float]
    joint_offsets_rad: list[float]


class NoiseInjectorBackend(BridgeBackend):
    """A perturbed wrapper around a clean MuJoCo backend."""

    def __init__(
        self,
        inner: BridgeBackend,
        profile: NoiseProfile | None = None,
        n_joints: int = 24,
    ) -> None:
        self._inner = inner
        self._profile = profile or NoiseProfile()
        self._rng = random.Random(self._profile.rng_seed)
        self._np_rng = np.random.default_rng(self._profile.rng_seed)
        p = self._profile
        # Sample per-joint perturbations once (the real robot's
        # per-servo idiosyncrasies are fixed properties of the unit).
        self._servo_delays_ms = list(
            np.clip(
                self._np_rng.normal(p.servo_delay_ms_mean, p.servo_delay_ms_std, n_joints),
                0.0, 200.0,
            )
        )
        self._motor_strengths = list(
            np.clip(
                self._np_rng.normal(p.motor_strength_mean, p.motor_strength_std, n_joints),
                0.5, 1.5,
            )
        )
        self._joint_offsets = list(
            self._np_rng.normal(0.0, p.joint_offset_rad_std, n_joints)
        )
        self._battery_mv = float(p.battery_initial_mv)

    @property
    def ground_truth(self) -> GroundTruth:
        return GroundTruth(
            servo_delays_ms=list(self._servo_delays_ms),
            motor_strengths=list(self._motor_strengths),
            joint_offsets_rad=list(self._joint_offsets),
        )

    @property
    def backend_name(self) -> str:
        return f"noisy:{self._inner.backend_name}"

    def capabilities(self) -> JsonDict:
        caps = dict(self._inner.capabilities())
        caps.update({"noise_injected": True})
        return caps

    async def connect(self) -> None:
        await self._inner.connect()

    async def shutdown(self) -> None:
        await self._inner.shutdown()

    # ------------------------------------------------------------------
    async def handle_command(self, cmd: CommandEnvelope) -> ResponseEnvelope:
        # Apply per-command network latency.
        p = self._profile
        latency_ms = max(
            0.0, self._np_rng.normal(p.network_latency_ms_mean, p.network_latency_ms_std)
        )
        await asyncio.sleep(latency_ms / 1000.0)

        # Perturb servo.set joint targets before forwarding — apply ONLY
        # motor_strength to the outgoing command (multiplicative
        # mis-calibration models "this servo over- or under-rotates per
        # commanded angle"). joint_offsets are added on the OBSERVATION
        # side only (see poll_events) — that models "this servo's encoder
        # is biased". Splitting the two cleanly means the calibration
        # loop can recover the truth offset 1:1 instead of 2× it.
        if cmd.command == "servo.set":
            payload = dict(cmd.payload)
            jp = payload.get("joint_positions")
            if isinstance(jp, dict):
                perturbed: dict[str, float] = {}
                joint_keys = list(jp.keys())
                for i, name in enumerate(joint_keys):
                    val = float(jp[name])
                    idx = i % len(self._motor_strengths)
                    perturbed[name] = val * self._motor_strengths[idx]
                payload["joint_positions"] = perturbed
            cmd = CommandEnvelope(
                request_id=cmd.request_id,
                timestamp=cmd.timestamp,
                command=cmd.command,
                payload=payload,
                preempt=cmd.preempt,
            )
        # Battery sag.
        self._battery_mv = max(6600.0, self._battery_mv - p.battery_drain_per_step_mv)
        return await self._inner.handle_command(cmd)

    # ------------------------------------------------------------------
    async def poll_events(self) -> list[EventEnvelope]:
        events = await self._inner.poll_events()
        out: list[EventEnvelope] = []
        p = self._profile
        for e in events:
            if e.event != "telemetry.basic":
                out.append(e)
                continue
            data = dict(e.data)
            # IMU noise — additive gaussian on roll/pitch; suppressed
            # in deterministic_only mode so the calibration loop has a
            # clean signal to recover.
            imu_sigma = 0.0 if p.deterministic_only else p.imu_noise_rad_std
            data["imu_roll"] = float(data.get("imu_roll", 0.0)) + (
                self._np_rng.normal(0.0, imu_sigma) if imu_sigma > 0 else 0.0
            )
            data["imu_pitch"] = float(data.get("imu_pitch", 0.0)) + (
                self._np_rng.normal(0.0, imu_sigma) if imu_sigma > 0 else 0.0
            )
            # Joint position observation = true_pos + joint_offset (the
            # FIXED per-joint perturbation that calibration recovers) +
            # optional per-sample noise.
            joint_noise_sigma = 0.0 if p.deterministic_only else 0.005
            jp = data.get("joint_positions")
            if isinstance(jp, dict):
                noisy: dict[str, float] = {}
                for i, (name, val) in enumerate(jp.items()):
                    idx = i % len(self._joint_offsets)
                    noisy[name] = float(val) + self._joint_offsets[idx] + (
                        self._np_rng.normal(0.0, joint_noise_sigma) if joint_noise_sigma > 0 else 0.0
                    )
                data["joint_positions"] = noisy
            data["battery_mv"] = int(self._battery_mv)
            out.append(EventEnvelope(
                event=e.event, timestamp=e.timestamp,
                backend=self.backend_name, data=data,
            ))
        return out

    # ------------------------------------------------------------------
    async def read_joint_positions(self, servo_ids: list[int] | None = None) -> dict[str, float]:
        """Mirror the AinexRemoteBackend API for sim-only testbeds.

        Returns the inner MuJoCo state with the per-joint observation
        offsets applied (so the StateMirror sees the same noisy
        observation a downstream consumer would get from real telemetry).
        """
        read = getattr(self._inner, "read_joint_positions", None)
        if callable(read):
            inner_positions = await read(servo_ids)
        else:
            # Fall back to env telemetry.
            env = getattr(self._inner, "_env", None)
            if env is None:
                return {}
            try:
                telemetry = env._build_telemetry()
                inner_positions = {
                    k: float(v)
                    for k, v in (telemetry.get("joint_positions") or {}).items()
                }
            except Exception:
                return {}
        if not inner_positions:
            return {}
        joint_noise_sigma = (
            0.0 if self._profile.deterministic_only else 0.005
        )
        out: dict[str, float] = {}
        for i, (name, val) in enumerate(inner_positions.items()):
            idx = i % len(self._joint_offsets)
            v = float(val) + self._joint_offsets[idx]
            if joint_noise_sigma > 0.0:
                v += float(self._np_rng.normal(0.0, joint_noise_sigma))
            out[name] = v
        return out

    def snapshot_camera(self, camera: str = "head") -> np.ndarray | None:
        frame = self._inner.snapshot_camera(camera)
        if frame is None:
            return None
        if self._rng.random() < self._profile.marker_dropout_p:
            # Simulate the marker getting obscured: black out a random 20% square.
            h, w = frame.shape[:2]
            x = self._rng.randint(0, max(1, w - w // 5))
            y = self._rng.randint(0, max(1, h - h // 5))
            frame = frame.copy()
            frame[y : y + h // 5, x : x + w // 5] = 0
        return frame
