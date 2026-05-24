from __future__ import annotations

import json
import subprocess
from pathlib import Path

from scripts.launch_prepared_nebius_clean_run import launch_prepared_clean_run


def _write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def test_launch_prepared_clean_run_creates_disk_instance_and_injects_env(
    monkeypatch,
    tmp_path: Path,
) -> None:
    run_id = "robot-full-clean-test"
    tmp_run = Path("/tmp") / run_id
    tmp_run.mkdir(parents=True, exist_ok=True)
    _write_json(
        tmp_path / "prepared.json",
        {
            "run_id": run_id,
            "prefix": "s3://bucket/robot-full-clean-test/",
            "payload_uri": "s3://bucket/robot-full-clean-test/payload.tar.gz",
            "disk_create_request": str(tmp_run / "disk-create.json"),
        },
    )
    _write_json(tmp_run / "disk-create.json", {"disk": True})
    _write_json(
        tmp_run / "instance-create.template.json",
        {
            "spec": {
                "boot_disk": {
                    "attach_mode": "read_write",
                    "existing_disk": {"id": "<disk-id>"},
                },
                "recovery_policy": "fail",
            }
        },
    )
    secret = tmp_path / "secret.env"
    secret.write_text(
        "ACCESS_KEY_ID=key\nSECRET_ACCESS_KEY=secret\n",
        encoding="utf-8",
    )
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        if cmd[:5] == ["nebius", "--no-browser", "--auth-timeout", "20s", "iam"]:
            return subprocess.CompletedProcess(
                cmd,
                0,
                stdout=json.dumps({"metadata": {"id": "user-1"}}),
                stderr="",
            )
        if cmd[:4] == ["nebius", "compute", "disk", "create"]:
            return subprocess.CompletedProcess(
                cmd,
                0,
                stdout=json.dumps({"metadata": {"id": "disk-1"}}),
                stderr="",
            )
        if cmd[:4] == ["nebius", "compute", "instance", "create"]:
            return subprocess.CompletedProcess(
                cmd,
                0,
                stdout=json.dumps(
                    {
                        "metadata": {"id": "instance-1", "name": "clean"},
                        "status": {
                            "network_interfaces": [
                                {"public_ip_address": {"address": "1.2.3.4/32"}}
                            ]
                        },
                    }
                ),
                stderr="",
            )
        if cmd[0] == "ssh":
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        raise AssertionError(cmd)

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.chdir(tmp_path)

    report = launch_prepared_clean_run(
        prepared_report=tmp_path / "prepared.json",
        secret_env=secret,
        identity=tmp_path / "id_ed25519",
        ssh_timeout_seconds=1,
    )

    assert report["ok"] is True
    assert report["state"] == "launched"
    assert report["disk_id"] == "disk-1"
    assert report["instance_id"] == "instance-1"
    assert report["public_ip"] == "1.2.3.4"
    assert report["runtime_env_injected"] is True
    instance_request = json.loads((tmp_run / "instance-create.json").read_text())
    assert instance_request["spec"]["boot_disk"]["existing_disk"]["id"] == "disk-1"
    assert instance_request["spec"]["boot_disk"]["attach_mode"] == "READ_WRITE"
    assert instance_request["spec"]["recovery_policy"] == "FAIL"
    ssh_injections = [kwargs.get("input", "") for cmd, kwargs in calls if cmd[0] == "ssh"]
    assert any("NEBIUS_TRAINING_S3_URI=s3://bucket/robot-full-clean-test" in item for item in ssh_injections)
    assert any("AWS_SECRET_ACCESS_KEY=secret" in item for item in ssh_injections)
    status = json.loads(
        (tmp_path / "evidence" / "nebius_full_training" / "clean_launch_status.json").read_text()
    )
    assert status["redacted"] is True


def test_launch_prepared_clean_run_reports_missing_secret_key(tmp_path: Path) -> None:
    run_id = "robot-full-clean-test-missing"
    tmp_run = Path("/tmp") / run_id
    tmp_run.mkdir(parents=True, exist_ok=True)
    _write_json(
        tmp_path / "prepared.json",
        {
            "run_id": run_id,
            "prefix": "s3://bucket/run",
            "disk_create_request": str(tmp_run / "disk-create.json"),
        },
    )
    _write_json(tmp_run / "disk-create.json", {"disk": True})
    _write_json(
        tmp_run / "instance-create.template.json",
        {"spec": {"boot_disk": {"existing_disk": {"id": "<disk-id>"}}}},
    )
    secret = tmp_path / "secret.env"
    secret.write_text("ACCESS_KEY_ID=key\n", encoding="utf-8")

    try:
        launch_prepared_clean_run(
            prepared_report=tmp_path / "prepared.json",
            secret_env=secret,
            identity=tmp_path / "id_ed25519",
            nebius_bin="true",
        )
    except RuntimeError as exc:
        assert "missing secret env keys" in str(exc)
    else:
        raise AssertionError("expected missing secret env keys to raise")


def test_launch_prepared_clean_run_stops_before_disk_create_when_auth_required(
    monkeypatch,
    tmp_path: Path,
) -> None:
    run_id = "robot-full-clean-test-auth"
    tmp_run = Path("/tmp") / run_id
    tmp_run.mkdir(parents=True, exist_ok=True)
    _write_json(
        tmp_path / "prepared.json",
        {
            "run_id": run_id,
            "prefix": "s3://bucket/run",
            "payload_uri": "s3://bucket/run/payload.tar.gz",
            "disk_create_request": str(tmp_run / "disk-create.json"),
        },
    )
    _write_json(tmp_run / "disk-create.json", {"disk": True})
    _write_json(
        tmp_run / "instance-create.template.json",
        {"spec": {"boot_disk": {"existing_disk": {"id": "<disk-id>"}}}},
    )
    secret = tmp_path / "secret.env"
    secret.write_text(
        "ACCESS_KEY_ID=key\nSECRET_ACCESS_KEY=secret\n",
        encoding="utf-8",
    )
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        if cmd[:5] == ["nebius", "--no-browser", "--auth-timeout", "3s", "iam"]:
            return subprocess.CompletedProcess(
                cmd,
                1,
                stdout="Switch to your browser to authenticate\n",
                stderr="https://auth.nebius.com/oauth2/authorize?...",
            )
        raise AssertionError(cmd)

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.chdir(tmp_path)

    report = launch_prepared_clean_run(
        prepared_report=tmp_path / "prepared.json",
        secret_env=secret,
        identity=tmp_path / "id_ed25519",
        auth_timeout_seconds=3,
    )

    assert report["ok"] is False
    assert report["state"] == "awaiting_nebius_cli_auth"
    assert report["disk_id"] is None
    assert report["instance_id"] is None
    assert report["nebius_auth"]["reason"] == "nebius_cli_auth_required"
    assert report["nebius_auth"]["auth_prompt_detected"] is True
    assert not any(cmd[:4] == ["nebius", "compute", "disk", "create"] for cmd, _ in calls)
    status = json.loads(
        (tmp_path / "evidence" / "nebius_full_training" / "clean_launch_status.json").read_text()
    )
    assert status["state"] == "awaiting_nebius_cli_auth"
