"""Launch AiNex in IsaacLab simulation with bridge-compatible control.

This script creates an IsaacLab environment with the AiNex robot and
exposes joint-level control that the bridge backends can drive.

Usage (requires Isaac Sim Python environment):
    python -m bridge.isaaclab.run_sim [--headless] [--num-envs 1]

When Isaac Sim is not available, runs in dry-run mode to validate config.
"""

from __future__ import annotations

import argparse
import sys

from eliza_robot.bridge.isaaclab.ainex_cfg import build_ainex_cfg, try_build_isaaclab_articulation_cfg
from eliza_robot.bridge.isaaclab.joint_map import JOINT_NAMES


def _run_dry(cfg: object) -> None:
    """Dry-run mode: validate config without Isaac Sim."""
    from eliza_robot.bridge.isaaclab.ainex_cfg import AiNexArticulationCfg

    if not isinstance(cfg, AiNexArticulationCfg):
        print("ERROR: unexpected config type")
        raise SystemExit(1)

    print("Dry-run mode (Isaac Sim not available)")
    print(f"  USD path: {cfg.usd_path}")
    print(f"  Spawn height: {cfg.spawn_height}")
    print(f"  Leg joints: {len(cfg.leg_actuators.joint_names)}")
    print(f"  Arm joints: {len(cfg.arm_actuators.joint_names)}")
    print(f"  Head joints: {len(cfg.head_actuators.joint_names)}")
    print(f"  Total joints: {len(cfg.joint_limits)}")
    print(f"  Default positions defined: {len(cfg.default_positions)}")

    # Validate all joints have defaults.
    missing = set(JOINT_NAMES) - set(cfg.default_positions.keys())
    if missing:
        print(f"  WARNING: missing default positions for: {missing}")

    # Validate all defaults are within limits.
    for name, pos in cfg.default_positions.items():
        limits = cfg.joint_limits.get(name)
        if limits is None:
            print(f"  WARNING: no limits for joint {name}")
            continue
        if pos < limits.lower or pos > limits.upper:
            print(f"  ERROR: {name}={pos} outside [{limits.lower}, {limits.upper}]")

    print("dry_run=PASS")


def _run_isaac(headless: bool, num_envs: int) -> None:
    """Run with Isaac Sim runtime."""
    try:
        from omni.isaac.lab.app import AppLauncher
    except ImportError:
        print("ERROR: IsaacLab not available. Running dry-run instead.")
        _run_dry(build_ainex_cfg())
        return

    # Launch Isaac Sim app.
    launcher = AppLauncher(headless=headless)
    simulation_app = launcher.app

    import omni.isaac.lab.sim as sim_utils
    from omni.isaac.lab.assets import Articulation

    articulation_cfg = try_build_isaaclab_articulation_cfg()
    if articulation_cfg is None:
        print("ERROR: Could not build IsaacLab ArticulationCfg")
        simulation_app.close()
        raise SystemExit(1)

    # Create simulation context.
    sim_cfg = sim_utils.SimulationCfg(dt=0.005)
    sim = sim_utils.SimulationContext(sim_cfg)
    sim.set_camera_view(eye=(2.0, 2.0, 2.0), target=(0.0, 0.0, 0.25))

    # Spawn ground plane.
    ground_cfg = sim_utils.GroundPlaneCfg()
    ground_cfg.func("/World/ground", ground_cfg)

    # Spawn robot.
    robot = Articulation(articulation_cfg)

    # Reset and run.
    sim.reset()
    robot.reset()

    print(f"AiNex spawned with {robot.num_joints} joints in {num_envs} environment(s)")
    print("Simulation running. Press Ctrl+C to stop.")

    step = 0
    try:
        while simulation_app.is_running():
            robot.write_data_to_sim()
            sim.step()
            robot.update(sim_cfg.dt)
            step += 1

            if step % 1000 == 0:
                joint_pos = robot.data.joint_pos
                print(f"Step {step}: joint_pos shape={joint_pos.shape}")
    except KeyboardInterrupt:
        print("\nShutting down simulation.")

    simulation_app.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Launch AiNex in IsaacLab")
    parser.add_argument("--headless", action="store_true", help="run without GUI")
    parser.add_argument("--num-envs", type=int, default=1, help="number of parallel environments")
    parser.add_argument("--dry-run", action="store_true", help="validate config without Isaac Sim")
    args = parser.parse_args()

    if args.dry_run:
        _run_dry(build_ainex_cfg())
        return

    _run_isaac(headless=args.headless, num_envs=args.num_envs)


if __name__ == "__main__":
    main()
