#!/usr/bin/env python3
"""Resume a prepared clean Nebius robot training launch.

The preparation step uploads the payload and creates JSON requests under /tmp.
This command performs the remaining cloud actions after Nebius CLI auth is
available: create the boot disk, create the VM, wait for SSH, and inject the
Object Storage runtime environment over SSH instead of cloud-init metadata.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def _load_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _run_json(cmd: list[str], *, output_path: Path | None = None) -> dict[str, Any]:
    result = subprocess.run(
        cmd,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or " ".join(cmd))
    if output_path is not None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(result.stdout, encoding="utf-8")
    return json.loads(result.stdout)


def _looks_like_auth_prompt(text: str) -> bool:
    lowered = text.lower()
    return any(
        marker in lowered
        for marker in (
            "switch to your browser",
            "auth.nebius.com/oauth2/authorize",
            "please log in",
            "authentication",
        )
    )


def _process_output_text(*parts: object) -> str:
    normalized: list[str] = []
    for part in parts:
        if isinstance(part, bytes):
            normalized.append(part.decode("utf-8", errors="replace"))
        elif isinstance(part, str):
            normalized.append(part)
    return "\n".join(item for item in normalized if item)


def _check_nebius_auth(nebius_bin: str, *, timeout_seconds: int) -> dict[str, Any]:
    cmd = [
        nebius_bin,
        "--no-browser",
        "--auth-timeout",
        f"{timeout_seconds}s",
        "iam",
        "whoami",
        "--format",
        "json",
    ]
    try:
        result = subprocess.run(
            cmd,
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout_seconds + 5,
        )
    except subprocess.TimeoutExpired as exc:
        combined = _process_output_text(exc.stdout, exc.stderr)
        return {
            "ok": False,
            "reason": "nebius_cli_auth_timeout",
            "timeout_seconds": timeout_seconds,
            "auth_prompt_detected": _looks_like_auth_prompt(combined),
            "redacted": True,
        }
    combined = _process_output_text(result.stdout, result.stderr)
    if result.returncode == 0:
        return {
            "ok": True,
            "reason": "nebius_cli_auth_ok",
            "timeout_seconds": timeout_seconds,
            "auth_prompt_detected": False,
            "redacted": True,
        }
    reason = (
        "nebius_cli_auth_required"
        if _looks_like_auth_prompt(combined)
        else "nebius_cli_auth_check_failed"
    )
    return {
        "ok": False,
        "reason": reason,
        "returncode": result.returncode,
        "timeout_seconds": timeout_seconds,
        "auth_prompt_detected": _looks_like_auth_prompt(combined),
        "redacted": True,
    }


def _write_launch_report(report: dict[str, Any]) -> None:
    out = Path("evidence") / "nebius_full_training" / "clean_launch_status.json"
    _write_json(out, report)
    write_markdown(report, out.with_suffix(".md"))


def _normalize_instance_request_for_nebius(instance_request: dict[str, Any]) -> None:
    boot_disk = (
        instance_request.get("spec", {})
        .get("boot_disk", {})
    )
    if boot_disk.get("attach_mode") == "read_write":
        boot_disk["attach_mode"] = "READ_WRITE"
    spec = instance_request.get("spec", {})
    if spec.get("recovery_policy") == "fail":
        spec["recovery_policy"] = "FAIL"


def _public_ip(instance: dict[str, Any]) -> str | None:
    for iface in instance.get("status", {}).get("network_interfaces", []) or []:
        address = (iface.get("public_ip_address") or {}).get("address")
        if isinstance(address, str) and address:
            return address.split("/", 1)[0]
    return None


def _runtime_env_text(*, prepared: dict[str, Any], secret_env: Path) -> str:
    values: dict[str, str] = {}
    for line in secret_env.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            values[key] = value
    required = ("ACCESS_KEY_ID", "SECRET_ACCESS_KEY")
    missing = [key for key in required if not values.get(key)]
    if missing:
        raise RuntimeError(f"missing secret env keys: {', '.join(missing)}")
    return "\n".join(
        [
            f"AWS_ACCESS_KEY_ID={values['ACCESS_KEY_ID']}",
            f"AWS_SECRET_ACCESS_KEY={values['SECRET_ACCESS_KEY']}",
            "AWS_DEFAULT_REGION=eu-north1",
            "NEBIUS_S3_ENDPOINT=https://storage.eu-north1.nebius.cloud",
            f"NEBIUS_TRAINING_S3_URI={prepared['prefix'].rstrip('/')}",
            "",
        ]
    )


def _ssh_base(*, identity: Path, host: str) -> list[str]:
    return [
        "ssh",
        "-i",
        str(identity),
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=10",
        f"robot@{host}",
    ]


def _wait_for_ssh(*, identity: Path, host: str, timeout_seconds: int) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        result = subprocess.run(
            [*_ssh_base(identity=identity, host=host), "true"],
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode == 0:
            return True
        time.sleep(10)
    return False


def _inject_runtime_env(
    *,
    identity: Path,
    host: str,
    env_text: str,
) -> None:
    remote = (
        "sudo install -d -m 700 /etc/robot-full && "
        "sudo tee /etc/robot-full/object-storage.env >/dev/null && "
        "sudo chmod 600 /etc/robot-full/object-storage.env"
    )
    result = subprocess.run(
        [*_ssh_base(identity=identity, host=host), remote],
        input=env_text,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())


def launch_prepared_clean_run(
    *,
    prepared_report: Path,
    secret_env: Path,
    identity: Path,
    nebius_bin: str = "nebius",
    ssh_timeout_seconds: int = 900,
    auth_timeout_seconds: int = 20,
) -> dict[str, Any]:
    prepared = _load_json(prepared_report)
    run_id = str(prepared.get("run_id") or "")
    if not run_id:
        raise RuntimeError("prepared report has no run_id")
    tmp_dir = Path("/tmp") / run_id
    disk_request = Path(str(prepared.get("disk_create_request") or tmp_dir / "disk-create.json"))
    instance_template = tmp_dir / "instance-create.template.json"
    if not disk_request.is_file():
        raise RuntimeError(f"missing disk request: {disk_request}")
    if not instance_template.is_file():
        raise RuntimeError(f"missing instance template: {instance_template}")
    nebius_auth = _check_nebius_auth(nebius_bin, timeout_seconds=auth_timeout_seconds)
    if not nebius_auth.get("ok"):
        report = {
            "schema": "robot-nebius-clean-launch-v1",
            "ok": False,
            "state": "awaiting_nebius_cli_auth",
            "run_id": run_id,
            "generated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "disk_id": None,
            "instance_id": None,
            "instance_name": None,
            "public_ip": None,
            "ssh_ready": False,
            "runtime_env_injected": False,
            "payload_uri": prepared.get("payload_uri"),
            "nebius_auth": nebius_auth,
            "redacted": True,
        }
        _write_launch_report(report)
        return report
    runtime_env_text = _runtime_env_text(prepared=prepared, secret_env=secret_env)
    disk = _run_json(
        [nebius_bin, "compute", "disk", "create", "--file", str(disk_request), "--format", "json"],
        output_path=tmp_dir / "disk-create.out.json",
    )
    disk_id = disk.get("metadata", {}).get("id")
    if not disk_id:
        raise RuntimeError("disk create returned no disk id")
    instance_request = _load_json(instance_template)
    instance_request["spec"]["boot_disk"]["existing_disk"]["id"] = disk_id
    _normalize_instance_request_for_nebius(instance_request)
    instance_request_path = tmp_dir / "instance-create.json"
    _write_json(instance_request_path, instance_request)
    instance = _run_json(
        [
            nebius_bin,
            "compute",
            "instance",
            "create",
            "--file",
            str(instance_request_path),
            "--format",
            "json",
        ],
        output_path=tmp_dir / "instance-create.out.json",
    )
    instance_id = instance.get("metadata", {}).get("id")
    public_ip = _public_ip(instance)
    ssh_ready = False
    runtime_env_injected = False
    if public_ip:
        ssh_ready = _wait_for_ssh(
            identity=identity,
            host=public_ip,
            timeout_seconds=ssh_timeout_seconds,
        )
        if ssh_ready:
            _inject_runtime_env(
                identity=identity,
                host=public_ip,
                env_text=runtime_env_text,
            )
            runtime_env_injected = True
    report = {
        "schema": "robot-nebius-clean-launch-v1",
        "ok": bool(instance_id and public_ip and runtime_env_injected),
        "state": "launched" if instance_id and public_ip and runtime_env_injected else "incomplete",
        "run_id": run_id,
        "generated_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "disk_id": disk_id,
        "instance_id": instance_id,
        "instance_name": instance.get("metadata", {}).get("name"),
        "public_ip": public_ip,
        "ssh_ready": ssh_ready,
        "runtime_env_injected": runtime_env_injected,
        "payload_uri": prepared.get("payload_uri"),
        "nebius_auth": nebius_auth,
        "redacted": True,
    }
    _write_launch_report(report)
    return report


def write_markdown(report: dict[str, Any], path: Path) -> None:
    lines = [
        "# Nebius Clean Launch Status",
        "",
        f"Result: `{'launched' if report.get('ok') else 'not-launched'}`",
        f"State: `{report.get('state') or 'unknown'}`",
        f"Run: `{report.get('run_id')}`",
        f"Disk: `{report.get('disk_id') or 'missing'}`",
        f"Instance: `{report.get('instance_id') or 'missing'}`",
        f"Public IP: `{report.get('public_ip') or 'missing'}`",
        f"SSH ready: `{report.get('ssh_ready')}`",
        f"Runtime env injected: `{report.get('runtime_env_injected')}`",
        f"Payload: `{report.get('payload_uri')}`",
        f"Nebius auth: `{(report.get('nebius_auth') or {}).get('reason') or 'unknown'}`",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--prepared-report",
        type=Path,
        default=Path("evidence/nebius_full_training/clean_launch_prepared.json"),
    )
    parser.add_argument("--secret-env", type=Path, required=True)
    parser.add_argument("--identity", type=Path, default=Path.home() / ".ssh" / "id_ed25519")
    parser.add_argument("--nebius-bin", default="nebius")
    parser.add_argument("--ssh-timeout-seconds", type=int, default=900)
    parser.add_argument("--auth-timeout-seconds", type=int, default=20)
    args = parser.parse_args(argv)
    report = launch_prepared_clean_run(
        prepared_report=args.prepared_report,
        secret_env=args.secret_env,
        identity=args.identity,
        nebius_bin=args.nebius_bin,
        ssh_timeout_seconds=args.ssh_timeout_seconds,
        auth_timeout_seconds=args.auth_timeout_seconds,
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
