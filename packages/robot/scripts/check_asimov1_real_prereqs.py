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


def check_asimov1_real_prereqs(*, require_credentials: bool = False, require_modules: bool = False) -> dict:
    livekit_url = bool(os.environ.get("ASIMOV_LIVEKIT_URL"))
    livekit_token = bool(os.environ.get("ASIMOV_LIVEKIT_TOKEN"))
    livekit_available = importlib.util.find_spec("livekit") is not None
    try:
        edge_available = importlib.util.find_spec("edge.generated.edge_cloud_pb2") is not None
    except ModuleNotFoundError:
        edge_available = False
    checks = {
        "target_registered": True,
        "command_envelope_target": True,
        "livekit_url_configured": livekit_url,
        "livekit_token_configured": livekit_token,
        "livekit_python_available": livekit_available,
        "edge_protobuf_available": edge_available,
        "backend_factory": True,
    }
    missing = []
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
        "envelope_port": 9104,
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
