"""Full 24-joint sys-ID against the physical AiNex.

Probes every joint with small deltas around its current measured pose
(legs ±0.03 rad, arms ±0.05, head ±0.10), re-standing between groups.
Writes the resulting calibration to:

    packages/robot/calibration/ainex_<host>_full.json

This is the complete calibration set for sim2real compensation —
includes the 12 leg joints the original (safe-subset) sys-ID
intentionally skipped, plus a re-probe of the 2 arm joints that
previously failed to track.

SAFETY: each leg probe is ±0.03 rad (~1.7°). One joint at a time.
Robot returns to `stand` between groups. If a single probe takes the
robot off-balance, the subsequent stand should recover it.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import asdict
from pathlib import Path

from eliza_robot.bridge.backends.ainex_remote import AinexRemoteBackend
from eliza_robot.sim2real.sysid_full import run_full_sysid


async def main_async(args) -> int:
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[full-sysid] connecting to ws://{args.host}:{args.port}...")
    backend = AinexRemoteBackend(host=args.host, port=args.port)
    await backend.connect()
    await asyncio.sleep(1.0)

    try:
        fits = await run_full_sysid(backend, settle_s=args.settle_s)
    finally:
        await backend.shutdown()

    payload = {
        "host": f"{args.host}:{args.port}",
        "fits": {name: asdict(fit) for name, fit in fits.items()},
    }
    (out_dir / "ainex_full_calibration.json").write_text(
        json.dumps(payload, indent=2)
    )
    cal_path = (
        Path(__file__).resolve().parents[1] / "calibration"
        / f"ainex_{args.host.replace('.', '_')}_full.json"
    )
    cal_path.parent.mkdir(parents=True, exist_ok=True)
    cal_path.write_text(json.dumps(payload, indent=2))
    print(f"\n[full-sysid] wrote {cal_path}")
    print(f"[full-sysid] {len(fits)} joints fit (out of 24)")

    # Compact summary
    print()
    print(f"{'joint':>14s}  {'α':>7s}  {'β (mrad)':>10s}  {'rmse':>8s}")
    print("-" * 50)
    for name, fit in fits.items():
        print(
            f"{name:>14s}  {fit.strength:>+7.3f}  "
            f"{fit.offset*1000:>+8.2f}  {fit.rmse*1000:>6.2f}"
        )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="192.168.1.218")
    parser.add_argument("--port", type=int, default=9090)
    parser.add_argument("--settle-s", type=float, default=0.45)
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "examples"
        / "robot-mujoco-demo"
        / "evidence"
        / "full_sysid",
    )
    args = parser.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
