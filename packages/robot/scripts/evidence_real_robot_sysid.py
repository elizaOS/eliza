"""Sys-ID against the PHYSICAL AiNex.

Runs the same closed-form least-squares fit used by the dual-sim
calibration, but pointed at `AinexRemoteBackend` instead of a noisy
MuJoCo twin. Recovers the real robot's per-joint motor-strength α
and offset β.

The recovered parameters are stored at
`packages/robot/calibration/ainex_<host>.json` and consumed by the
`CalibratedDualTargetBackend` so the sim leg of sim+real co-execution
matches the real robot's observed state.

SAFETY:
  - Probes head + arms + grippers only. NO leg joints (would tip the
    robot from a standing pose).
  - 0.5 s settle time per probe; total wall-clock ~75 s for 12 joints
    × 5 probes = 60 motions.
  - Always parks at `stand` before and after.

Usage:
    python scripts/evidence_real_robot_sysid.py \
        --host 192.168.1.218 --port 9090
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import asdict
from pathlib import Path

from eliza_robot.bridge.backends.ainex_remote import AinexRemoteBackend
from eliza_robot.sim2real.sysid import (
    PROBE_ANGLES,
    SAFE_PROBE_JOINTS,
    JointFit,
    run_sysid,
)


async def main_async(args) -> int:
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[real-sysid] connecting to ws://{args.host}:{args.port}...")
    backend = AinexRemoteBackend(host=args.host, port=args.port)
    await backend.connect()
    await asyncio.sleep(1.0)  # let telemetry warm up
    print("[real-sysid] connected — probing safe joints only:")
    for j in SAFE_PROBE_JOINTS:
        print(f"  - {j}")
    print()

    try:
        fits = await run_sysid(backend, joints=SAFE_PROBE_JOINTS, angles=PROBE_ANGLES)
    finally:
        await backend.shutdown()

    # Persist the fits so the calibrated dual-target backend can load them.
    payload = {
        "host": f"{args.host}:{args.port}",
        "probe_angles_rel_home": list(PROBE_ANGLES),
        "fits": {name: asdict(fit) for name, fit in fits.items()},
    }
    (out_dir / "ainex_calibration.json").write_text(json.dumps(payload, indent=2))
    print(f"\n[real-sysid] wrote {out_dir / 'ainex_calibration.json'} ({len(fits)} joints)")

    # Stable on disk for the dual-target backend to pick up.
    cal_path = (
        Path(__file__).resolve().parents[1]
        / "calibration"
        / f"ainex_{args.host.replace('.', '_')}.json"
    )
    cal_path.parent.mkdir(parents=True, exist_ok=True)
    cal_path.write_text(json.dumps(payload, indent=2))
    print(f"[real-sysid] also wrote {cal_path}")

    # Summary
    print()
    print(f"{'joint':>14s}  {'α (strength)':>14s}  {'β (offset, mrad)':>18s}  {'fit RMSE (mrad)':>18s}")
    print("-" * 72)
    for name, fit in fits.items():
        print(
            f"{name:>14s}  {fit.strength:>+14.4f}  {fit.offset*1000:>+18.2f}  {fit.rmse*1000:>18.2f}"
        )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="192.168.1.218")
    parser.add_argument("--port", type=int, default=9090)
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "examples"
        / "robot-mujoco-demo"
        / "evidence"
        / "real_robot_sysid",
    )
    args = parser.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
