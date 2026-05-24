#!/usr/bin/env python3
"""Run a generated end-to-end full-training bundle with stage logs.

The generated bundle contains numbered shell scripts. This runner provides the
remote-host execution contract around them: START/END markers, status files,
optional periodic log/status upload, and success/failure markers.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.validate_end_to_end_full_training_preflight import (  # noqa: E402
    REQUIRED_LAUNCH_ORDER,
)


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _stage_name(script: Path) -> str:
    return script.name.removesuffix(".sh")


def _resolve_stage(bundle_dir: Path, stage: str) -> Path:
    path = Path(stage)
    if path.is_absolute():
        return path
    candidate = bundle_dir / path
    if candidate.is_file():
        return candidate
    return bundle_dir / "scripts" / path.name


def _sync_dir(*, aws_bin: str, endpoint: str, source: Path, dest_uri: str) -> dict[str, Any]:
    if not source.exists():
        return {"ok": True, "skipped": True, "source": str(source), "dest": dest_uri}
    result = subprocess.run(
        [aws_bin, "--endpoint-url", endpoint, "s3", "sync", str(source), dest_uri.rstrip("/")],
        check=False,
        text=True,
        capture_output=True,
    )
    return {
        "ok": result.returncode == 0,
        "source": str(source),
        "dest": dest_uri,
        "returncode": result.returncode,
        "stdout_tail": result.stdout[-2000:],
        "stderr_tail": result.stderr[-2000:],
    }


def _upload_status(
    *,
    aws_bin: str,
    endpoint: str,
    upload_uri: str | None,
    package_root: Path,
    include_artifacts: bool,
) -> list[dict[str, Any]]:
    if not upload_uri:
        return []
    roots = ("logs", "status")
    results: list[dict[str, Any]] = []
    if include_artifacts:
        roots = roots + ("checkpoints", "evidence")
    for name in roots:
        results.append(
            _sync_dir(
                aws_bin=aws_bin,
                endpoint=endpoint,
                source=package_root / name,
                dest_uri=f"{upload_uri.rstrip('/')}/{name}",
            )
        )
    return results


def _heartbeat_loop(
    *,
    stop: threading.Event,
    status_path: Path,
    payload: dict[str, Any],
    interval_seconds: float,
    aws_bin: str,
    endpoint: str,
    upload_uri: str | None,
    package_root: Path,
) -> None:
    while not stop.wait(interval_seconds):
        payload["heartbeat_at"] = _now()
        _write_json(status_path, payload)
        _upload_status(
            aws_bin=aws_bin,
            endpoint=endpoint,
            upload_uri=upload_uri,
            package_root=package_root,
            include_artifacts=False,
        )


def _run_stage(
    *,
    script: Path,
    package_root: Path,
    logs_dir: Path,
    status_dir: Path,
    upload_uri: str | None,
    aws_bin: str,
    endpoint: str,
    heartbeat_seconds: float,
) -> dict[str, Any]:
    name = _stage_name(script)
    log_path = logs_dir / f"{name}.log"
    status_path = status_dir / f"{name}.json"
    started_at = _now()
    status = {
        "schema": "robot-nebius-stage-status-v1",
        "stage": name,
        "script": str(script),
        "state": "running",
        "started_at": started_at,
        "heartbeat_at": started_at,
        "log": str(log_path),
    }
    _write_json(status_path, status)
    stop = threading.Event()
    heartbeat = threading.Thread(
        target=_heartbeat_loop,
        kwargs={
            "stop": stop,
            "status_path": status_path,
            "payload": status,
            "interval_seconds": heartbeat_seconds,
            "aws_bin": aws_bin,
            "endpoint": endpoint,
            "upload_uri": upload_uri,
            "package_root": package_root,
        },
        daemon=True,
    )
    heartbeat.start()
    env = os.environ.copy()
    env.setdefault("ELIZA_ROBOT_PACKAGE_ROOT", str(package_root))
    logs_dir.mkdir(parents=True, exist_ok=True)
    with log_path.open("w", encoding="utf-8") as log:
        log.write(f"START {name} {started_at}\n")
        log.flush()
        process = subprocess.Popen(
            ["bash", str(script)],
            cwd=package_root,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        assert process.stdout is not None
        for line in process.stdout:
            log.write(line)
            log.flush()
            print(line, end="")
        rc = process.wait()
        ended_at = _now()
        log.write(f"END {name} rc={rc} {ended_at}\n")
    stop.set()
    heartbeat.join(timeout=2)
    status.update(
        {
            "state": "complete" if rc == 0 else "failed",
            "ended_at": ended_at,
            "heartbeat_at": ended_at,
            "returncode": rc,
        }
    )
    _write_json(status_path, status)
    upload_results = _upload_status(
        aws_bin=aws_bin,
        endpoint=endpoint,
        upload_uri=upload_uri,
        package_root=package_root,
        include_artifacts=True,
    )
    status["upload_results"] = upload_results
    status["upload_ok"] = all(result.get("ok") is True for result in upload_results)
    _write_json(status_path, status)
    final_status_upload = _upload_status(
        aws_bin=aws_bin,
        endpoint=endpoint,
        upload_uri=upload_uri,
        package_root=package_root,
        include_artifacts=False,
    )
    status["final_status_upload_ok"] = all(
        result.get("ok") is True for result in final_status_upload
    )
    _write_json(status_path, status)
    return status


def run_bundle(
    *,
    bundle_dir: Path,
    package_root: Path = ROOT,
    stages: tuple[str, ...] = REQUIRED_LAUNCH_ORDER,
    upload_uri: str | None = None,
    aws_bin: str = "aws",
    endpoint: str = "https://storage.eu-north1.nebius.cloud",
    heartbeat_seconds: float = 300.0,
) -> dict[str, Any]:
    bundle_dir = bundle_dir.resolve()
    package_root = package_root.resolve()
    logs_dir = package_root / "logs"
    status_dir = package_root / "status"
    status_dir.mkdir(parents=True, exist_ok=True)
    stage_paths = [_resolve_stage(bundle_dir, stage) for stage in stages]
    started_at = _now()
    report: dict[str, Any] = {
        "schema": "robot-nebius-full-training-runner-v1",
        "ok": False,
        "state": "running",
        "bundle_dir": str(bundle_dir),
        "package_root": str(package_root),
        "upload_uri": upload_uri,
        "endpoint": endpoint,
        "started_at": started_at,
        "stages": [],
    }
    _write_json(status_dir / "runner_status.json", report)
    for script in stage_paths:
        if not script.is_file():
            stage_status = {
                "stage": _stage_name(script),
                "script": str(script),
                "state": "missing-script",
                "returncode": 127,
                "started_at": _now(),
                "ended_at": _now(),
            }
        else:
            stage_status = _run_stage(
                script=script,
                package_root=package_root,
                logs_dir=logs_dir,
                status_dir=status_dir,
                upload_uri=upload_uri,
                aws_bin=aws_bin,
                endpoint=endpoint,
                heartbeat_seconds=heartbeat_seconds,
            )
        report["stages"].append(stage_status)
        report["state"] = stage_status["state"]
        report["last_stage"] = stage_status["stage"]
        report["heartbeat_at"] = _now()
        _write_json(status_dir / "runner_status.json", report)
        if stage_status.get("returncode") != 0:
            failure = {
                "failed_at": _now(),
                "stage": stage_status["stage"],
                "returncode": stage_status.get("returncode"),
            }
            _write_json(status_dir / "failure.json", failure)
            (status_dir / "failure.txt").write_text(json.dumps(failure) + "\n", encoding="utf-8")
            upload_results = _upload_status(
                aws_bin=aws_bin,
                endpoint=endpoint,
                upload_uri=upload_uri,
                package_root=package_root,
                include_artifacts=True,
            )
            report["upload_results"] = upload_results
            report["upload_ok"] = all(result.get("ok") is True for result in upload_results)
            report["state"] = "failed"
            report["ended_at"] = failure["failed_at"]
            _write_json(status_dir / "runner_status.json", report)
            final_status_upload = _upload_status(
                aws_bin=aws_bin,
                endpoint=endpoint,
                upload_uri=upload_uri,
                package_root=package_root,
                include_artifacts=False,
            )
            report["final_status_upload_ok"] = all(
                result.get("ok") is True for result in final_status_upload
            )
            _write_json(status_dir / "runner_status.json", report)
            return report
    ended_at = _now()
    report["ok"] = True
    report["state"] = "complete"
    report["ended_at"] = ended_at
    (status_dir / "success.txt").write_text(f"success {ended_at}\n", encoding="utf-8")
    _write_json(status_dir / "runner_status.json", report)
    upload_results = _upload_status(
        aws_bin=aws_bin,
        endpoint=endpoint,
        upload_uri=upload_uri,
        package_root=package_root,
        include_artifacts=True,
    )
    report["upload_results"] = upload_results
    report["upload_ok"] = all(result.get("ok") is True for result in upload_results)
    _write_json(status_dir / "runner_status.json", report)
    final_status_upload = _upload_status(
        aws_bin=aws_bin,
        endpoint=endpoint,
        upload_uri=upload_uri,
        package_root=package_root,
        include_artifacts=False,
    )
    report["final_status_upload_ok"] = all(
        result.get("ok") is True for result in final_status_upload
    )
    _write_json(status_dir / "runner_status.json", report)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--bundle-dir",
        type=Path,
        default=ROOT / "evidence" / "full_training_preflight",
    )
    parser.add_argument("--package-root", type=Path, default=ROOT)
    parser.add_argument("--stages", nargs="+", default=list(REQUIRED_LAUNCH_ORDER))
    parser.add_argument("--upload-uri", default=os.environ.get("NEBIUS_TRAINING_S3_URI"))
    parser.add_argument(
        "--endpoint",
        default=os.environ.get("NEBIUS_S3_ENDPOINT", "https://storage.eu-north1.nebius.cloud"),
    )
    parser.add_argument("--aws-bin", default="aws")
    parser.add_argument("--heartbeat-seconds", type=float, default=300.0)
    args = parser.parse_args(argv)
    report = run_bundle(
        bundle_dir=args.bundle_dir,
        package_root=args.package_root,
        stages=tuple(args.stages),
        upload_uri=args.upload_uri,
        aws_bin=args.aws_bin,
        endpoint=args.endpoint,
        heartbeat_seconds=args.heartbeat_seconds,
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
