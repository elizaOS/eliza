"""Dual-sim sim2real calibration evidence.

Architecture:
    clean MuJoCo  ←─ same commands ─→  noisy MuJoCo (NoiseInjector)

The noisy sim stands in for the real AiNex. The calibration loop tunes
the clean sim's per-joint motor-strength and offset until its trajectory
matches the noisy one. Because we *injected* the perturbations, we have
ground truth — the report compares recovered parameters to the truth.

Outputs in `--out`:
  - calibration_report.json  full numerical history, recovered vs truth
  - convergence_plot.png     RMS divergence per iteration
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from eliza_robot.bridge.backends.noise_injector import NoiseProfile
from eliza_robot.sim2real.calibration import calibrate


def _plot_convergence(out_dir: Path, summary: dict) -> None:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return
    history = summary["history"]
    iters = [h["iter"] for h in history]
    rms_total = [h["rms_total"] for h in history]
    rms_imu = [h["rms_imu"] for h in history]
    rms_joint = [h["rms_joint"] for h in history]
    fig, ax = plt.subplots(figsize=(8, 4))
    ax.plot(iters, rms_total, "k-", lw=2, label="total")
    ax.plot(iters, rms_imu, "b--", label="IMU (roll+pitch)")
    ax.plot(iters, rms_joint, "r--", label="joint positions")
    ax.set_xlabel("iteration")
    ax.set_ylabel("RMS divergence (rad)")
    ax.set_title("dual-sim calibration convergence")
    ax.grid(True, alpha=0.3)
    ax.legend()
    plt.tight_layout()
    plt.savefig(out_dir / "convergence_plot.png", dpi=120)
    plt.close()


async def main_async(args) -> int:
    profile = NoiseProfile(rng_seed=args.seed)
    print(
        f"[dual-sim] noise profile: servo_delay={profile.servo_delay_ms_mean}±{profile.servo_delay_ms_std} ms, "
        f"motor_strength_std={profile.motor_strength_std}, "
        f"joint_offset_std={profile.joint_offset_rad_std} rad, "
        f"IMU_noise={profile.imu_noise_rad_std} rad, "
        f"latency={profile.network_latency_ms_mean}±{profile.network_latency_ms_std} ms, "
        f"marker_drop={profile.marker_dropout_p}"
    )
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    summary = await calibrate(
        noise_profile=profile,
        iterations=args.iterations,
        learning_rate=args.lr,
        out_dir=out,
    )
    _plot_convergence(out, summary)
    print()
    print("=" * 60)
    print(f"Baseline RMS divergence: {summary['baseline_rms_total']:.4f} rad")
    print(f"Final RMS divergence:    {summary['final_rms_total']:.4f} rad")
    print(f"Reduction:               {summary['reduction_pct']:.1f}%")
    print(f"Per-joint offset recovery error: "
          f"{summary['offset_recovery_err_rad']*1000:.2f} mrad")
    print(f"Per-joint strength recovery error: "
          f"{summary['strength_recovery_err']*100:.2f}%")
    print()
    print("ground-truth vs recovered (first 6 joints):")
    for i, (gt, rec) in enumerate(zip(
        summary["ground_truth_offsets_rad_sample"],
        summary["recovered_offsets_rad_sample"],
    )):
        print(f"  joint {i}: offset truth={gt*1000:+.2f} mrad  recovered={rec*1000:+.2f} mrad")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iterations", type=int, default=12)
    parser.add_argument("--lr", type=float, default=0.4)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "examples"
        / "robot-mujoco-demo"
        / "evidence"
        / "dual_sim_calibration",
    )
    args = parser.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
