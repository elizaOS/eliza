"""Tests for local security-gym oracle experience export."""

from __future__ import annotations

import json
from pathlib import Path
from types import ModuleType
from typing import Any

from conftest import load_script

REPO_ROOT = Path(__file__).resolve().parents[1]
_EXPORT_PATH = REPO_ROOT / "benchmarks" / "security_gym_oracle_experience_export.py"


def load_export_module() -> ModuleType:
    return load_script(_EXPORT_PATH, "oracle_export")


def test_export_oracle_experience_writes_jsonl_and_manifest(
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    module = load_export_module()

    def fake_run_benchmark(
        _security_gym_root: Path,
        _max_steps: int,
        *,
        include_rollout_records: bool,
    ) -> dict[str, Any]:
        assert include_rollout_records is True
        return {
            "schema": "alberta.security_gym.counterfactual_rollout.v1",
            "passed": True,
            "feature_schema": {
                "version": "security-gym-v1",
                "dtype": "float32",
                "names": ["x0", "x1"],
                "feature_dim": 2,
            },
            "rollout_records": {
                "oracle_block_malicious": [
                    {
                        "state": [0.0, 1.0],
                        "action": 3,
                        "reward": 1.0,
                        "next_state": [0.5, 1.0],
                        "terminated": False,
                        "truncated": False,
                        "policy_metadata": {
                            "is_malicious": True,
                            "src_ip": "192.168.1.50",
                        },
                    }
                    for _ in range(20)
                ]
            },
        }

    monkeypatch.setattr(module, "run_benchmark", fake_run_benchmark)
    records_path = tmp_path / "records.jsonl"
    manifest_path = tmp_path / "manifest.json"

    manifest = module.export_oracle_experience(
        security_gym_root=tmp_path,
        max_steps=20,
        output=records_path,
        manifest_output=manifest_path,
    )

    assert manifest["passed"] is True
    assert manifest["n_records"] == 20
    assert manifest["outcome_counts"] == {"true_positive": 20}
    rows = [
        json.loads(line)
        for line in records_path.read_text(encoding="utf-8").splitlines()
    ]
    assert rows[0]["schema"] == "alberta.security_gym.oracle_experience.v1"
    assert set(rows[0]) >= {"state", "action", "reward", "outcome"}
    assert json.loads(manifest_path.read_text(encoding="utf-8")) == manifest
