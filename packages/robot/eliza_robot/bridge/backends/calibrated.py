"""Calibration-applier backend.

Wraps a `BridgeBackend` (typically the sim leg of a `DualTargetBackend`)
and pre-multiplies outgoing servo.set / head.set commands by the
per-joint affine map recovered from real-robot sys-ID:

    commanded_for_sim[i] = α_i * commanded[i] + β_i

The intent is sim2real compensation in the FORWARD direction: if the
real robot's hardware response is `obs = α·cmd + β`, then pre-applying
that same transform to sim means sim's observation also lands at
`α·cmd + β`, matching the real robot's state for the same agent command.

The calibration file is the JSON written by
`scripts/evidence_real_robot_sysid.py`:

    {
      "host": "192.168.1.218:9090",
      "fits": {
        "head_pan":   {"strength": 0.9886, "offset": -0.00669, ...},
        "head_tilt":  {"strength": 0.9405, "offset": -0.01254, ...},
        ...
      }
    }
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from eliza_robot.bridge.backends.base import BridgeBackend
from eliza_robot.bridge.protocol import (
    CommandEnvelope,
    EventEnvelope,
    ResponseEnvelope,
)
from eliza_robot.bridge.types import JsonDict

logger = logging.getLogger(__name__)


@dataclass
class JointCalibration:
    name: str
    strength: float
    offset: float
    rmse: float = 0.0


def load_calibration_file(
    path: str | Path,
    *,
    min_strength: float = 0.7,
    max_strength: float = 1.3,
    max_offset_rad: float = 0.1,
    max_rmse_rad: float = 0.02,
) -> dict[str, JointCalibration]:
    """Load sys-ID JSON and accept ONLY trustworthy per-joint fits.

    Filters out:
      - α outside [min_strength, max_strength]: joint didn't track our
        probe or the fit is degenerate.
      - |β| > max_offset_rad: large offsets indicate the probe window
        was far from the operating point and the linear model
        extrapolates poorly when applied to typical agent commands.
      - rmse > max_rmse_rad: noisy fits hurt more than they help.

    Joints failing any filter pass through unchanged — strictly safer
    than applying a bad linearization on top of the real robot's
    already non-trivial PD response.
    """
    raw = json.loads(Path(path).read_text())
    out: dict[str, JointCalibration] = {}
    dropped: list[tuple[str, str]] = []
    for name, fit in raw.get("fits", {}).items():
        alpha = float(fit.get("strength", 1.0))
        beta = float(fit.get("offset", 0.0))
        rmse = float(fit.get("rmse", 0.0))
        if not (min_strength <= alpha <= max_strength):
            dropped.append((name, f"α={alpha:.3f}"))
            continue
        if abs(beta) > max_offset_rad:
            dropped.append((name, f"|β|={abs(beta):.3f}"))
            continue
        if rmse > max_rmse_rad:
            dropped.append((name, f"rmse={rmse:.4f}"))
            continue
        out[name] = JointCalibration(
            name=name, strength=alpha, offset=beta, rmse=rmse,
        )
    if dropped:
        logger.warning(
            "calibration: dropped %d untrustworthy fits — %s",
            len(dropped),
            ", ".join(f"{n}({r})" for n, r in dropped[:8])
            + (" ..." if len(dropped) > 8 else ""),
        )
    logger.info(
        "calibration: accepted %d/%d fits", len(out), len(raw.get("fits", {}))
    )
    return out


class CalibratedBackend(BridgeBackend):
    """Apply per-joint affine calibration to outgoing commands.

    Wrap the SIM backend so its commands receive the same per-joint
    transformation the real robot's hardware applies internally; the
    two then converge to the same observed state under identical
    high-level agent commands.
    """

    def __init__(
        self,
        inner: BridgeBackend,
        calibration: dict[str, JointCalibration],
    ) -> None:
        self._inner = inner
        self._cal = calibration

    @classmethod
    def from_file(
        cls, inner: BridgeBackend, path: str | Path
    ) -> "CalibratedBackend":
        return cls(inner, load_calibration_file(path))

    @property
    def backend_name(self) -> str:
        return f"calibrated:{self._inner.backend_name}"

    def capabilities(self) -> JsonDict:
        caps = dict(self._inner.capabilities())
        caps["calibration_applied"] = True
        caps["calibrated_joints"] = sorted(self._cal.keys())
        return caps

    async def connect(self) -> None:
        await self._inner.connect()

    async def shutdown(self) -> None:
        await self._inner.shutdown()

    async def handle_command(self, cmd: CommandEnvelope) -> ResponseEnvelope:
        if not self._cal:
            return await self._inner.handle_command(cmd)
        new_cmd = cmd

        if cmd.command == "servo.set":
            payload = dict(cmd.payload)
            jp = payload.get("joint_positions")
            if isinstance(jp, dict):
                calibrated: dict[str, float] = {}
                for name, val in jp.items():
                    fit = self._cal.get(name)
                    if fit is None:
                        calibrated[name] = float(val)
                    else:
                        calibrated[name] = fit.strength * float(val) + fit.offset
                payload["joint_positions"] = calibrated
                new_cmd = CommandEnvelope(
                    request_id=cmd.request_id, timestamp=cmd.timestamp,
                    command=cmd.command, payload=payload, preempt=cmd.preempt,
                )
        elif cmd.command == "head.set":
            payload = dict(cmd.payload)
            pan = self._apply_one(payload.get("pan", 0.0), "head_pan")
            tilt = self._apply_one(payload.get("tilt", 0.0), "head_tilt")
            payload["pan"] = pan
            payload["tilt"] = tilt
            new_cmd = CommandEnvelope(
                request_id=cmd.request_id, timestamp=cmd.timestamp,
                command=cmd.command, payload=payload, preempt=cmd.preempt,
            )

        return await self._inner.handle_command(new_cmd)

    def _apply_one(self, val, name: str) -> float:
        fit = self._cal.get(name)
        if fit is None:
            return float(val)
        return float(fit.strength * float(val) + fit.offset)

    async def poll_events(self) -> list[EventEnvelope]:
        return await self._inner.poll_events()

    def snapshot_camera(self, camera: str = "head") -> np.ndarray | None:
        return self._inner.snapshot_camera(camera)
