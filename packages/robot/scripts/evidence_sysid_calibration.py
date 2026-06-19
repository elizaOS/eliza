"""Direct system-ID calibration evidence.

Runs the textbook closed-form fit: probe each joint at multiple angles,
observe steady-state, solve `q_obs = α q_cmd + β` per joint by least
squares. Two seconds per probe × 5 probes × ~12 safe joints = ~2 min.

Outputs in `--out`:
  - sysid_report.json — per-joint (α, β, rmse), truth vs recovered
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from eliza_robot.bridge.backends.noise_injector import NoiseProfile
from eliza_robot.sim2real.sysid import calibrate_via_sysid


async def main_async(args) -> int:
    profile = NoiseProfile(
        rng_seed=args.seed,
        deterministic_only=args.deterministic,
    )
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    result = await calibrate_via_sysid(noise_profile=profile, out_dir=out)
    print()
    print("=" * 60)
    print(f"Baseline RMS divergence: {result.baseline_rms_total*1000:.2f} mrad")
    print(f"Final RMS divergence:    {result.final_rms_total*1000:.2f} mrad")
    print(f"Reduction:               {result.reduction_pct:.1f}%")
    print(f"Per-joint offset recovery error: {result.offset_recovery_err_mrad:.2f} mrad")
    print(f"Per-joint strength recovery error: {result.strength_recovery_err*100:.2f}%")
    print()
    print(f"{'joint':>14s}  {'truth_off':>10s}  {'recovered':>10s}  {'truth_α':>8s}  {'recovered':>10s}")
    print("-" * 65)
    for name, fit in result.fits.items():
        truth_off = (result.truth_offsets_rad or {}).get(name, 0.0)
        truth_str = (result.truth_strengths or {}).get(name, 1.0)
        print(
            f"{name:>14s}  {truth_off*1000:>+8.2f}mr  "
            f"{fit.offset*1000:>+8.2f}mr  {truth_str:>+8.4f}  {fit.strength:>+10.4f}"
        )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--deterministic", action="store_true", default=True)
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "examples"
        / "robot-mujoco-demo"
        / "evidence"
        / "sysid_calibration",
    )
    args = parser.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
