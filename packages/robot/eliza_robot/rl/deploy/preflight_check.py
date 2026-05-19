"""Pre-flight checks before deploying a policy to the real robot.

Verifies that the bridge server is reachable, the backend is healthy,
servos respond, IMU data is flowing, and battery is adequate.

Usage::

    python -m eliza_robot.rl.deploy.preflight_check
    python -m eliza_robot.rl.deploy.preflight_check --bridge ws://192.168.1.100:9100 \
        --profile hiwonder-ainex
"""

from __future__ import annotations

import argparse
import asyncio
import json


async def check_bridge(bridge_url: str, timeout: float = 5.0) -> dict:
    """Run all pre-flight checks and return a results dict."""
    import websockets

    results: dict = {
        "bridge_reachable": False,
        "backend_type": "unknown",
        "servo_count": 0,
        "imu_data": False,
        "battery_mv": 0,
        "battery_ok": False,
        "all_ok": False,
        "errors": [],
    }

    try:
        async with websockets.connect(bridge_url, open_timeout=timeout) as ws:
            results["bridge_reachable"] = True

            await ws.send(json.dumps({
                "type": "command",
                "request_id": "preflight-status",
                "command": "status.get",
                "payload": {},
            }))
            raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
            status = json.loads(raw)
            data = status.get("data", {})
            results["backend_type"] = data.get("backend", "unknown")
            results["battery_mv"] = data.get("battery_mv", 0)
            results["battery_ok"] = (
                results["battery_mv"] >= 6500 or results["battery_mv"] == 0
            )
            if data.get("imu_roll") is not None:
                results["imu_data"] = True

            if "joint_positions" in data and isinstance(data["joint_positions"], dict):
                results["servo_count"] = len(data["joint_positions"])

            if not results["battery_ok"]:
                results["errors"].append(
                    f"Battery low: {results['battery_mv']}mV (minimum 6500mV)"
                )
            if not results["imu_data"]:
                results["errors"].append("No IMU data in status response")
            if results["servo_count"] == 0:
                results["errors"].append("No servo position data in status response")

    except asyncio.TimeoutError:
        results["errors"].append(f"Connection timeout after {timeout}s")
    except ConnectionRefusedError:
        results["errors"].append(f"Connection refused at {bridge_url}")
    except Exception as e:  # noqa: BLE001 — surface unexpected failures in results
        results["errors"].append(f"Connection error: {e}")

    results["all_ok"] = (
        results["bridge_reachable"]
        and results["battery_ok"]
        and len(results["errors"]) == 0
    )
    return results


def print_results(results: dict) -> None:
    print("\n" + "=" * 50)
    print("PRE-FLIGHT CHECK RESULTS")
    print("=" * 50)

    checks = [
        ("Bridge reachable", results["bridge_reachable"]),
        ("Backend type", results["backend_type"]),
        ("Servo count", results["servo_count"]),
        ("IMU data flowing", results["imu_data"]),
        ("Battery voltage", f"{results['battery_mv']}mV"),
        ("Battery OK", results["battery_ok"]),
    ]

    for name, value in checks:
        icon = ("PASS" if value else "FAIL") if isinstance(value, bool) else str(value)
        print(f"  {name:25s}: {icon}")

    if results["errors"]:
        print("\nERRORS:")
        for err in results["errors"]:
            print(f"  - {err}")

    print()
    if results["all_ok"]:
        print("ALL CHECKS PASSED — safe to deploy.")
    else:
        print("CHECKS FAILED — do NOT deploy until issues are resolved.")
    print()


def main() -> int:
    parser = argparse.ArgumentParser(description="Pre-flight checks for robot deployment")
    parser.add_argument("--bridge", default="ws://localhost:9100", help="Bridge WebSocket URL")
    parser.add_argument("--timeout", type=float, default=5.0, help="Connection timeout (seconds)")
    parser.add_argument(
        "--profile",
        default="hiwonder-ainex",
        help="Robot profile id (reserved for future per-profile checks).",
    )
    args = parser.parse_args()

    results = asyncio.run(check_bridge(args.bridge, args.timeout))
    results["profile"] = args.profile
    print_results(results)
    return 0 if results["all_ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
