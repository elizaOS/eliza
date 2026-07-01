#!/usr/bin/env python3
"""Validate Nebius instance launch metadata for robot full-training runs.

The check is intentionally content-based and redacted: it never prints secret
values, but it does fail when cloud-init contains inline object-storage
credentials or bypasses the repo-owned full-training bundle runner.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

SECRET_PATTERNS = {
    "aws_access_key_id": re.compile(r"AWS_ACCESS_KEY_ID\s*=", re.IGNORECASE),
    "aws_secret_access_key": re.compile(r"AWS_SECRET_ACCESS_KEY\s*=", re.IGNORECASE),
    "nebius_secret_access_key": re.compile(r"SECRET_ACCESS_KEY\s*=", re.IGNORECASE),
}


def _load(path: Path) -> Any:
    text = sys.stdin.read() if str(path) == "-" else path.read_text(encoding="utf-8")
    return json.loads(text)


def _instance(payload: Any) -> dict[str, Any]:
    if isinstance(payload, list) and payload and isinstance(payload[0], dict):
        return payload[0]
    if isinstance(payload, dict):
        return payload
    return {}


def _cloud_init(instance: dict[str, Any]) -> str:
    spec = instance.get("spec") if isinstance(instance.get("spec"), dict) else {}
    value = spec.get("cloud_init_user_data") or spec.get("cloudInitUserData") or ""
    return value if isinstance(value, str) else ""


def validate_instance_launch_hygiene(path: Path) -> dict[str, Any]:
    instance = _instance(_load(path))
    metadata = instance.get("metadata") if isinstance(instance.get("metadata"), dict) else {}
    cloud_init = _cloud_init(instance)
    secret_hits = sorted(
        name for name, pattern in SECRET_PATTERNS.items() if pattern.search(cloud_init)
    )
    checks = {
        "instance_loaded": bool(instance),
        "cloud_init_present": bool(cloud_init),
        "no_inline_object_storage_credentials": not secret_hits,
        "uses_repo_owned_stage_runner": "eliza-robot-run-full-training-bundle" in cloud_init
        or "run_all_nebius_stages.sh" in cloud_init,
        "uses_nebius_s3_endpoint": "NEBIUS_S3_ENDPOINT" in cloud_init,
        "uses_training_s3_uri": "NEBIUS_TRAINING_S3_URI" in cloud_init,
        "has_status_heartbeat_upload_contract": "runner_status.json" in cloud_init
        or "heartbeat" in cloud_init.lower()
        or "eliza-robot-run-full-training-bundle" in cloud_init,
        "has_hard_cap_shutdown": "shutdown -h" in cloud_init,
    }
    return {
        "schema": "robot-nebius-instance-launch-hygiene-v1",
        "ok": all(checks.values()),
        "instance_id": metadata.get("id"),
        "instance_name": metadata.get("name"),
        "checks": checks,
        "secret_fields_embedded": secret_hits,
        "cloud_init_bytes": len(cloud_init.encode("utf-8")),
        "recommendations": _recommendations(checks, secret_hits),
    }


def _recommendations(checks: dict[str, bool], secret_hits: list[str]) -> list[str]:
    recommendations: list[str] = []
    if secret_hits:
        recommendations.append(
            "Do not embed object-storage access keys in cloud-init; inject them through a "
            "short-lived runtime secret channel or service-account capability outside VM metadata."
        )
    if not checks["uses_repo_owned_stage_runner"]:
        recommendations.append(
            "Launch with evidence/full_training_preflight/scripts/run_all_nebius_stages.sh "
            "or eliza-robot-run-full-training-bundle so stage logs and status are owned by the repo."
        )
    if not checks["has_status_heartbeat_upload_contract"]:
        recommendations.append(
            "Require periodic status/log heartbeat uploads during long training stages."
        )
    if not checks["uses_training_s3_uri"]:
        recommendations.append(
            "Set NEBIUS_TRAINING_S3_URI to the run prefix instead of reconstructing upload paths ad hoc."
        )
    return recommendations


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("instance_json", type=Path)
    args = parser.parse_args(argv)
    report = validate_instance_launch_hygiene(args.instance_json)
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
