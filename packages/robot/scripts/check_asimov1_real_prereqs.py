#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.bridge.launch import resolve_target  # noqa: E402
from eliza_robot.bridge.server import RuntimeConfig, _build_backend_factory  # noqa: E402


def check_asimov1_real_prereqs(*, require_credentials: bool = False, require_modules: bool = False) -> dict:
    try:
        target = resolve_target("asimov-real")
    except Exception:
        target = None
    backend_factory_ok = False
    if target is not None:
        try:
            _build_backend_factory(
                target.backend,
                RuntimeConfig(
                    queue_size=256,
                    max_commands_per_sec=target.max_commands_per_sec,
                    deadman_timeout_sec=target.deadman_timeout_sec,
                    trace_log_path="",
                    profile_id=target.profile_id,
                    asimov_livekit_url=target.asimov_livekit_url,
                    asimov_livekit_token=target.asimov_livekit_token,
                ),
            )
            backend_factory_ok = True
        except Exception:
            backend_factory_ok = False
    livekit_url = bool(os.environ.get("ASIMOV_LIVEKIT_URL"))
    livekit_token = bool(os.environ.get("ASIMOV_LIVEKIT_TOKEN"))
    livekit_available = importlib.util.find_spec("livekit") is not None
    try:
        edge_available = importlib.util.find_spec("edge.generated.edge_cloud_pb2") is not None
    except ModuleNotFoundError:
        edge_available = False
    checks = {
        "target_registered": target is not None,
        "command_envelope_target": target is not None
        and target.backend == "asimov_remote"
        and target.profile_id == "asimov-1"
        and target.envelope_port == 9104,
        "livekit_url_configured": livekit_url,
        "livekit_token_configured": livekit_token,
        "livekit_python_available": livekit_available,
        "edge_protobuf_available": edge_available,
        "backend_factory": backend_factory_ok,
    }
    missing = []
    if not checks["target_registered"]:
        missing.append("bridge target asimov-real")
    if not checks["command_envelope_target"]:
        missing.append("asimov-real command-envelope configuration")
    if not checks["backend_factory"]:
        missing.append("asimov_remote backend factory")
    if require_credentials:
        if not livekit_url:
            missing.append("ASIMOV_LIVEKIT_URL")
        if not livekit_token:
            missing.append("ASIMOV_LIVEKIT_TOKEN")
    if require_modules:
        if not livekit_available:
            missing.append("livekit")
        if not edge_available:
            missing.append("edge.generated.edge_cloud_pb2")
    return {
        "ok": not missing,
        "profile_id": "asimov-1",
        "target": "asimov-real",
        "backend": "asimov_remote",
        "envelope_port": target.envelope_port if target is not None else None,
        "checks": checks,
        "missing_required": missing,
        "capabilities": {
            "profile_id": "asimov-1",
            "connected": False,
            "mock": False,
            "dof": 25,
            "leg_action_dim": 12,
            "actor_observation_dim": 45,
            "control_hz": 50.0,
            "physics_hz": 200.0,
            "transport": "livekit",
            "command_topic": "commands",
            "command_envelope": "edge.generated.edge_cloud_pb2.CloudCommand",
            "telemetry_track": "telemetry",
            "telemetry_message": "edge.generated.edge_cloud_pb2.EdgeTelemetry",
            "trajectory_timeout_ms": 200,
            "livekit_configured": livekit_url and livekit_token,
        },
        "notes": [
            "This preflight does not connect to hardware or command motion.",
            "Use --require-credentials and --require-modules on a hardware host.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--require-credentials", action="store_true")
    parser.add_argument("--require-modules", action="store_true")
    args = parser.parse_args()
    report = check_asimov1_real_prereqs(
        require_credentials=args.require_credentials,
        require_modules=args.require_modules,
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
