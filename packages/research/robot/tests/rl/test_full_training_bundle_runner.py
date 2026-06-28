from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.run_end_to_end_full_training_bundle import run_bundle


def _write_stage(bundle: Path, name: str, body: str) -> str:
    scripts = bundle / "scripts"
    scripts.mkdir(parents=True, exist_ok=True)
    path = scripts / name
    path.write_text("#!/usr/bin/env bash\nset -euo pipefail\n" + body, encoding="utf-8")
    path.chmod(0o755)
    return f"scripts/{name}"


def test_run_full_training_bundle_writes_logs_and_success(tmp_path: Path) -> None:
    bundle = tmp_path / "bundle"
    package_root = tmp_path / "pkg"
    package_root.mkdir()
    stage = _write_stage(bundle, "00_local_preflight.sh", "echo ready\n")

    report = run_bundle(
        bundle_dir=bundle,
        package_root=package_root,
        stages=(stage,),
        heartbeat_seconds=0.01,
    )

    assert report["ok"] is True
    assert report["state"] == "complete"
    assert (package_root / "status" / "success.txt").is_file()
    log = (package_root / "logs" / "00_local_preflight.log").read_text(encoding="utf-8")
    assert "START 00_local_preflight" in log
    assert "ready" in log
    assert "END 00_local_preflight rc=0" in log
    status = json.loads(
        (package_root / "status" / "00_local_preflight.json").read_text(encoding="utf-8")
    )
    assert status["state"] == "complete"
    assert status["returncode"] == 0


def test_run_full_training_bundle_stops_on_failed_stage(tmp_path: Path) -> None:
    bundle = tmp_path / "bundle"
    package_root = tmp_path / "pkg"
    package_root.mkdir()
    first = _write_stage(bundle, "00_local_preflight.sh", "echo before\nexit 5\n")
    second = _write_stage(bundle, "10_nebius_train_alberta.sh", "echo after\n")

    report = run_bundle(
        bundle_dir=bundle,
        package_root=package_root,
        stages=(first, second),
        heartbeat_seconds=0.01,
    )

    assert report["ok"] is False
    assert report["state"] == "failed"
    assert report["last_stage"] == "00_local_preflight"
    assert (package_root / "status" / "failure.txt").is_file()
    assert not (package_root / "logs" / "10_nebius_train_alberta.log").exists()


def test_run_full_training_bundle_upload_uses_nebius_endpoint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bundle = tmp_path / "bundle"
    package_root = tmp_path / "pkg"
    package_root.mkdir()
    stage = _write_stage(bundle, "00_local_preflight.sh", "echo upload\n")
    aws_log = tmp_path / "aws-args.jsonl"
    fake_aws = tmp_path / "aws"
    fake_aws.write_text(
        "#!/usr/bin/env bash\n"
        "python - \"$@\" <<'PY'\n"
        "import json, os, sys\n"
        "with open(os.environ['AWS_ARG_LOG'], 'a', encoding='utf-8') as f:\n"
        "    f.write(json.dumps(sys.argv[1:]) + '\\n')\n"
        "PY\n",
        encoding="utf-8",
    )
    fake_aws.chmod(0o755)
    monkeypatch.setenv("AWS_ARG_LOG", str(aws_log))

    report = run_bundle(
        bundle_dir=bundle,
        package_root=package_root,
        stages=(stage,),
        upload_uri="s3://robot-test/run-1",
        aws_bin=str(fake_aws),
        endpoint="https://storage.eu-north1.nebius.cloud",
        heartbeat_seconds=60,
    )

    assert report["ok"] is True
    assert report["upload_ok"] is True
    assert report["final_status_upload_ok"] is True
    calls = [json.loads(line) for line in aws_log.read_text(encoding="utf-8").splitlines()]
    assert calls
    assert all(call[:2] == ["--endpoint-url", "https://storage.eu-north1.nebius.cloud"] for call in calls)
    assert any(call[-1] == "s3://robot-test/run-1/status" for call in calls)
