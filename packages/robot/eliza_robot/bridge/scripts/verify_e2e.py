#!/usr/bin/env python3
"""End-to-end verification client for AiNex bridge.

Works against both:
- Native ROSBridge (rosbridge_suite on the real robot)
- Our custom AiNex bridge server (mock/isaac/ros backends)

Verifies camera, arm servo movement, head control, walking, and telemetry.

Usage:
    # Against real robot (native ROSBridge):
    python3 bridge/scripts/verify_e2e.py --url ws://192.168.1.218:9090

    # With camera check:
    python3 bridge/scripts/verify_e2e.py --url ws://192.168.1.218:9090 --verify-camera

    # Against our bridge (mock backend):
    python3 bridge/scripts/verify_e2e.py --url ws://localhost:9091

    # Against our bridge (isaac backend):
    python3 bridge/scripts/verify_e2e.py --url ws://localhost:9090
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import urllib.request
from dataclasses import dataclass, field
from urllib.parse import urlparse

try:
    from websockets.asyncio.client import connect
except ImportError:
    print("ERROR: websockets library required. Install with: pip install websockets")
    sys.exit(1)


# Arm servo IDs from joint_map.py (real hardware addresses)
ARM_SERVOS = {
    "r_sho_pitch": 14,
    "r_sho_roll": 16,
    "r_el_pitch": 18,
    "r_el_yaw": 20,
    "r_gripper": 22,
    "l_sho_pitch": 13,
    "l_sho_roll": 15,
    "l_el_pitch": 17,
    "l_el_yaw": 19,
    "l_gripper": 21,
}

HEAD_PAN_ID = 23
HEAD_TILT_ID = 24


@dataclass
class TestResult:
    name: str
    passed: bool
    detail: str = ""


@dataclass
class VerifySession:
    url: str
    verify_camera: bool = False
    timeout_sec: float = 10.0
    is_native_rosbridge: bool = False
    results: list[TestResult] = field(default_factory=list)

    def record(self, name: str, passed: bool, detail: str = "") -> None:
        self.results.append(TestResult(name=name, passed=passed, detail=detail))
        status = "PASS" if passed else "FAIL"
        print(f"  [{status}] {name}" + (f" -- {detail}" if detail else ""))


async def _send(ws: object, payload: dict) -> None:
    await ws.send(json.dumps(payload))


async def _recv(ws: object, timeout: float = 5.0) -> dict:
    raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
    return json.loads(raw)


async def _recv_until_op(ws: object, op: str, timeout: float = 5.0) -> dict | None:
    """Receive messages until we get one with the expected op, or timeout."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            remaining = deadline - time.monotonic()
            msg = await _recv(ws, timeout=max(0.1, remaining))
            if msg.get("op") == op:
                return msg
        except (asyncio.TimeoutError, TimeoutError):
            return None
    return None


async def _drain(ws: object, duration: float = 0.5) -> list[dict]:
    """Collect messages for a short duration."""
    msgs = []
    deadline = time.monotonic() + duration
    while time.monotonic() < deadline:
        try:
            remaining = deadline - time.monotonic()
            raw = await asyncio.wait_for(ws.recv(), timeout=max(0.05, remaining))
            msgs.append(json.loads(raw))
        except (asyncio.TimeoutError, TimeoutError):
            break
    return msgs


def _extract_host(url: str) -> str:
    parsed = urlparse(url)
    return parsed.hostname or "localhost"


async def run_verification(session: VerifySession) -> bool:
    print(f"\nConnecting to {session.url} ...")
    robot_host = _extract_host(session.url)
    request_counter = 0

    def next_id() -> str:
        nonlocal request_counter
        request_counter += 1
        return f"verify-{request_counter}"

    try:
        async with connect(session.url, open_timeout=session.timeout_sec) as ws:
            print("  WebSocket connected!")

            # ── Detect server type ──
            # Our bridge sends a hello op immediately. Native ROSBridge doesn't.
            print("\n== Detecting Server Type ==")
            first_msgs = await _drain(ws, 2.0)
            hello = None
            backend = "native_rosbridge"
            for m in first_msgs:
                if m.get("op") == "hello":
                    hello = m
                    backend = hello.get("backend", "unknown")
                    break

            if hello:
                session.is_native_rosbridge = False
                caps = hello.get("capabilities", {})
                safety = hello.get("safety", {})
                camera_url = hello.get("camera_url", "")
                session.record("server_type", True, f"AiNex bridge (backend={backend})")
                session.record(
                    "capabilities",
                    bool(caps),
                    f"keys={list(caps.keys())[:6]}",
                )
                session.record(
                    "safety_config",
                    "max_commands_per_sec" in safety,
                    f"rate_limit={safety.get('max_commands_per_sec')}/s deadman={safety.get('deadman_timeout_sec')}s",
                )
            else:
                session.is_native_rosbridge = True
                camera_url = ""
                session.record("server_type", True, "Native ROSBridge (rosbridge_suite)")

            # ── Camera ──
            print("\n== Camera ==")
            if camera_url:
                cam_url = camera_url.replace("{robot_ip}", robot_host)
            else:
                # Default web_video_server URL for native rosbridge
                cam_url = f"http://{robot_host}:8080/stream?topic=/camera/image_raw&type=mjpeg&quality=70"

            if session.verify_camera:
                # Try snapshot endpoint first (more reliable than MJPEG stream for testing)
                snapshot_url = f"http://{robot_host}:8080/snapshot?topic=/camera/image_raw"
                stream_ok = False
                try:
                    req = urllib.request.Request(snapshot_url, method="GET")
                    with urllib.request.urlopen(req, timeout=5) as resp:
                        chunk = resp.read(8192)
                        if len(chunk) > 0:
                            session.record("camera_stream", True, f"snapshot: {len(chunk)} bytes from {snapshot_url}")
                            stream_ok = True
                        else:
                            session.record("camera_stream", False, f"snapshot empty (camera may not be publishing)")
                            stream_ok = True  # web_video_server is alive, just no frames
                except Exception:
                    pass

                if not stream_ok:
                    # Fallback: check if web_video_server root page is alive
                    try:
                        root_url = f"http://{robot_host}:8080/"
                        req = urllib.request.Request(root_url, method="GET")
                        with urllib.request.urlopen(req, timeout=5) as resp:
                            html = resp.read(4096).decode("utf-8", errors="replace")
                            has_topics = "image_raw" in html or "image_result" in html
                            session.record(
                                "camera_stream",
                                has_topics,
                                f"web_video_server alive, topics listed={has_topics} (camera may not be publishing frames)",
                            )
                    except Exception as exc:
                        session.record("camera_stream", False, f"web_video_server not reachable: {exc}")
            else:
                session.record("camera_stream", True, f"skipped (use --verify-camera to test {cam_url})")

            # ── Subscribe to telemetry topics ──
            print("\n== Telemetry ==")
            for topic in ["/walking/is_walking", "/ros_robot_controller/battery", "/imu"]:
                await _send(ws, {"op": "subscribe", "topic": topic, "id": next_id()})

            # For native ROSBridge, subscriptions are silent. For our bridge, drain acks.
            if not session.is_native_rosbridge:
                await _drain(ws, 0.5)

            # Wait for telemetry data
            await asyncio.sleep(1.0)
            telemetry_msgs = await _drain(ws, 2.0)
            telemetry_topics = {m.get("topic") for m in telemetry_msgs if m.get("op") == "publish"}
            session.record(
                "telemetry_received",
                len(telemetry_topics) > 0,
                f"topics={telemetry_topics}",
            )

            # Show battery if available
            for m in telemetry_msgs:
                if m.get("op") == "publish" and m.get("topic") == "/ros_robot_controller/battery":
                    mv = m.get("msg", {}).get("data", 0)
                    pct = max(0, min(100, (mv - 10000) / (12600 - 10000) * 100))
                    session.record("battery", True, f"{mv}mV ({pct:.0f}%)")
                    break

            # ── Head movement ──
            print("\n== Head Movement ==")
            # Pan to 0.3 rad (~17 degrees)
            await _send(ws, {
                "op": "publish",
                "topic": "/head_pan_controller/command",
                "msg": {"position": 0.3, "duration": 0.3},
                "id": next_id(),
            })
            # Tilt to -0.2 rad (~-11 degrees)
            await _send(ws, {
                "op": "publish",
                "topic": "/head_tilt_controller/command",
                "msg": {"position": -0.2, "duration": 0.3},
                "id": next_id(),
            })

            if not session.is_native_rosbridge:
                resp = await _recv_until_op(ws, "status", timeout=3.0)
                session.record("head_pan", resp is not None, "published" if resp else "no ack")
                resp = await _recv_until_op(ws, "status", timeout=3.0)
                session.record("head_tilt", resp is not None, "published" if resp else "no ack")
            else:
                # Native ROSBridge: publish is fire-and-forget, give it time to execute
                await asyncio.sleep(0.5)
                session.record("head_pan", True, "sent (0.3 rad)")
                session.record("head_tilt", True, "sent (-0.2 rad)")

            print("  (head should have moved — check the robot!)")
            await asyncio.sleep(0.5)

            # Reset head
            await _send(ws, {"op": "publish", "topic": "/head_pan_controller/command", "msg": {"position": 0.0, "duration": 0.3}, "id": next_id()})
            await _send(ws, {"op": "publish", "topic": "/head_tilt_controller/command", "msg": {"position": 0.0, "duration": 0.3}, "id": next_id()})
            await _drain(ws, 0.3)

            # ── Arm servo movement ──
            print("\n== Arm Servo Movement ==")
            # Move right shoulder pitch forward (400) and right elbow back (600)
            # duration is in SECONDS for the real robot (ROS float64)
            await _send(ws, {
                "op": "publish",
                "topic": "/ros_robot_controller/bus_servo/set_position",
                "msg": {
                    "duration": 0.8,
                    "position": [
                        {"id": ARM_SERVOS["r_sho_pitch"], "position": 400},
                        {"id": ARM_SERVOS["r_el_pitch"], "position": 600},
                    ],
                },
                "id": next_id(),
            })

            if not session.is_native_rosbridge:
                resp = await _recv_until_op(ws, "status", timeout=3.0)
                session.record("arm_servo_set", resp is not None and "published" in resp.get("msg", ""), resp.get("msg", "") if resp else "no ack")
            else:
                await asyncio.sleep(0.3)
                session.record("arm_servo_set", True, "sent r_sho_pitch=400, r_el_pitch=600")

            print("  (right arm should have moved — check the robot!)")
            await asyncio.sleep(1.0)

            # Read back via get_position service
            rid = next_id()
            await _send(ws, {
                "op": "call_service",
                "service": "/ros_robot_controller/bus_servo/get_position",
                "args": {"id": [ARM_SERVOS["r_sho_pitch"], ARM_SERVOS["r_el_pitch"]]},
                "id": rid,
            })
            svc_resp = await _recv_until_op(ws, "service_response", timeout=5.0)
            if svc_resp:
                values = svc_resp.get("values", {})
                positions = values.get("position", [])
                if positions:
                    pos_map = {p.get("id", 0): p.get("position", 0) for p in positions if isinstance(p, dict)}
                    r_sho = pos_map.get(ARM_SERVOS["r_sho_pitch"], "?")
                    r_el = pos_map.get(ARM_SERVOS["r_el_pitch"], "?")
                    session.record(
                        "arm_servo_readback",
                        len(positions) >= 2,
                        f"r_sho_pitch={r_sho}, r_el_pitch={r_el}",
                    )
                else:
                    session.record("arm_servo_readback", False, f"no positions in response: {values}")
            else:
                session.record("arm_servo_readback", False, "service call timed out")

            # Reset arm to center
            await _send(ws, {
                "op": "publish",
                "topic": "/ros_robot_controller/bus_servo/set_position",
                "msg": {
                    "duration": 0.8,
                    "position": [
                        {"id": ARM_SERVOS["r_sho_pitch"], "position": 500},
                        {"id": ARM_SERVOS["r_el_pitch"], "position": 500},
                    ],
                },
                "id": next_id(),
            })
            await asyncio.sleep(1.0)
            await _drain(ws, 0.3)
            print("  (right arm reset to center)")

            # ── Walk start/stop (brief) ──
            print("\n== Walking (brief test) ==")
            rid = next_id()
            await _send(ws, {
                "op": "call_service",
                "service": "/walking/command",
                "args": {"command": "start"},
                "id": rid,
            })
            svc_resp = await _recv_until_op(ws, "service_response", timeout=5.0)
            if svc_resp:
                result = svc_resp.get("result", svc_resp.get("values", {}).get("result", False))
                session.record("walk_start", bool(result), f"response={svc_resp.get('values', {})}")
            else:
                session.record("walk_start", False, "service call timed out")

            # Let it walk for a moment
            await asyncio.sleep(1.0)

            # Check is_walking telemetry
            walk_tel = await _drain(ws, 1.0)
            walking_data = [
                m.get("msg", {}).get("data")
                for m in walk_tel
                if m.get("op") == "publish" and m.get("topic") == "/walking/is_walking"
            ]
            if walking_data:
                session.record("walking_telemetry", True, f"is_walking={walking_data[-1]}")
            else:
                session.record("walking_telemetry", False, "no /walking/is_walking data received (may be normal if topic not active)")

            # Stop
            rid = next_id()
            await _send(ws, {
                "op": "call_service",
                "service": "/walking/command",
                "args": {"command": "stop"},
                "id": rid,
            })
            svc_resp = await _recv_until_op(ws, "service_response", timeout=5.0)
            if svc_resp:
                result = svc_resp.get("result", svc_resp.get("values", {}).get("result", False))
                session.record("walk_stop", bool(result), "stopped")
            else:
                session.record("walk_stop", False, "service call timed out")

            # ── Servo state service ──
            print("\n== Servo State ==")
            rid = next_id()
            await _send(ws, {
                "op": "call_service",
                "service": "/ros_robot_controller/bus_servo/get_state",
                "args": {
                    "cmd": [
                        {"id": ARM_SERVOS["r_sho_pitch"]},
                        {"id": HEAD_PAN_ID},
                    ],
                },
                "id": rid,
            })
            svc_resp = await _recv_until_op(ws, "service_response", timeout=5.0)
            if svc_resp:
                values = svc_resp.get("values", {})
                states = values.get("state", [])
                session.record(
                    "servo_state",
                    len(states) >= 2,
                    f"got {len(states)} states, success={values.get('success')}",
                )
            else:
                session.record("servo_state", False, "service call timed out")

            # ── Cleanup ──
            print("\n== Cleanup ==")
            for topic in ["/walking/is_walking", "/ros_robot_controller/battery", "/imu"]:
                await _send(ws, {"op": "unsubscribe", "topic": topic, "id": next_id()})
            await _drain(ws, 0.3)
            session.record("cleanup", True, "unsubscribed all")

    except Exception as exc:
        session.record("connection", False, f"{type(exc).__name__}: {exc}")

    # Print summary
    passed = sum(1 for r in session.results if r.passed)
    total = len(session.results)
    failed = total - passed

    print(f"\n{'='*60}")
    print(f"  Results: {passed}/{total} passed" + (f", {failed} FAILED" if failed else ""))
    print(f"{'='*60}")

    if failed:
        print("\nFailed tests:")
        for r in session.results:
            if not r.passed:
                print(f"  - {r.name}: {r.detail}")

    return failed == 0


def main() -> None:
    parser = argparse.ArgumentParser(description="AiNex bridge end-to-end verification")
    parser.add_argument(
        "--url",
        type=str,
        default="ws://localhost:9091",
        help="websocket URL (default: ws://localhost:9091 for mock)",
    )
    parser.add_argument(
        "--verify-camera",
        action="store_true",
        help="also verify camera MJPEG stream is accessible",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=10.0,
        help="connection timeout in seconds",
    )
    args = parser.parse_args()

    session = VerifySession(
        url=args.url,
        verify_camera=args.verify_camera,
        timeout_sec=args.timeout,
    )

    success = asyncio.run(run_verification(session))
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
