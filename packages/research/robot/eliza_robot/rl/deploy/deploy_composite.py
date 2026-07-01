"""Deploy composite walking + upper body policy to the real AiNex robot.

Extends the ``deploy_walking.py`` pattern to control all DoF using
``CompositeSkill`` (``BraxWalkSkill`` + ``UpperBodySkill``). Supports
``wave`` and any future upper-body tasks trained via the train_upper
pipeline.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import signal
import time

import numpy as np

from eliza_robot.bridge.isaaclab.joint_map import (
    joint_name_to_servo_id,
    radians_to_pulse,
)
from eliza_robot.rl import checkpoint_path
from eliza_robot.rl.skills.brax_walk_skill import DEFAULT_WALK_CHECKPOINT_NAME, BraxWalkSkill
from eliza_robot.rl.skills.composite_skill import (
    DEFAULT_WAVE_CHECKPOINT_NAME,
    NUM_TOTAL_JOINTS,
    CompositeSkill,
)
from eliza_robot.rl.skills.rl_wave_skill import (
    TASK_OBS_DIM,
    WAVE_AMPLITUDE,
    WAVE_ELBOW_PITCH,
    WAVE_ELBOW_YAW,
    WAVE_FREQUENCY,
    WAVE_SHOULDER_PITCH,
)
from eliza_robot.sim.mujoco.ainex_constants import ALL_JOINT_NAMES, LEG_JOINT_NAMES


# Safety limits
MAX_JOINT_DELTA = 0.1
FALL_PITCH_THRESHOLD = 0.5
FALL_ROLL_THRESHOLD = 0.5
BATTERY_LOW_MV = 6600


class DeployComposite:
    """Deploy composite walking + upper-body policy to the real robot."""

    def __init__(
        self,
        walking_checkpoint: str | None = None,
        upper_checkpoint: str | None = None,
        task: str = "wave",
        hz: float = 50.0,
        duration: float = 30.0,
        ramp_seconds: float = 3.0,
        dry_run: bool = False,
        vx: float = 0.3,
        vy: float = 0.0,
        vyaw: float = 0.0,
        max_joint_delta: float = MAX_JOINT_DELTA,
        profile_id: str = "hiwonder-ainex",
    ) -> None:
        self.task = task
        self.hz = hz
        self.dt = 1.0 / hz
        self.duration = duration
        self.ramp_seconds = ramp_seconds
        self.dry_run = dry_run
        self.max_joint_delta = max_joint_delta
        self.profile_id = profile_id

        task_obs_dim = TASK_OBS_DIM if task == "wave" else 0
        walk_ckpt = walking_checkpoint or str(checkpoint_path(DEFAULT_WALK_CHECKPOINT_NAME))
        upper_ckpt = upper_checkpoint or str(checkpoint_path(DEFAULT_WAVE_CHECKPOINT_NAME))
        print(f"Loading composite policy: walk={walk_ckpt} upper={upper_ckpt}")
        self.skill = CompositeSkill(
            walking_checkpoint=walk_ckpt,
            upper_checkpoint=upper_ckpt,
            task_obs_dim=task_obs_dim,
            profile_id=profile_id,
        )
        self.skill.set_command(vx=vx, vy=vy, vyaw=vyaw)
        print(f"Policy loaded. Task: {task}, Command: vx={vx}, vy={vy}, vyaw={vyaw}")

        self._last_targets = np.zeros(NUM_TOTAL_JOINTS, dtype=np.float32)
        self._imu_roll = 0.0
        self._imu_pitch = 0.0
        self._gyro = np.zeros(3, dtype=np.float32)
        self._joint_feedback: np.ndarray | None = None
        self._battery_mv = 0
        self._step = 0
        self._stopped = False
        self._start_time = 0.0
        self._last_telemetry_time = 0.0
        self._fell = False

    def joint_targets_to_servo_commands(
        self, targets: np.ndarray,
    ) -> list[dict[str, int]]:
        if not np.all(np.isfinite(targets)):
            print("  WARNING: NaN/Inf in joint targets, holding last position")
            targets = self._last_targets.copy()
        commands = []
        for i, name in enumerate(ALL_JOINT_NAMES):
            rad = float(targets[i])
            servo_id = joint_name_to_servo_id(name)
            pulse = radians_to_pulse(rad, servo_id)
            commands.append({"id": servo_id, "position": pulse})
        return commands

    def compute_task_obs(self, elapsed: float) -> np.ndarray | None:
        if self.task != "wave":
            return None
        phase = elapsed * 2.0 * math.pi * WAVE_FREQUENCY
        return np.array([
            math.sin(phase),
            math.cos(phase),
            WAVE_SHOULDER_PITCH,
            WAVE_AMPLITUDE * math.sin(phase),
            WAVE_ELBOW_PITCH,
            WAVE_ELBOW_YAW,
        ], dtype=np.float32)

    def safety_clamp(
        self, targets: np.ndarray, ramp_factor: float,
    ) -> np.ndarray:
        default = (
            self.skill.default_pose
            if hasattr(self.skill, "default_pose")
            else np.zeros(NUM_TOTAL_JOINTS, dtype=np.float32)
        )
        blended = default + (targets - default) * ramp_factor
        delta = blended - self._last_targets
        clamped_delta = np.clip(delta, -self.max_joint_delta, self.max_joint_delta)
        result = self._last_targets + clamped_delta
        self._last_targets = result.copy()
        return result

    def check_fall(self) -> bool:
        if abs(self._imu_pitch) > FALL_PITCH_THRESHOLD:
            print(f"FALL DETECTED: pitch={self._imu_pitch:.3f} rad")
            return True
        if abs(self._imu_roll) > FALL_ROLL_THRESHOLD:
            print(f"FALL DETECTED: roll={self._imu_roll:.3f} rad")
            return True
        return False

    def policy_step(self, elapsed: float, ramp_factor: float) -> list[dict[str, int]]:
        self._step += 1
        task_obs = self.compute_task_obs(elapsed)

        targets = self.skill.get_full_action(
            gyro=self._gyro,
            imu_roll=self._imu_roll,
            imu_pitch=self._imu_pitch,
            joint_positions=self._joint_feedback,
            task_obs=task_obs,
        )

        safe_targets = self.safety_clamp(targets, ramp_factor)
        return self.joint_targets_to_servo_commands(safe_targets)

    async def run_with_bridge(
        self,
        bridge_url: str,
        auto_recover: bool = False,
    ) -> None:
        import websockets

        max_retries = 3
        retry_delay = 2.0
        attempt = 0
        ws = None

        while attempt <= max_retries and not self._stopped:
            try:
                if attempt > 0:
                    print(
                        f"Reconnection attempt {attempt}/{max_retries} "
                        f"(waiting {retry_delay}s)..."
                    )
                    await asyncio.sleep(retry_delay)

                print(f"Connecting to bridge at {bridge_url}...")
                ws = await websockets.connect(bridge_url)
                print("Connected to bridge.")

                bridge_hz = min(self.hz, 30.0)
                await self._send_command(ws, "policy.start", {
                    "task": f"deploy_composite_{self.task}",
                    "hz": bridge_hz,
                })
                resp = await self._recv_response(ws)
                if not resp.get("ok"):
                    print(f"Failed to start policy: {resp.get('message')}")
                    if ws:
                        await ws.close()
                    return

                print(
                    f"Policy mode started. {self.hz}Hz for {self.duration}s "
                    f"(ramp: {self.ramp_seconds}s)"
                )
                if self.dry_run:
                    print("DRY RUN — commands logged but not sent")
                print()

                self._last_telemetry_time = time.monotonic()
                self._fell = False

                try:
                    await self._control_loop(ws)
                except KeyboardInterrupt:
                    print("\nInterrupted by user.")
                finally:
                    print("Stopping policy mode...")
                    try:
                        await self._send_standing_pose(ws)
                        await asyncio.sleep(0.5)
                        await self._send_command(ws, "policy.stop", {})
                        await self._recv_response(ws)
                    except Exception:  # noqa: BLE001 — best-effort shutdown
                        pass
                    print("Policy stopped.")

                    if self._fell:
                        await self._attempt_fall_recovery(ws, auto_recover)

                    try:
                        await ws.close()
                    except Exception:  # noqa: BLE001 — best-effort close
                        pass

                return

            except (ConnectionError, OSError) as exc:
                attempt += 1
                print(f"WARNING: Connection error: {exc}")
                if ws:
                    try:
                        await ws.close()
                    except Exception:  # noqa: BLE001 — best-effort close
                        pass
                    ws = None
                if attempt > max_retries:
                    print("EMERGENCY STOP: All reconnection attempts failed!")
                    self._stopped = True
                    return

            except Exception as exc:  # noqa: BLE001 — websockets-specific exceptions
                exc_name = type(exc).__name__
                if "ConnectionClosed" in exc_name or "ConnectionError" in exc_name:
                    attempt += 1
                    print(f"WARNING: WebSocket closed: {exc}")
                    if ws:
                        try:
                            await ws.close()
                        except Exception:  # noqa: BLE001
                            pass
                        ws = None
                    if attempt > max_retries:
                        print("EMERGENCY STOP: All reconnection attempts failed!")
                        self._stopped = True
                        return
                else:
                    raise

    async def _control_loop(self, ws) -> None:
        self._start_time = time.monotonic()
        self._last_telemetry_time = time.monotonic()
        last_status_time = self._start_time
        heartbeat_timeout = 2.0

        while not self._stopped:
            t0 = time.monotonic()
            elapsed = t0 - self._start_time

            if elapsed >= self.duration:
                print(f"\nDuration limit reached ({self.duration}s).")
                break

            ramp = (
                min(1.0, elapsed / self.ramp_seconds)
                if self.ramp_seconds > 0
                else 1.0
            )

            if self.check_fall():
                print("Emergency stop: fall detected!")
                self._fell = True
                break

            if self.check_battery():
                print(f"Emergency stop: battery low ({self._battery_mv}mV)!")
                break

            if t0 - self._last_telemetry_time > heartbeat_timeout:
                print(f"WARNING: No telemetry for {heartbeat_timeout}s — connection lost!")
                raise ConnectionError("Telemetry heartbeat timeout")

            servo_cmds = self.policy_step(elapsed, ramp)

            if not self.dry_run:
                action_payload = {
                    "joint_positions": {
                        ALL_JOINT_NAMES[i]: float(self._last_targets[i])
                        for i in range(NUM_TOTAL_JOINTS)
                    },
                    "duration": int(self.dt * 1000),
                }
                await self._send_command(ws, "policy.tick", action_payload)
                await self._recv_response(ws)
                await self._process_events(ws)

            if t0 - last_status_time >= 2.0:
                self._print_status(elapsed, ramp)
                last_status_time = t0

            step_time = time.monotonic() - t0
            sleep_time = self.dt - step_time
            if sleep_time > 0:
                await asyncio.sleep(sleep_time)

    async def _send_standing_pose(self, ws) -> None:
        default = (
            self.skill.default_pose
            if hasattr(self.skill, "default_pose")
            else None
        )
        action_payload = {
            "joint_positions": {
                name: float(default[i]) if default is not None else 0.0
                for i, name in enumerate(ALL_JOINT_NAMES)
            },
            "duration": 500,
        }
        await self._send_command(ws, "policy.tick", action_payload)
        try:
            await self._recv_response(ws)
        except Exception:  # noqa: BLE001 — best-effort
            pass

    async def _send_command(self, ws, command: str, payload: dict) -> None:
        msg = {
            "type": "command",
            "request_id": f"composite-{self._step}",
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "command": command,
            "payload": payload,
        }
        await ws.send(json.dumps(msg))

    async def _recv_response(self, ws) -> dict:
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            try:
                remaining = max(0.01, deadline - time.monotonic())
                raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                data = json.loads(raw)
                if "event" in data:
                    if "data" in data:
                        self._update_telemetry(data["data"])
                    continue
                if "data" in data:
                    self._update_telemetry(data["data"])
                return data
            except asyncio.TimeoutError:
                break
        return {"ok": False, "message": "timeout"}

    async def _process_events(self, ws) -> None:
        try:
            while True:
                raw = await asyncio.wait_for(ws.recv(), timeout=0.001)
                data = json.loads(raw)
                if data.get("event") == "telemetry.basic":
                    self._update_telemetry(data.get("data", {}))
        except asyncio.TimeoutError:
            return
        except Exception as exc:  # noqa: BLE001
            print(f"  WARNING: event processing error: {exc}")

    def _update_telemetry(self, data: dict) -> None:
        self._last_telemetry_time = time.monotonic()

        if "imu_roll" in data:
            self._imu_roll = float(data["imu_roll"])
        if "imu_pitch" in data:
            self._imu_pitch = float(data["imu_pitch"])
        if "gyro" in data and isinstance(data["gyro"], list):
            self._gyro = np.array(data["gyro"][:3], dtype=np.float32)
        if "joint_positions" in data and isinstance(data["joint_positions"], dict):
            jp = data["joint_positions"]
            feedback = np.zeros(NUM_TOTAL_JOINTS, dtype=np.float32)
            for i, name in enumerate(ALL_JOINT_NAMES):
                if name in jp:
                    feedback[i] = float(jp[name])
            self._joint_feedback = feedback
        if "battery_mv" in data:
            self._battery_mv = int(data["battery_mv"])

    def check_battery(self) -> bool:
        return hasattr(self, "_battery_mv") and 0 < self._battery_mv < BATTERY_LOW_MV

    async def _attempt_fall_recovery(
        self,
        ws,
        auto_recover: bool = False,
    ) -> None:
        getup_checkpoint = checkpoint_path("mujoco_getup/final_params")

        print("\n--- Fall Recovery ---")

        if getup_checkpoint.exists():
            print(f"Getup checkpoint found at {getup_checkpoint}")
            try:
                getup_skill = BraxWalkSkill(
                    checkpoint_path=str(getup_checkpoint),
                    profile_id=self.profile_id,
                )
                getup_skill.set_command(vx=0.0, vy=0.0, vyaw=0.0)

                print("Running getup policy for up to 5 seconds...")
                await self._send_command(ws, "policy.start", {
                    "task": "getup_recovery",
                    "hz": min(self.hz, 30.0),
                })
                try:
                    resp = await self._recv_response(ws)
                    if not resp.get("ok"):
                        print(
                            f"  WARNING: Could not start getup policy: "
                            f"{resp.get('message')}"
                        )
                        raise RuntimeError("getup policy start failed")
                except RuntimeError:
                    print("  Falling back to init_pose recovery")
                    await self._fallback_init_pose(ws)
                    return

                getup_start = time.monotonic()
                getup_duration = 5.0
                while time.monotonic() - getup_start < getup_duration:
                    elapsed = time.monotonic() - getup_start

                    await self._process_events(ws)

                    joint_feedback = self._joint_feedback
                    targets, _ = getup_skill.get_action_from_telemetry(
                        imu_roll=self._imu_roll,
                        imu_pitch=self._imu_pitch,
                        joint_positions=joint_feedback,
                    )

                    action_payload = {
                        "joint_positions": {
                            LEG_JOINT_NAMES[i]: float(targets[i])
                            for i in range(len(LEG_JOINT_NAMES))
                        },
                        "duration": int(self.dt * 1000),
                    }
                    await self._send_command(ws, "policy.tick", action_payload)
                    await self._recv_response(ws)

                    if abs(self._imu_pitch) < 0.2 and abs(self._imu_roll) < 0.2:
                        print(
                            f"  Robot appears upright at t={elapsed:.1f}s "
                            f"(pitch={self._imu_pitch:.3f}, roll={self._imu_roll:.3f})"
                        )
                        break

                    await asyncio.sleep(self.dt)

                await self._send_command(ws, "policy.stop", {})
                try:
                    await self._recv_response(ws)
                except Exception:  # noqa: BLE001
                    pass

                print("  Getup policy complete.")

            except ImportError:
                print("  WARNING: BraxWalkSkill not available for getup")
                await self._fallback_init_pose(ws)
            except Exception as exc:  # noqa: BLE001
                print(f"  WARNING: Getup policy failed: {exc}")
                await self._fallback_init_pose(ws)
        else:
            print("No getup checkpoint found, using init_pose fallback")
            await self._fallback_init_pose(ws)

        print("  Waiting 2 seconds for stabilization...")
        await asyncio.sleep(2.0)

        if auto_recover:
            print("  Auto-recover enabled -- would resume task here")
        else:
            print("  Recovery complete. Manual restart required.")

    async def _fallback_init_pose(self, ws) -> None:
        print("  Sending walking/init_pose for basic recovery...")
        try:
            await self._send_command(ws, "walking.init_pose", {})
            await self._recv_response(ws)
        except Exception as exc:  # noqa: BLE001
            print(f"  WARNING: init_pose command failed: {exc}")

    def _print_status(self, elapsed: float, ramp: float) -> None:
        dry = " [DRY]" if self.dry_run else ""
        fb = "YES" if self._joint_feedback is not None else "NO"
        print(
            f"  [{self.task.upper()}{dry}] t={elapsed:.1f}s ramp={ramp:.2f} "
            f"step={self._step} imu=({self._imu_roll:.3f},{self._imu_pitch:.3f}) "
            f"fb={fb} head_pan={self._last_targets[12]:.3f}"
        )

    def run_dry(self) -> None:
        print(f"DRY RUN: {self.task} for {self.duration}s at {self.hz}Hz")
        print(f"Ramp: {self.ramp_seconds}s")
        print()

        start = time.monotonic()
        while time.monotonic() - start < self.duration:
            elapsed = time.monotonic() - start
            ramp = (
                min(1.0, elapsed / self.ramp_seconds)
                if self.ramp_seconds > 0
                else 1.0
            )

            servo_cmds = self.policy_step(elapsed, ramp)

            if self._step % int(self.hz * 2) == 1:
                self._print_status(elapsed, ramp)
                if self._step % int(self.hz * 10) == 1:
                    print("    Joint targets (radians):")
                    for i, name in enumerate(ALL_JOINT_NAMES):
                        print(
                            f"      {name:15s}: {self._last_targets[i]:+.4f} rad "
                            f"→ pulse {servo_cmds[i]['position']}"
                        )

            time.sleep(self.dt)

        print(f"\nDry run complete. {self._step} steps.")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Deploy composite walking + upper body policy to AiNex robot"
    )
    parser.add_argument(
        "--walking-checkpoint", type=str, default=None,
        help="Walking policy checkpoint (defaults to ELIZA_ROBOT_CHECKPOINT_DIR/mujoco_locomotion_v13_flat_feet)",
    )
    parser.add_argument(
        "--upper-checkpoint", type=str, default=None,
        help="Upper body policy checkpoint (defaults to ELIZA_ROBOT_CHECKPOINT_DIR/mujoco_wave/final_params)",
    )
    # Aliased to match the standard --checkpoint flag (treated as walking-checkpoint).
    parser.add_argument("--checkpoint", type=str, default=None, help=argparse.SUPPRESS)
    parser.add_argument(
        "--task", type=str, default="wave", choices=["wave"],
        help="Upper body task (default: wave)",
    )
    parser.add_argument(
        "--bridge", type=str, default="ws://localhost:9100",
        help="Bridge WebSocket URL",
    )
    parser.add_argument("--hz", type=float, default=50.0)
    parser.add_argument("--duration", type=float, default=30.0)
    parser.add_argument("--ramp-seconds", type=float, default=3.0)
    parser.add_argument("--vx", type=float, default=0.3)
    parser.add_argument("--vy", type=float, default=0.0)
    parser.add_argument("--vyaw", type=float, default=0.0)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--max-delta", type=float, default=MAX_JOINT_DELTA)
    parser.add_argument(
        "--auto-recover", action="store_true",
        help="Automatically attempt to resume after fall recovery",
    )
    parser.add_argument(
        "--profile", default="hiwonder-ainex",
        help="Robot profile id",
    )

    args = parser.parse_args()

    if args.hz > 50:
        print("WARNING: Hz > 50 exceeds training frequency. Clamping to 50.")
        args.hz = 50.0

    walking_ckpt = args.walking_checkpoint or args.checkpoint

    deployer = DeployComposite(
        walking_checkpoint=walking_ckpt,
        upper_checkpoint=args.upper_checkpoint,
        task=args.task,
        hz=args.hz,
        duration=args.duration,
        ramp_seconds=args.ramp_seconds,
        dry_run=args.dry_run,
        vx=args.vx,
        vy=args.vy,
        vyaw=args.vyaw,
        max_joint_delta=args.max_delta,
        profile_id=args.profile,
    )

    def signal_handler(sig, frame):
        print("\nCtrl+C received, stopping...")
        deployer._stopped = True
    signal.signal(signal.SIGINT, signal_handler)

    if args.dry_run:
        deployer.run_dry()
    else:
        print(f"\n{'='*60}")
        print("DEPLOYING COMPOSITE POLICY TO REAL ROBOT")
        print(f"{'='*60}")
        print(f"  Walking:    {walking_ckpt or '(default checkpoint dir)'}")
        print(f"  Upper body: {args.upper_checkpoint or '(default checkpoint dir)'}")
        print(f"  Task:       {args.task}")
        print(f"  Bridge:     {args.bridge}")
        print(f"  Frequency:  {args.hz} Hz")
        print(f"  Duration:   {args.duration}s")
        print(f"  Profile:    {args.profile}")
        print(f"  Command:    vx={args.vx} vy={args.vy} vyaw={args.vyaw}")
        print(f"{'='*60}")
        print()
        asyncio.run(deployer.run_with_bridge(args.bridge, auto_recover=args.auto_recover))


if __name__ == "__main__":
    main()
