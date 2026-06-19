"""Drop test: verify no geometry penetrates the floor from any orientation.

Spawns the robot at various orientations above the ground, lets it fall,
and checks that every geom stays above z=0 (within tolerance) after
settling. Uses CPU MuJoCo for deterministic results.

Usage:
    python3 -m eliza_robot.sim.mujoco.drop_test
    python3 -m eliza_robot.sim.mujoco.drop_test --xml ainex_mjx.xml --viewer
    python3 -m eliza_robot.sim.mujoco.drop_test --num-random 50
"""

import argparse
import math
import sys
from pathlib import Path

import mujoco
import numpy as np

from eliza_robot.sim.mujoco import _resolve_mjcf, ainex_constants as consts
from eliza_robot.sim.mujoco.sim_loop import validate_robot_above_ground


# Named orientations to test (quaternion w,x,y,z)
NAMED_ORIENTATIONS = {
    "upright":       (1.0, 0.0, 0.0, 0.0),
    "face_down":     (0.0, 0.0, 1.0, 0.0),       # 180 deg pitch
    "face_up":       (0.0, 1.0, 0.0, 0.0),       # 180 deg roll
    "side_right":    (0.707, 0.707, 0.0, 0.0),   # 90 deg roll right
    "side_left":     (0.707, -0.707, 0.0, 0.0),  # 90 deg roll left
    "pitch_45_fwd":  (0.924, 0.0, 0.383, 0.0),   # 45 deg forward pitch
    "pitch_45_back": (0.924, 0.0, -0.383, 0.0),  # 45 deg backward pitch
    "roll_45_right": (0.924, 0.383, 0.0, 0.0),   # 45 deg right roll
    "roll_45_left":  (0.924, -0.383, 0.0, 0.0),  # 45 deg left roll
    "yaw_90":        (0.707, 0.0, 0.0, 0.707),   # 90 deg yaw
    "diagonal_fr":   (0.854, 0.354, 0.354, 0.146),  # diagonal forward-right
    "diagonal_bl":   (0.854, -0.354, -0.354, 0.146), # diagonal back-left
    "inverted":      (0.0, 0.0, 0.0, 1.0),       # upside down (180 yaw + 180 pitch)
}

# Drop height: high enough that the robot is fully above ground at any orientation
DROP_HEIGHT = 0.35
# Simulation settle time in seconds
SETTLE_TIME = 3.0
# Penetration tolerance (negative = below ground)
TOLERANCE = -0.005


def random_quaternion(rng: np.random.Generator) -> tuple[float, ...]:
    """Generate a uniformly random unit quaternion."""
    u = rng.uniform(0, 1, size=3)
    q = (
        math.sqrt(1 - u[0]) * math.sin(2 * math.pi * u[1]),
        math.sqrt(1 - u[0]) * math.cos(2 * math.pi * u[1]),
        math.sqrt(u[0]) * math.sin(2 * math.pi * u[2]),
        math.sqrt(u[0]) * math.cos(2 * math.pi * u[2]),
    )
    return q


def run_drop(
    model: mujoco.MjModel,
    orientation: tuple[float, ...],
    settle_time: float = SETTLE_TIME,
    tolerance: float = TOLERANCE,
    drop_height: float = DROP_HEIGHT,
) -> tuple[bool, list[str], float]:
    """Drop robot from given orientation and check for penetration.

    Args:
        model: MuJoCo model.
        orientation: Quaternion (w, x, y, z).
        settle_time: Time to simulate before checking.
        tolerance: Maximum penetration below z=0.
        drop_height: Initial z position of root body.

    Returns:
        (passed, violations, min_z) where passed is True if no violations.
    """
    data = mujoco.MjData(model)

    # Reset to default
    mujoco.mj_resetData(model, data)

    # Set root position and orientation
    # qpos[0:3] = xyz, qpos[3:7] = quaternion
    data.qpos[0] = 0.0
    data.qpos[1] = 0.0
    data.qpos[2] = drop_height
    data.qpos[3] = orientation[0]  # w
    data.qpos[4] = orientation[1]  # x
    data.qpos[5] = orientation[2]  # y
    data.qpos[6] = orientation[3]  # z

    # Zero velocity
    data.qvel[:] = 0.0

    mujoco.mj_forward(model, data)

    # Simulate until settled
    n_steps = int(settle_time / model.opt.timestep)
    min_z_seen = float("inf")

    for step in range(n_steps):
        mujoco.mj_step(model, data)

        # Check every 100 steps for ongoing penetration
        if step % 100 == 0:
            ok, violations = validate_robot_above_ground(
                model, data, tolerance=tolerance, min_torso_z=-1.0  # don't check torso height
            )
            if not ok:
                # Track the worst case but keep simulating
                for v in violations:
                    z_str = v.split("bottom_z=")[1].split(" ")[0] if "bottom_z=" in v else "0"
                    try:
                        z_val = float(z_str)
                        min_z_seen = min(min_z_seen, z_val)
                    except ValueError:
                        pass

    # Final check after settling
    mujoco.mj_forward(model, data)
    ok, violations = validate_robot_above_ground(
        model, data, tolerance=tolerance, min_torso_z=-1.0
    )

    # Get actual minimum z of all geoms
    for i in range(model.ngeom):
        name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM, i) or ""
        if name == "floor" or name.startswith("entity_"):
            continue
        z = data.geom_xpos[i][2]
        min_z_seen = min(min_z_seen, z)

    return ok, violations, min_z_seen


def run_all_drops(
    xml_path: Path,
    num_random: int = 20,
    seed: int = 42,
    settle_time: float = SETTLE_TIME,
    tolerance: float = TOLERANCE,
    verbose: bool = True,
) -> tuple[int, int, list[tuple[str, list[str]]]]:
    """Run all drop tests (named + random orientations).

    Returns:
        (passed, total, failures) where failures is list of (name, violations).
    """
    model = mujoco.MjModel.from_xml_path(str(xml_path))
    rng = np.random.default_rng(seed)

    # Build test cases: named + random
    test_cases: list[tuple[str, tuple[float, ...]]] = []
    for name, quat in NAMED_ORIENTATIONS.items():
        test_cases.append((name, quat))
    for i in range(num_random):
        q = random_quaternion(rng)
        test_cases.append((f"random_{i:03d}", q))

    total = len(test_cases)
    passed = 0
    failures = []

    if verbose:
        print(f"Running {total} drop tests on {xml_path.name}")
        print(f"  Settle time: {settle_time}s, Tolerance: {tolerance}m")
        print()

    for name, quat in test_cases:
        ok, violations, min_z = run_drop(
            model, quat, settle_time=settle_time, tolerance=tolerance
        )
        if ok:
            passed += 1
            if verbose:
                print(f"  PASS  {name:<20s}  min_z={min_z:+.4f}")
        else:
            failures.append((name, violations))
            if verbose:
                print(f"  FAIL  {name:<20s}  min_z={min_z:+.4f}")
                for v in violations:
                    print(f"        {v}")

    if verbose:
        print()
        print(f"Results: {passed}/{total} passed")
        if failures:
            print(f"FAILURES ({len(failures)}):")
            for name, violations in failures:
                print(f"  {name}: {violations[0]}")

    return passed, total, failures


def run_viewer_drop(xml_path: Path, orientation_name: str = "face_down"):
    """Run a single drop with the interactive viewer."""
    try:
        import mujoco.viewer
    except ImportError:
        print("mujoco.viewer not available.")
        return

    quat = NAMED_ORIENTATIONS.get(orientation_name)
    if quat is None:
        print(f"Unknown orientation: {orientation_name}")
        print(f"Available: {', '.join(NAMED_ORIENTATIONS.keys())}")
        return

    model = mujoco.MjModel.from_xml_path(str(xml_path))
    data = mujoco.MjData(model)

    mujoco.mj_resetData(model, data)
    data.qpos[0:3] = [0.0, 0.0, DROP_HEIGHT]
    data.qpos[3:7] = quat
    data.qvel[:] = 0.0
    mujoco.mj_forward(model, data)

    print(f"Dropping from {orientation_name}: quat={quat}")
    print("Close viewer window to exit.")

    import time
    with mujoco.viewer.launch_passive(model, data) as viewer:
        step = 0
        while viewer.is_running():
            t0 = time.monotonic()
            mujoco.mj_step(model, data)
            viewer.sync()
            step += 1

            if step % 500 == 0:
                ok, violations = validate_robot_above_ground(
                    model, data, tolerance=TOLERANCE, min_torso_z=-1.0
                )
                status = "OK" if ok else f"PENETRATION: {violations[0]}"
                print(f"  Step {step}: {status}")

            elapsed = time.monotonic() - t0
            sleep_time = model.opt.timestep - elapsed
            if sleep_time > 0:
                time.sleep(sleep_time)


def main():
    parser = argparse.ArgumentParser(description="Drop test for AiNex MuJoCo model")
    parser.add_argument("--xml", type=str, default=None,
                        help="XML model path (default: ainex_primitives.xml)")
    parser.add_argument("--num-random", type=int, default=20,
                        help="Number of random orientations to test")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--settle-time", type=float, default=SETTLE_TIME,
                        help="Seconds to simulate before checking")
    parser.add_argument("--tolerance", type=float, default=TOLERANCE,
                        help="Max penetration below z=0 (negative)")
    parser.add_argument("--viewer", action="store_true",
                        help="Launch viewer for a single drop")
    parser.add_argument("--orientation", type=str, default="face_down",
                        help="Orientation for viewer mode")
    parser.add_argument("--all-xmls", action="store_true",
                        help="Test all three XML variants")
    args = parser.parse_args()

    if args.xml:
        xml_path = Path(args.xml)
        if not xml_path.is_absolute() and not xml_path.exists():
            xml_path = _resolve_mjcf(xml_path.name)
    else:
        xml_path = consts.SCENE_PRIMITIVES_XML

    if args.viewer:
        run_viewer_drop(xml_path, args.orientation)
        return

    if args.all_xmls:
        all_passed = True
        for name, path in [
            ("primitives", consts.SCENE_PRIMITIVES_XML),
            ("mjx", consts.SCENE_MJX_XML),
            ("full_mesh", consts.SCENE_XML),
        ]:
            print(f"\n{'='*60}")
            print(f"Testing: {name} ({path.name})")
            print(f"{'='*60}")
            passed, total, failures = run_all_drops(
                path,
                num_random=args.num_random,
                seed=args.seed,
                settle_time=args.settle_time,
                tolerance=args.tolerance,
            )
            if failures:
                all_passed = False
        sys.exit(0 if all_passed else 1)
    else:
        passed, total, failures = run_all_drops(
            xml_path,
            num_random=args.num_random,
            seed=args.seed,
            settle_time=args.settle_time,
            tolerance=args.tolerance,
        )
        sys.exit(0 if not failures else 1)


if __name__ == "__main__":
    main()
