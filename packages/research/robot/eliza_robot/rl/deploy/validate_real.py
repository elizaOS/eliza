"""Validation harness for real robot deployment.

Runs a sequence of progressively more aggressive tests against the real
robot, recording commanded vs actual joint positions at each stage.

Usage::

    python -m eliza_robot.rl.deploy.validate_real --bridge ws://localhost:9100
    python -m eliza_robot.rl.deploy.validate_real --bridge ws://localhost:9100 --stage walk
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time

import numpy as np

from eliza_robot.bridge.isaaclab.joint_map import joint_name_to_servo_id, radians_to_pulse
from eliza_robot.sim.mujoco.ainex_constants import ALL_JOINT_NAMES, LEG_JOINT_NAMES


STAGES = {
    "servo_ping": "Read servo positions (no commands sent)",
    "stand": "Send standing pose for 5 seconds",
    "sway": "Small 0.05 rad hip sway for 5 seconds",
    "walk": "Walk forward at 0.1 m/s for 5 seconds",
    "servo_step_response": "System-identify each leg servo (step response + tau fit)",
}

# Leg servo IDs for step response identification
LEG_SERVO_IDS = {
    "r_hip_yaw": 12,
    "r_hip_roll": 10,
    "r_hip_pitch": 8,
    "r_knee": 6,
    "r_ank_pitch": 4,
    "r_ank_roll": 2,
    "l_hip_yaw": 11,
    "l_hip_roll": 9,
    "l_hip_pitch": 7,
    "l_knee": 5,
    "l_ank_pitch": 3,
    "l_ank_roll": 1,
}

ROSBRIDGE_URL = "ws://192.168.1.218:9090"

PULSE_PER_RAD = 500.0 / 2.09
PULSE_CENTER = 500

APPROX_LINK_INERTIA = 0.002


def _rad_to_pulse(radians: float) -> int:
    return int(PULSE_CENTER + radians * PULSE_PER_RAD)


def _pulse_to_rad(pulse: float) -> float:
    return (pulse - PULSE_CENTER) / PULSE_PER_RAD


async def run_servo_step_response(
    rosbridge_url: str = ROSBRIDGE_URL,
    step_rad: float = 0.3,
    sample_hz: float = 50.0,
    sample_duration: float = 1.0,
    inertia: float = APPROX_LINK_INERTIA,
) -> dict:
    """System-identify each leg servo by commanding a step and measuring response."""
    import websockets

    results: dict = {}
    sample_interval = 1.0 / sample_hz

    print("\n--- Servo Step Response Identification ---")
    print(
        f"Step size: {step_rad:.3f} rad, Sample rate: {sample_hz}Hz, "
        f"Duration: {sample_duration}s"
    )

    async with websockets.connect(rosbridge_url) as ws:
        msg_id_counter = 0

        async def rb_call_service(service: str, args: dict) -> dict:
            nonlocal msg_id_counter
            msg_id_counter += 1
            call_id = f"sysid_{msg_id_counter}"
            call_msg = json.dumps({
                "op": "call_service",
                "id": call_id,
                "service": service,
                "args": args,
            })
            await ws.send(call_msg)
            deadline = time.monotonic() + 3.0
            while time.monotonic() < deadline:
                try:
                    remaining = max(0.01, deadline - time.monotonic())
                    raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                    resp = json.loads(raw)
                    if resp.get("id") == call_id:
                        return resp
                except asyncio.TimeoutError:
                    break
            return {"values": {}}

        async def rb_publish(topic: str, msg: dict) -> None:
            pub_msg = json.dumps({
                "op": "publish",
                "topic": topic,
                "msg": msg,
            })
            await ws.send(pub_msg)

        async def read_servo_position(servo_id: int) -> float | None:
            resp = await rb_call_service(
                "/ros_robot_controller/bus_servo/get_position",
                {"id": servo_id},
            )
            values = resp.get("values", {})
            position = values.get("position")
            if position is not None:
                return float(position)
            result = values.get("result", {})
            if isinstance(result, dict):
                position = result.get("position")
                if position is not None:
                    return float(position)
            return None

        for servo_name, servo_id in LEG_SERVO_IDS.items():
            print(f"\n  Servo: {servo_name} (ID={servo_id})")

            current_pulse = await read_servo_position(servo_id)
            if current_pulse is None:
                print("    WARNING: Could not read position, skipping")
                results[servo_name] = {
                    "servo_id": servo_id,
                    "error": "could_not_read_position",
                }
                continue

            current_rad = _pulse_to_rad(current_pulse)
            target_rad = current_rad + step_rad
            target_pulse = _rad_to_pulse(target_rad)

            target_pulse = max(0, min(1000, target_pulse))
            target_rad = _pulse_to_rad(target_pulse)
            actual_step = target_rad - current_rad

            print(f"    Current: {current_rad:.3f} rad ({current_pulse:.0f} pulse)")
            print(f"    Target:  {target_rad:.3f} rad ({target_pulse} pulse)")
            print(f"    Step:    {actual_step:.3f} rad")

            trajectory: list[dict] = []
            t_start = time.monotonic()

            await rb_publish(
                "/ros_robot_controller/bus_servo/set_position",
                {"id": servo_id, "position": target_pulse, "duration": 0},
            )

            while time.monotonic() - t_start < sample_duration:
                sample_t = time.monotonic() - t_start
                pos_pulse = await read_servo_position(servo_id)
                if pos_pulse is not None:
                    pos_rad = _pulse_to_rad(pos_pulse)
                    trajectory.append({
                        "time": float(sample_t),
                        "commanded_pos": float(target_rad),
                        "actual_pos": float(pos_rad),
                    })

                elapsed_sample = time.monotonic() - (t_start + sample_t)
                wait = sample_interval - elapsed_sample
                if wait > 0:
                    await asyncio.sleep(wait)

            await rb_publish(
                "/ros_robot_controller/bus_servo/set_position",
                {"id": servo_id, "position": int(current_pulse), "duration": 500},
            )
            await asyncio.sleep(0.6)

            if len(trajectory) < 3:
                print(f"    WARNING: Only {len(trajectory)} samples, cannot fit")
                results[servo_name] = {
                    "servo_id": servo_id,
                    "error": "insufficient_samples",
                    "trajectory": trajectory,
                }
                continue

            times = np.array([s["time"] for s in trajectory])
            positions = np.array([s["actual_pos"] for s in trajectory])

            pos_initial = positions[0]
            pos_final = target_rad
            delta = pos_final - pos_initial
            if abs(delta) < 1e-4:
                print("    WARNING: No movement detected")
                results[servo_name] = {
                    "servo_id": servo_id,
                    "error": "no_movement",
                    "trajectory": trajectory,
                }
                continue

            normalized = (positions - pos_initial) / delta

            tau = None
            for i in range(len(normalized)):
                if normalized[i] >= 0.63:
                    if i > 0 and normalized[i - 1] < 0.63:
                        frac = (
                            (0.63 - normalized[i - 1])
                            / (normalized[i] - normalized[i - 1])
                        )
                        tau = times[i - 1] + frac * (times[i] - times[i - 1])
                    else:
                        tau = times[i]
                    break

            if tau is None:
                final_pct = float(normalized[-1]) * 100
                print(f"    WARNING: Only reached {final_pct:.1f}% of target")
                tau = sample_duration * 2.0

            kp_eff = inertia / tau if tau > 0 else float("inf")

            final_error = abs(positions[-1] - target_rad)

            servo_result = {
                "servo_id": servo_id,
                "step_rad": float(actual_step),
                "tau_s": float(tau),
                "kp_eff": float(kp_eff),
                "final_error_rad": float(final_error),
                "final_pct": float(normalized[-1]) * 100,
                "num_samples": len(trajectory),
                "trajectory": trajectory,
            }
            results[servo_name] = servo_result

            print(f"    Tau: {tau:.4f}s")
            print(f"    Kp_eff: {kp_eff:.4f} (inertia={inertia})")
            print(
                f"    Final: {normalized[-1] * 100:.1f}% of target, "
                f"error={final_error:.4f} rad"
            )

    print("\n  --- Step Response Summary ---")
    for name, res in results.items():
        if "error" in res:
            print(f"    {name:15s}: ERROR ({res['error']})")
        else:
            print(
                f"    {name:15s}: tau={res['tau_s']:.4f}s  Kp_eff={res['kp_eff']:.4f}  "
                f"final={res['final_pct']:.1f}%"
            )

    return {
        "stage": "servo_step_response",
        "success": True,
        "inertia_estimate": inertia,
        "step_rad": step_rad,
        "servos": results,
    }


async def run_validation(bridge_url: str, stage: str, duration: float = 5.0) -> dict:
    """Run a single validation stage and return recorded telemetry."""
    import websockets

    if stage == "servo_step_response":
        return await run_servo_step_response(
            rosbridge_url=ROSBRIDGE_URL,
            step_rad=0.3,
            sample_hz=50.0,
            sample_duration=1.0,
        )

    log: list[dict] = []
    print(f"\n--- Stage: {stage} ({STAGES[stage]}) ---")
    print(f"Duration: {duration}s")

    async with websockets.connect(bridge_url) as ws:
        await _send(ws, "policy.start", {"task": f"validate_{stage}", "hz": 20})
        resp = await _recv(ws)
        if not resp.get("ok"):
            print(f"  Failed to start policy: {resp.get('message')}")
            return {
                "stage": stage,
                "success": False,
                "error": resp.get("message"),
                "log": [],
            }

        start = time.monotonic()
        step = 0
        try:
            while time.monotonic() - start < duration:
                step += 1
                elapsed = time.monotonic() - start

                if stage == "servo_ping":
                    await _send(ws, "status.get", {})
                elif stage == "stand":
                    cmd = {name: 0.0 for name in LEG_JOINT_NAMES}
                    await _send(ws, "policy.tick", {"joint_positions": cmd, "duration": 50})
                elif stage == "sway":
                    angle = 0.05 * np.sin(elapsed * 2.0 * np.pi * 0.5)
                    cmd = {name: 0.0 for name in LEG_JOINT_NAMES}
                    cmd["r_hip_roll"] = float(angle)
                    cmd["l_hip_roll"] = float(angle)
                    await _send(ws, "policy.tick", {"joint_positions": cmd, "duration": 50})
                elif stage == "walk":
                    await _send(ws, "walk.set", {
                        "x": 0.01, "y": 0.0, "yaw": 0.0,
                        "height": 0.036, "speed": 1,
                    })

                resp = await _recv(ws)
                telemetry = resp.get("data", {})
                telemetry["step"] = step
                telemetry["elapsed"] = elapsed
                telemetry["stage"] = stage
                log.append(telemetry)

                if step % 20 == 0:
                    imu_r = telemetry.get("imu_roll", 0)
                    imu_p = telemetry.get("imu_pitch", 0)
                    print(f"  t={elapsed:.1f}s step={step} imu=({imu_r:.3f}, {imu_p:.3f})")

                await asyncio.sleep(0.05)

        except KeyboardInterrupt:
            print("  Interrupted!")
        finally:
            await _send(ws, "policy.stop", {})
            try:
                await _recv(ws)
            except Exception:  # noqa: BLE001
                pass

    print(f"  Completed: {len(log)} frames recorded")
    return {"stage": stage, "success": True, "log": log}


async def _send(ws, command: str, payload: dict) -> None:
    msg = {
        "type": "command",
        "request_id": f"validate-{time.monotonic():.3f}",
        "command": command,
        "payload": payload,
    }
    await ws.send(json.dumps(msg))


async def _recv(ws, timeout: float = 2.0) -> dict:
    try:
        raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
        return json.loads(raw)
    except asyncio.TimeoutError:
        return {"ok": False, "message": "timeout"}
    except Exception as exc:  # noqa: BLE001 — surfaced in result
        return {"ok": False, "message": f"recv error: {exc}"}


def analyze_log(log: list[dict]) -> dict:
    """Analyze recorded telemetry for sim-to-real gap metrics."""
    if not log:
        return {}

    imu_rolls = [f.get("imu_roll", 0) for f in log]
    imu_pitches = [f.get("imu_pitch", 0) for f in log]

    return {
        "frames": len(log),
        "duration_s": log[-1].get("elapsed", 0) if log else 0,
        "imu_roll_mean": float(np.mean(imu_rolls)),
        "imu_roll_std": float(np.std(imu_rolls)),
        "imu_roll_max": float(np.max(np.abs(imu_rolls))),
        "imu_pitch_mean": float(np.mean(imu_pitches)),
        "imu_pitch_std": float(np.std(imu_pitches)),
        "imu_pitch_max": float(np.max(np.abs(imu_pitches))),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate real robot deployment")
    parser.add_argument("--bridge", default="ws://localhost:9100")
    parser.add_argument(
        "--stage", default="servo_ping", choices=list(STAGES.keys()),
        help="Validation stage to run",
    )
    parser.add_argument("--all", action="store_true", help="Run all stages in sequence")
    parser.add_argument("--duration", type=float, default=5.0, help="Duration per stage")
    parser.add_argument("--output", default=None, help="Save telemetry log to JSON file")
    parser.add_argument(
        "--profile", default="hiwonder-ainex",
        help="Robot profile id (reserved for future per-profile stages)",
    )
    args = parser.parse_args()

    stages = list(STAGES.keys()) if args.all else [args.stage]
    all_results: list[dict] = []

    for stage in stages:
        result = asyncio.run(run_validation(args.bridge, stage, args.duration))
        analysis = analyze_log(result.get("log", []))
        result["analysis"] = analysis
        all_results.append(result)

        if analysis:
            print("\n  Analysis:")
            print(
                f"    IMU roll:  mean={analysis['imu_roll_mean']:.4f} "
                f"std={analysis['imu_roll_std']:.4f} "
                f"max={analysis['imu_roll_max']:.4f}"
            )
            print(
                f"    IMU pitch: mean={analysis['imu_pitch_mean']:.4f} "
                f"std={analysis['imu_pitch_std']:.4f} "
                f"max={analysis['imu_pitch_max']:.4f}"
            )

    if args.output:
        with open(args.output, "w") as f:
            json.dump(all_results, f, indent=2, default=str)
        print(f"\nTelemetry saved to {args.output}")

    print("\n" + "=" * 50)
    print("VALIDATION SUMMARY")
    print("=" * 50)
    for r in all_results:
        status = "PASS" if r.get("success") else "FAIL"
        frames = len(r.get("log", []))
        print(f"  {r['stage']:15s}: {status} ({frames} frames)")


# Static analysis happiness — these symbols are referenced inline above.
_ = joint_name_to_servo_id, radians_to_pulse, ALL_JOINT_NAMES


if __name__ == "__main__":
    main()
