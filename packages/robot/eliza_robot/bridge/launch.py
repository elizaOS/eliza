"""Unified bridge launcher with target-based configuration.

Single entrypoint that selects backend (real/sim/isaac/mock) and starts
both ROSBridge-compatible and command-envelope websocket servers.

Usage:
    python -m bridge.launch --target isaac
    python -m bridge.launch --target real
    python -m bridge.launch --target mock

Environment variable overrides:
    AINEX_BRIDGE_HOST, AINEX_ROSBRIDGE_PORT, AINEX_ENVELOPE_PORT,
    AINEX_PUBLISH_HZ, AINEX_MAX_CMD_SEC, AINEX_DEADMAN_SEC
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import sys
from dataclasses import dataclass
from pathlib import Path

from eliza_robot.bridge.types import JsonDict

CONFIG_PATH = Path(__file__).parent / "config" / "bridge_targets.json"


@dataclass
class TargetConfig:
    """Resolved configuration for a bridge target."""

    name: str
    description: str
    backend: str
    host: str
    rosbridge_port: int
    envelope_port: int
    publish_hz: float
    max_commands_per_sec: int
    deadman_timeout_sec: float
    requires_ros: bool
    camera_url: str


def _load_targets() -> dict[str, JsonDict]:
    raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    targets = raw.get("targets", {})
    if not isinstance(targets, dict):
        raise ValueError("bridge_targets.json must have a 'targets' object")
    return targets


def _apply_env_overrides(cfg: dict[str, object]) -> dict[str, object]:
    """Apply environment variable overrides to target config."""
    env_map = {
        "AINEX_BRIDGE_HOST": ("host", str),
        "AINEX_ROSBRIDGE_PORT": ("rosbridge_port", int),
        "AINEX_ENVELOPE_PORT": ("envelope_port", int),
        "AINEX_PUBLISH_HZ": ("publish_hz", float),
        "AINEX_MAX_CMD_SEC": ("max_commands_per_sec", int),
        "AINEX_DEADMAN_SEC": ("deadman_timeout_sec", float),
        "AINEX_CAMERA_URL": ("camera_url", str),
    }
    for env_var, (field, cast) in env_map.items():
        value = os.environ.get(env_var)
        if value is not None:
            cfg[field] = cast(value)
    return cfg


def resolve_target(name: str) -> TargetConfig:
    """Resolve a target name to a fully-configured TargetConfig."""
    targets = _load_targets()
    if name not in targets:
        available = ", ".join(sorted(targets.keys()))
        raise ValueError(f"unknown target '{name}'. Available: {available}")

    raw = dict(targets[name])
    raw = _apply_env_overrides(raw)

    return TargetConfig(
        name=name,
        description=str(raw.get("description", "")),
        backend=str(raw.get("backend", name)),
        host=str(raw.get("host", "0.0.0.0")),
        rosbridge_port=int(raw.get("rosbridge_port", 9090)),
        envelope_port=int(raw.get("envelope_port", 9100)),
        publish_hz=float(raw.get("publish_hz", 15.0)),
        max_commands_per_sec=int(raw.get("max_commands_per_sec", 30)),
        deadman_timeout_sec=float(raw.get("deadman_timeout_sec", 5.0)),
        requires_ros=bool(raw.get("requires_ros", False)),
        camera_url=str(raw.get("camera_url", "")),
    )


async def _run(target: TargetConfig, rosbridge: bool, envelope: bool) -> None:
    tasks: list[asyncio.Task[None]] = []

    if rosbridge:
        from eliza_robot.bridge.rosbridge_server import RuntimeConfig as RBConfig
        from eliza_robot.bridge.rosbridge_server import _run_server as rb_run

        rb_config = RBConfig(
            publish_hz=target.publish_hz,
            max_commands_per_sec=target.max_commands_per_sec,
            deadman_timeout_sec=target.deadman_timeout_sec,
            camera_url=target.camera_url,
        )
        tasks.append(
            asyncio.create_task(
                rb_run(target.host, target.rosbridge_port, target.backend, rb_config)
            )
        )

    if envelope:
        from eliza_robot.bridge.server import RuntimeConfig as EnvConfig
        from eliza_robot.bridge.server import _run_server as env_run

        env_config = EnvConfig(
            queue_size=256,
            max_commands_per_sec=target.max_commands_per_sec,
            deadman_timeout_sec=target.deadman_timeout_sec,
            trace_log_path="",
        )
        tasks.append(
            asyncio.create_task(
                env_run(target.host, target.envelope_port, target.backend, env_config)
            )
        )

    if not tasks:
        print("No servers to start. Use --rosbridge and/or --envelope.")
        return

    # Wait until interrupted.
    await asyncio.gather(*tasks)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Unified AiNex bridge launcher",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Targets:\n"
            "  real   - Real AiNex robot via ROS1\n"
            "  sim    - Gazebo simulation via ROS1\n"
            "  isaac  - IsaacLab simulation\n"
            "  mock   - In-memory mock for development\n"
        ),
    )
    parser.add_argument(
        "--target",
        type=str,
        default="mock",
        help="target backend to launch (default: mock)",
    )
    parser.add_argument(
        "--rosbridge",
        action="store_true",
        default=True,
        help="start ROSBridge-compatible server (default: true)",
    )
    parser.add_argument(
        "--no-rosbridge",
        action="store_true",
        help="disable ROSBridge-compatible server",
    )
    parser.add_argument(
        "--envelope",
        action="store_true",
        default=False,
        help="also start command-envelope server",
    )
    parser.add_argument(
        "--list-targets",
        action="store_true",
        help="list available targets and exit",
    )
    args = parser.parse_args()

    if args.list_targets:
        targets = _load_targets()
        for name, cfg in sorted(targets.items()):
            desc = cfg.get("description", "")
            backend = cfg.get("backend", name)
            ros = "yes" if cfg.get("requires_ros", False) else "no"
            print(f"  {name:8s}  backend={backend:10s}  ros={ros:3s}  {desc}")
        return

    target = resolve_target(args.target)
    rosbridge = not args.no_rosbridge
    envelope = args.envelope

    print(f"Target: {target.name} ({target.description})")
    print(f"Backend: {target.backend}")
    if rosbridge:
        print(f"ROSBridge: ws://{target.host}:{target.rosbridge_port}")
    if envelope:
        print(f"Envelope: ws://{target.host}:{target.envelope_port}")
    print(f"Safety: rate_limit={target.max_commands_per_sec}/s deadman={target.deadman_timeout_sec}s")
    print()

    asyncio.run(_run(target, rosbridge=rosbridge, envelope=envelope))


if __name__ == "__main__":
    main()
