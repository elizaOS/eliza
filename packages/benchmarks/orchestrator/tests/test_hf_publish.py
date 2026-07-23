"""Pytest suite for the benchmark-results HuggingFace publisher (hf_publish.py).

Mocks ``huggingface_hub.HfApi`` ONLY. Everything else is real: a tmp workspace
holding a real SQLite database built through the db.py API, a real nested git
repository driven through subprocess git, and the real readiness/artifact-guard
validators (runtime gates are host probes and are switched off explicitly).

Run::

    cd packages && python3 -m pytest benchmarks/orchestrator/tests/test_hf_publish.py -q
"""

from __future__ import annotations

import fnmatch
import json
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from benchmarks.orchestrator.db import (
    connect_database,
    create_run_group,
    initialize_database,
    insert_run_start,
    replace_run_trajectories,
    update_run_result,
)
from benchmarks.orchestrator.hf_publish import (
    HF_UPLOAD_IGNORE_PATTERNS,
    MANIFEST_RELPATH,
    PublishRefusedError,
    _is_ignored,
    auto_commit_run_groups,
    publish_to_hf,
)

RUN_GROUP_ID = "rg_20260701T000000Z_deadbeef"
RUN_ID = "run_bfcl_20260701T000100Z_1_cafe0001"
FAKE_TOKEN = "hf_faketoken1234567890abcdef"


def _git(cwd: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(cwd), *args],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout


def _init_repo(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["git", "init", "-q", "-b", "main", str(path)],
        capture_output=True,
        text=True,
        check=True,
    )
    _git(path, "config", "user.email", "bench@test.invalid")
    _git(path, "config", "user.name", "Bench Publisher Test")
    _git(path, "config", "commit.gpgsign", "false")


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")


def _latest_row(output_root: Path, benchmark_id: str, agent: str) -> dict:
    result_json = (
        output_root
        / RUN_GROUP_ID
        / f"{benchmark_id}__{benchmark_id}"
        / RUN_ID
        / "output"
        / "report.json"
    )
    return {
        "benchmark_id": benchmark_id,
        "benchmark_directory": benchmark_id,
        "agent": agent,
        "provider": "cerebras",
        "model": "gemma-4-31b",
        "extra_config": {},
        "status": "succeeded",
        "score": 1.0,
        "result_json_path": str(result_json),
        "artifacts": [str(result_json)],
    }


def _complete_contract(benchmark_id: str) -> dict:
    cells = {
        agent: {
            "required": True,
            "state": "succeeded",
            "status": "succeeded",
            "score": 1.0,
        }
        for agent in ("eliza", "hermes", "openclaw")
    }
    return {
        "matrix_contract": {
            "status": "complete",
            "summary": {
                "unsupported_real_cells": 0,
                "missing_required_real_cells": 0,
                "failed_required_real_cells": 0,
                "no_required_real_harness_benchmarks": 0,
            },
            "benchmarks": {benchmark_id: {"complete": True, "cells": cells}},
        }
    }


def _build_workspace(tmp_path: Path, *, gates_pass: bool = True) -> tuple[Path, Path]:
    """Real workspace: monorepo git repo, nested results repo, real SQLite DB."""
    repo_root = tmp_path / "monorepo"
    _init_repo(repo_root)
    (repo_root / "seed.txt").write_text("seed\n", encoding="utf-8")
    _git(repo_root, "add", "-A")
    _git(repo_root, "commit", "-q", "-m", "seed")

    workspace_root = repo_root / "packages"
    output_root = workspace_root / "benchmarks" / "benchmark_results"
    _init_repo(output_root)
    (output_root / ".gitignore").write_text(
        "orchestrator.sqlite\n*.sqlite-wal\n*.sqlite-shm\n.locks/\n*.lock\ntmp/\n",
        encoding="utf-8",
    )
    _git(output_root, "add", "-A")
    _git(output_root, "commit", "-q", "-m", "baseline")

    run_dir = output_root / RUN_GROUP_ID / "bfcl__bfcl" / RUN_ID
    (run_dir / "output").mkdir(parents=True)
    result_json = run_dir / "output" / "report.json"
    result_json.write_text('{"accuracy": 1.0}\n', encoding="utf-8")
    (run_dir / "stdout.log").write_text("run ok\n", encoding="utf-8")
    (run_dir / "stderr.log").write_text("", encoding="utf-8")

    conn = connect_database(output_root / "orchestrator.sqlite")
    initialize_database(conn)
    create_run_group(
        conn,
        run_group_id=RUN_GROUP_ID,
        created_at="2026-07-01T00:00:00+00:00",
        request={"benchmarks": ["bfcl"], "agent": "eliza"},
        benchmarks=["bfcl"],
        repo_meta={"eliza_commit": "0" * 40},
    )
    insert_run_start(
        conn,
        run_id=RUN_ID,
        run_group_id=RUN_GROUP_ID,
        benchmark_id="bfcl",
        benchmark_directory="bfcl",
        signature="sig-bfcl-eliza",
        attempt=1,
        agent="eliza",
        provider="cerebras",
        model="gemma-4-31b",
        extra_config={},
        started_at="2026-07-01T00:01:00+00:00",
        command=["python", "run.py"],
        cwd=str(workspace_root / "benchmarks" / "bfcl"),
        stdout_path=str(run_dir / "stdout.log"),
        stderr_path=str(run_dir / "stderr.log"),
        benchmark_version="1.0.0",
        benchmarks_commit="1" * 40,
        eliza_commit="0" * 40,
        eliza_version="1.0.0",
    )
    update_run_result(
        conn,
        run_id=RUN_ID,
        status="succeeded",
        ended_at="2026-07-01T00:02:00+00:00",
        duration_seconds=60.0,
        score=1.0,
        unit="accuracy",
        higher_is_better=True,
        metrics={"n": 5, "accuracy": 1.0},
        result_json_path=str(result_json),
        artifacts=[str(result_json)],
        error=None,
        high_score_label=None,
        high_score_value=None,
        delta_to_high_score=None,
        token_metrics={"llm_call_count": 2, "prompt_tokens": 100, "completion_tokens": 50},
    )
    replace_run_trajectories(
        conn,
        run_id=RUN_ID,
        trajectories=[
            {
                "trajectory_file": str(run_dir / "output" / "traj.jsonl"),
                "turn_index": 0,
                "prompt_tokens": 60,
                "completion_tokens": 30,
                "latency_ms": 800.0,
            },
            {
                "trajectory_file": str(run_dir / "output" / "traj.jsonl"),
                "turn_index": 1,
                "prompt_tokens": 40,
                "completion_tokens": 20,
                "latency_ms": 700.0,
            },
        ],
    )
    conn.close()

    latest = output_root / "latest"
    if gates_pass:
        _write_json(latest / "index.json", _complete_contract("bfcl"))
        for agent in ("eliza", "hermes", "openclaw"):
            _write_json(latest / f"bfcl__{agent}.json", _latest_row(output_root, "bfcl", agent))
    else:
        # No matrix_contract at all: readiness fails with missing_matrix_contract.
        _write_json(latest / "index.json", {"latest": {}})

    return workspace_root, output_root


def _publish(workspace_root: Path, **kwargs):
    kwargs.setdefault("repo_id", "elizaos/eliza-benchmark-results")
    kwargs.setdefault("check_runtime_gates", False)
    return publish_to_hf(workspace_root, **kwargs)


# ---------------------------------------------------------------------------
# Dry-run: exact would-publish set, no token needed, no network objects touched.
# ---------------------------------------------------------------------------


def test_dry_run_computes_upload_set_without_network(tmp_path, monkeypatch):
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.delenv("HUGGINGFACE_HUB_TOKEN", raising=False)
    workspace_root, output_root = _build_workspace(tmp_path)

    with patch("huggingface_hub.HfApi") as api_cls:
        report = _publish(workspace_root, dry_run=True)

    assert api_cls.call_count == 0
    assert report.gates_ok
    assert report.would_publish
    assert report.run_group_ids == (RUN_GROUP_ID,)
    assert report.nested_commit is None
    assert report.hf_result is None

    rels = {rel for rel, _ in report.upload_files}
    assert "exports/runs.jsonl" in rels
    assert "exports/run_groups.jsonl" in rels
    assert "exports/trajectory_turns.jsonl" in rels
    assert MANIFEST_RELPATH in rels
    assert report.db_snapshot in rels
    assert "latest/index.json" in rels
    assert f"{RUN_GROUP_ID}/bfcl__bfcl/{RUN_ID}/output/report.json" in rels

    # Exports are real projections of the real DB.
    runs_lines = (output_root / "exports" / "runs.jsonl").read_text().splitlines()
    assert len(runs_lines) == 1
    run_row = json.loads(runs_lines[0])
    assert run_row["run_id"] == RUN_ID
    assert run_row["eliza_commit"] == "0" * 40
    assert json.loads(run_row["metrics_json"]) == {"accuracy": 1.0, "n": 5}
    turn_lines = (output_root / "exports" / "trajectory_turns.jsonl").read_text().splitlines()
    assert len(turn_lines) == 2
    assert report.export_counts == {"runs": 1, "run_groups": 1, "trajectory_turns": 2}

    manifest = json.loads((output_root / MANIFEST_RELPATH).read_text())
    assert manifest["dry_run"] is True
    assert manifest["skip_gates"] is False
    assert manifest["gates"]["ok"] is True
    assert manifest["run_group_ids"] == [RUN_GROUP_ID]

    # Dry run must not create a nested commit.
    assert "baseline" in _git(output_root, "log", "-1", "--format=%s")


def test_dry_run_flags_failing_gates_as_would_refuse(tmp_path, monkeypatch):
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.delenv("HUGGINGFACE_HUB_TOKEN", raising=False)
    workspace_root, _ = _build_workspace(tmp_path, gates_pass=False)

    with patch("huggingface_hub.HfApi") as api_cls:
        report = _publish(workspace_root, dry_run=True)

    assert api_cls.call_count == 0
    assert not report.gates_ok
    assert not report.would_publish
    assert any("gates" in refusal for refusal in report.refusals)
    assert any("missing_matrix_contract" in line for line in report.gate_findings)


# ---------------------------------------------------------------------------
# Real publish path with HfApi mocked end-to-end.
# ---------------------------------------------------------------------------


def test_real_publish_commits_and_uploads_with_mocked_hub(tmp_path, monkeypatch):
    monkeypatch.setenv("HF_TOKEN", FAKE_TOKEN)
    workspace_root, output_root = _build_workspace(tmp_path)
    eliza_commit = _git(workspace_root.parent, "rev-parse", "HEAD").strip()

    fake_api = MagicMock()
    with patch("huggingface_hub.HfApi", return_value=fake_api) as api_cls:
        report = _publish(workspace_root, dry_run=False, private=True)

    assert api_cls.call_args.kwargs["token"] == FAKE_TOKEN
    create_call = fake_api.create_repo.call_args
    assert create_call.kwargs["repo_id"] == "elizaos/eliza-benchmark-results"
    assert create_call.kwargs["repo_type"] == "dataset"
    assert create_call.kwargs["private"] is True
    assert create_call.kwargs["exist_ok"] is True

    upload_call = fake_api.upload_folder.call_args
    assert upload_call.kwargs["repo_id"] == "elizaos/eliza-benchmark-results"
    assert upload_call.kwargs["repo_type"] == "dataset"
    assert upload_call.kwargs["folder_path"] == str(output_root)
    for pattern in HF_UPLOAD_IGNORE_PATTERNS:
        assert pattern in upload_call.kwargs["ignore_patterns"]

    # Commit-before-upload: the HF commit message carries the nested sha + rg ids.
    head = _git(output_root, "rev-parse", "HEAD").strip()
    assert report.nested_commit == head
    assert head in upload_call.kwargs["commit_message"]
    assert RUN_GROUP_ID in upload_call.kwargs["commit_message"]
    subject = _git(output_root, "log", "-1", "--format=%s")
    assert RUN_GROUP_ID in subject
    assert eliza_commit in subject
    assert report.eliza_commit == eliza_commit

    # The committed tree matches the working tree (audit log is complete).
    assert _git(output_root, "status", "--porcelain").strip() == ""


def test_public_flag_creates_public_repo(tmp_path, monkeypatch):
    monkeypatch.setenv("HF_TOKEN", FAKE_TOKEN)
    workspace_root, _ = _build_workspace(tmp_path)

    fake_api = MagicMock()
    with patch("huggingface_hub.HfApi", return_value=fake_api):
        _publish(workspace_root, dry_run=False, private=False)

    assert fake_api.create_repo.call_args.kwargs["private"] is False


# ---------------------------------------------------------------------------
# Fail-closed refusals: gates, token, secrets, missing nested repo.
# ---------------------------------------------------------------------------


def test_gate_refusal_blocks_publish(tmp_path, monkeypatch):
    monkeypatch.setenv("HF_TOKEN", FAKE_TOKEN)
    workspace_root, output_root = _build_workspace(tmp_path, gates_pass=False)
    head_before = _git(output_root, "rev-parse", "HEAD").strip()

    fake_api = MagicMock()
    with patch("huggingface_hub.HfApi", return_value=fake_api):
        with pytest.raises(PublishRefusedError) as excinfo:
            _publish(workspace_root, dry_run=False)

    assert "missing_matrix_contract" in str(excinfo.value)
    assert fake_api.create_repo.call_count == 0
    assert fake_api.upload_folder.call_count == 0
    # Refused publishes leave no audit commit behind.
    assert _git(output_root, "rev-parse", "HEAD").strip() == head_before


def test_skip_gates_publishes_and_records_bypass(tmp_path, monkeypatch):
    monkeypatch.setenv("HF_TOKEN", FAKE_TOKEN)
    workspace_root, output_root = _build_workspace(tmp_path, gates_pass=False)

    fake_api = MagicMock()
    with patch("huggingface_hub.HfApi", return_value=fake_api):
        report = _publish(workspace_root, dry_run=False, skip_gates=True)

    assert fake_api.upload_folder.call_count == 1
    assert not report.gates_ok
    assert report.skip_gates
    manifest = json.loads((output_root / MANIFEST_RELPATH).read_text())
    assert manifest["skip_gates"] is True
    assert manifest["gates"]["ok"] is False
    assert manifest["gates"]["readiness"]["findings"], "bypassed findings must be recorded"


def test_token_absent_fails_closed(tmp_path, monkeypatch):
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.delenv("HUGGINGFACE_HUB_TOKEN", raising=False)
    workspace_root, _ = _build_workspace(tmp_path)

    with patch("huggingface_hub.HfApi") as api_cls:
        with pytest.raises(PublishRefusedError) as excinfo:
            _publish(workspace_root, dry_run=False)

    assert "HF_TOKEN" in str(excinfo.value)
    assert api_cls.call_count == 0


def test_secret_scrub_refuses_upload(tmp_path, monkeypatch):
    monkeypatch.setenv("HF_TOKEN", FAKE_TOKEN)
    workspace_root, output_root = _build_workspace(tmp_path)
    leak = output_root / RUN_GROUP_ID / "bfcl__bfcl" / RUN_ID / "output" / "creds.txt"
    leak.write_text(
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEfake\n-----END RSA PRIVATE KEY-----\n",
        encoding="utf-8",
    )
    head_before = _git(output_root, "rev-parse", "HEAD").strip()

    fake_api = MagicMock()
    with patch("huggingface_hub.HfApi", return_value=fake_api):
        with pytest.raises(PublishRefusedError) as excinfo:
            _publish(workspace_root, dry_run=False)

    assert "creds.txt" in str(excinfo.value)
    assert "pem_private_key" in str(excinfo.value)
    # The secret itself is never echoed back.
    assert "MIIEfake" not in str(excinfo.value)
    assert fake_api.upload_folder.call_count == 0
    # Scrub runs before the audit commit so secrets never enter git history.
    assert _git(output_root, "rev-parse", "HEAD").strip() == head_before


def test_missing_nested_repo_refused(tmp_path, monkeypatch):
    monkeypatch.setenv("HF_TOKEN", FAKE_TOKEN)
    workspace_root, output_root = _build_workspace(tmp_path)
    subprocess.run(["rm", "-rf", str(output_root / ".git")], check=True)

    with pytest.raises(PublishRefusedError) as excinfo:
        _publish(workspace_root, dry_run=True)

    assert "git init" in str(excinfo.value)


# ---------------------------------------------------------------------------
# Ignore patterns and size cap.
# ---------------------------------------------------------------------------


def test_ignore_patterns_exclude_live_db_wal_and_locks(tmp_path, monkeypatch):
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.delenv("HUGGINGFACE_HUB_TOKEN", raising=False)
    workspace_root, output_root = _build_workspace(tmp_path)
    (output_root / "orchestrator.sqlite-wal").write_bytes(b"wal")
    (output_root / "orchestrator.sqlite-shm").write_bytes(b"shm")
    (output_root / ".locks").mkdir()
    (output_root / ".locks" / "campaign.lock").write_text("", encoding="utf-8")
    (output_root / "tmp").mkdir()
    (output_root / "tmp" / "scratch.txt").write_text("scratch", encoding="utf-8")
    # A nested git repo (e.g. a benchmark workspace checkout) inside a run dir.
    nested_git = output_root / RUN_GROUP_ID / "bfcl__bfcl" / RUN_ID / "workspace" / ".git"
    nested_git.mkdir(parents=True)
    (nested_git / "config").write_text("[core]\n", encoding="utf-8")

    with patch("huggingface_hub.HfApi"):
        report = _publish(workspace_root, dry_run=True)

    rels = {rel for rel, _ in report.upload_files}
    assert "orchestrator.sqlite" not in rels
    assert "orchestrator.sqlite-wal" not in rels
    assert "orchestrator.sqlite-shm" not in rels
    assert ".locks/campaign.lock" not in rels
    assert "tmp/scratch.txt" not in rels
    # The publication lock taken by publish-hf itself is excluded too.
    assert not any(rel.endswith(".lock") for rel in rels)
    assert not any(rel.startswith(".git/") for rel in rels)
    assert not any("/.git/" in rel for rel in rels)
    # The consistent snapshot IS published even though the live DB never is.
    assert report.db_snapshot in rels
    assert report.db_snapshot.startswith("db_snapshots/orchestrator-")


def test_nested_git_excluded_by_both_local_walker_and_hub_filter():
    """Exclusion parity for nested git metadata (PR #16954 review follow-up).

    The local walker's directory-pattern branch matches ".git/**" at any depth,
    but HfApi.upload_folder's filter_repo_objects fnmatches the full relative
    path only — so without the "**/.git/**" twin a nested repo's metadata would
    be uploaded while absent from the printed upload set and the secret scrub
    (the unsafe direction of a set mismatch).
    """
    excluded = ("runs/group-x/workspace/.git/config", ".git/config")
    kept = "runs/group-x/workspace/output/report.json"

    for rel in excluded:
        assert _is_ignored(rel, HF_UPLOAD_IGNORE_PATTERNS), rel
        # fnmatch simulation of huggingface_hub's filter_repo_objects.
        assert any(
            fnmatch.fnmatch(rel, pattern) for pattern in HF_UPLOAD_IGNORE_PATTERNS
        ), rel

    assert not _is_ignored(kept, HF_UPLOAD_IGNORE_PATTERNS)
    assert not any(fnmatch.fnmatch(kept, pattern) for pattern in HF_UPLOAD_IGNORE_PATTERNS)


def test_size_cap_skips_large_files_and_lists_them(tmp_path, monkeypatch):
    monkeypatch.setenv("HF_TOKEN", FAKE_TOKEN)
    workspace_root, output_root = _build_workspace(tmp_path)
    big = output_root / RUN_GROUP_ID / "bfcl__bfcl" / RUN_ID / "output" / "big_artifact.bin"
    big.write_bytes(b"\x00" * 200_000)
    big_rel = big.relative_to(output_root).as_posix()

    fake_api = MagicMock()
    with patch("huggingface_hub.HfApi", return_value=fake_api):
        report = _publish(workspace_root, dry_run=False, max_file_bytes=100_000)

    assert (big_rel, 200_000) in report.skipped_oversize
    assert big_rel not in {rel for rel, _ in report.upload_files}
    manifest = json.loads((output_root / MANIFEST_RELPATH).read_text())
    assert {"path": big_rel, "size_bytes": 200_000} in manifest["skipped_oversize"]
    # The oversized file is excluded from the actual upload as well.
    assert big_rel in fake_api.upload_folder.call_args.kwargs["ignore_patterns"]


# ---------------------------------------------------------------------------
# Path relativization.
# ---------------------------------------------------------------------------


def test_relativization_strips_absolute_paths_from_published_json(tmp_path, monkeypatch):
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.delenv("HUGGINGFACE_HUB_TOKEN", raising=False)
    workspace_root, output_root = _build_workspace(tmp_path)

    # Precondition: the runner-shaped inputs really do embed absolute paths.
    assert str(tmp_path) in (output_root / "latest" / "bfcl__eliza.json").read_text()

    with patch("huggingface_hub.HfApi"):
        _publish(workspace_root, dry_run=True)

    published_json = [
        *sorted((output_root / "latest").glob("*.json")),
        output_root / "exports" / "runs.jsonl",
        output_root / "exports" / "run_groups.jsonl",
        output_root / "exports" / "trajectory_turns.jsonl",
        output_root / MANIFEST_RELPATH,
    ]
    for path in published_json:
        content = path.read_text(encoding="utf-8")
        assert str(tmp_path) not in content, f"absolute path leaked into {path.name}"

    row = json.loads((output_root / "latest" / "bfcl__eliza.json").read_text())
    assert row["result_json_path"].startswith("./")
    exported = json.loads((output_root / "exports" / "runs.jsonl").read_text().splitlines()[0])
    assert exported["result_json_path"].startswith("./")
    assert exported["cwd"].startswith("<eliza-repo>/")


# ---------------------------------------------------------------------------
# Per-run-group auto-commit hook (local only).
# ---------------------------------------------------------------------------


def test_auto_commit_run_groups_is_local_only(tmp_path, monkeypatch):
    workspace_root, output_root = _build_workspace(tmp_path)
    (output_root / RUN_GROUP_ID / "note.txt").write_text("new artifact\n", encoding="utf-8")

    with patch("huggingface_hub.HfApi") as api_cls:
        sha = auto_commit_run_groups(
            output_root, [RUN_GROUP_ID], eliza_commit="a" * 40
        )

    assert api_cls.call_count == 0
    assert sha == _git(output_root, "rev-parse", "HEAD").strip()
    subject = _git(output_root, "log", "-1", "--format=%s")
    assert subject.startswith("run-group:")
    assert RUN_GROUP_ID in subject
    assert "a" * 40 in subject
    # Idempotent on a clean tree: no empty commit, same HEAD returned.
    again = auto_commit_run_groups(output_root, [RUN_GROUP_ID], eliza_commit="a" * 40)
    assert again == sha
