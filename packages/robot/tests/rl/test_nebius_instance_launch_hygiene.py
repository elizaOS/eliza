from __future__ import annotations

import json
from pathlib import Path

from scripts.validate_nebius_instance_launch_hygiene import validate_instance_launch_hygiene


def _write_instance(tmp_path: Path, cloud_init: str) -> Path:
    path = tmp_path / "instance.json"
    path.write_text(
        json.dumps(
            {
                "metadata": {"id": "computeinstance-test", "name": "robot-test"},
                "spec": {"cloud_init_user_data": cloud_init},
            }
        ),
        encoding="utf-8",
    )
    return path


def test_launch_hygiene_accepts_runner_without_inline_credentials(tmp_path: Path) -> None:
    report = validate_instance_launch_hygiene(
        _write_instance(
            tmp_path,
            "\n".join(
                [
                    "export NEBIUS_S3_ENDPOINT=https://storage.eu-north1.nebius.cloud",
                    "export NEBIUS_TRAINING_S3_URI=s3://bucket/run",
                    "evidence/full_training_preflight/scripts/run_all_nebius_stages.sh",
                    "echo runner_status.json",
                    "shutdown -h +720",
                ]
            ),
        )
    )

    assert report["ok"] is True
    assert report["secret_fields_embedded"] == []


def test_launch_hygiene_rejects_inline_credentials_and_old_stage_wrapper(
    tmp_path: Path,
) -> None:
    report = validate_instance_launch_hygiene(
        _write_instance(
            tmp_path,
            "\n".join(
                [
                    "export AWS_ACCESS_KEY_ID='redacted'",
                    "export AWS_SECRET_ACCESS_KEY='redacted'",
                    "run_stage 10_nebius_train_alberta scripts/10_nebius_train_alberta.sh",
                    "export NEBIUS_S3_ENDPOINT=https://storage.eu-north1.nebius.cloud",
                    "shutdown -h +720",
                ]
            ),
        )
    )

    assert report["ok"] is False
    assert report["checks"]["no_inline_object_storage_credentials"] is False
    assert report["checks"]["uses_repo_owned_stage_runner"] is False
    assert report["checks"]["has_status_heartbeat_upload_contract"] is False
    assert "aws_secret_access_key" in report["secret_fields_embedded"]
    assert report["recommendations"]
