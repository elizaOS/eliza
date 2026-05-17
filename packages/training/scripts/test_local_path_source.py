"""Tests for `scripts/lib/local_path_source.py` and the nightly-export bridge.

Exercises the `source: { type: local_path }` resolver, the
`stage_local_path_source` symlink step, and the `eliza_native_passthrough`
adapter end-to-end against a synthetic export tree.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from lib.adapters import REGISTRY  # noqa: E402
from lib.expected_response import make_expected_response_encoder  # noqa: E402
from lib.local_path_source import LocalPathSource, expand_env  # noqa: E402


# ---------------------------------------------------------------------------
# expand_env
# ---------------------------------------------------------------------------


def test_expand_env_uses_default_when_var_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MILADY_TEST_ROOT", raising=False)
    assert expand_env("${MILADY_TEST_ROOT:-/tmp/default}") == "/tmp/default"


def test_expand_env_uses_env_when_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MILADY_TEST_ROOT", "/var/data/eliza")
    assert (
        expand_env("${MILADY_TEST_ROOT:-/tmp/default}/training/datasets")
        == "/var/data/eliza/training/datasets"
    )


def test_expand_env_handles_no_var() -> None:
    assert expand_env("/already/absolute/path") == "/already/absolute/path"


def test_expand_env_expands_tilde() -> None:
    expanded = expand_env("~/example")
    assert expanded.startswith(os.path.expanduser("~"))


# ---------------------------------------------------------------------------
# LocalPathSource.from_entry
# ---------------------------------------------------------------------------


def test_from_entry_returns_none_when_not_local_path() -> None:
    assert LocalPathSource.from_entry({"slug": "x", "repo_id": "foo/bar"}) is None
    assert (
        LocalPathSource.from_entry(
            {"slug": "x", "source": {"type": "hf_repo", "repo_id": "foo/bar"}}
        )
        is None
    )


def test_from_entry_requires_root_and_glob() -> None:
    with pytest.raises(ValueError):
        LocalPathSource.from_entry({"slug": "x", "source": {"type": "local_path"}})
    with pytest.raises(ValueError):
        LocalPathSource.from_entry(
            {"slug": "x", "source": {"type": "local_path", "root": "/tmp"}}
        )


def test_from_entry_parses_full_block(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MILADY_TEST_ROOT", "/tmp/eliza-state")
    parsed = LocalPathSource.from_entry(
        {
            "slug": "eliza-nightly-action-planner",
            "source": {
                "type": "local_path",
                "root": "${MILADY_TEST_ROOT:-~/.eliza}/training/datasets",
                "glob": "*/action_planner_trajectories.jsonl",
                "task": "action_planner",
            },
        }
    )
    assert parsed is not None
    assert parsed.root == Path("/tmp/eliza-state/training/datasets")
    assert parsed.glob == "*/action_planner_trajectories.jsonl"
    assert parsed.task == "action_planner"


# ---------------------------------------------------------------------------
# resolve_files
# ---------------------------------------------------------------------------


def test_resolve_files_returns_empty_when_root_missing(tmp_path: Path) -> None:
    parsed = LocalPathSource(
        root=tmp_path / "does" / "not" / "exist",
        glob="*/file.jsonl",
        task=None,
    )
    assert parsed.resolve_files() == []


def test_resolve_files_globs_dated_subdirs(tmp_path: Path) -> None:
    (tmp_path / "2026-05-11").mkdir()
    (tmp_path / "2026-05-12").mkdir()
    (tmp_path / "2026-05-11" / "action_planner_trajectories.jsonl").write_text("")
    (tmp_path / "2026-05-12" / "action_planner_trajectories.jsonl").write_text("")
    (tmp_path / "2026-05-11" / "should_respond_trajectories.jsonl").write_text("")

    parsed = LocalPathSource(
        root=tmp_path,
        glob="*/action_planner_trajectories.jsonl",
        task="action_planner",
    )
    files = parsed.resolve_files()
    assert len(files) == 2
    assert all(p.name == "action_planner_trajectories.jsonl" for p in files)


# ---------------------------------------------------------------------------
# stage_local_path_source (download_datasets.py)
# ---------------------------------------------------------------------------


def test_stage_local_path_source_symlinks_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import download_datasets

    export_root = tmp_path / "export"
    raw_root = tmp_path / "raw"
    (export_root / "2026-05-11").mkdir(parents=True)
    src = export_root / "2026-05-11" / "action_planner_trajectories.jsonl"
    src.write_text("{}\n")

    monkeypatch.setattr(download_datasets, "RAW_DIR", raw_root)
    monkeypatch.setenv("MILADY_TEST_ROOT", str(export_root))

    entry = {
        "slug": "eliza-nightly-action-planner",
        "source": {
            "type": "local_path",
            "root": "${MILADY_TEST_ROOT}",
            "glob": "*/action_planner_trajectories.jsonl",
            "task": "action_planner",
        },
    }
    slug, status, _size = download_datasets.stage_local_path_source(entry)
    assert (slug, status) == ("eliza-nightly-action-planner", "ok")
    staged = raw_root / "eliza-nightly-action-planner" / "2026-05-11__action_planner_trajectories.jsonl"
    assert staged.is_symlink()
    assert staged.resolve() == src.resolve()
    assert (raw_root / "eliza-nightly-action-planner" / ".done").is_file()


def test_stage_local_path_source_empty_export_is_noop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import download_datasets

    raw_root = tmp_path / "raw"
    empty_root = tmp_path / "does-not-exist"
    monkeypatch.setattr(download_datasets, "RAW_DIR", raw_root)

    entry = {
        "slug": "eliza-nightly-action-planner",
        "source": {
            "type": "local_path",
            "root": str(empty_root),
            "glob": "*/action_planner_trajectories.jsonl",
        },
    }
    slug, status, _size = download_datasets.stage_local_path_source(entry)
    assert (slug, status) == ("eliza-nightly-action-planner", "ok")
    assert (raw_root / "eliza-nightly-action-planner" / ".done").is_file()


# ---------------------------------------------------------------------------
# eliza_native_passthrough adapter (lib.adapters)
# ---------------------------------------------------------------------------


def _native_row(*, task_type: str = "action_planner") -> dict:
    return {
        "format": "eliza_native_v1",
        "schemaVersion": 1,
        "boundary": "vercel_ai_sdk.generateText",
        "request": {
            "messages": [
                {"role": "system", "content": "you are eliza"},
                {"role": "user", "content": "hello"},
            ],
            "settings": {"temperature": 0.0, "topP": 1.0},
        },
        "response": {
            "text": '{"thought":"reply","toolCalls":[]}',
            "finishReason": "stop",
        },
        "metadata": {
            "task_type": task_type,
            "trajectory_id": "traj-1",
            "call_id": "call-1",
            "agent_id": "agent-7",
        },
    }


def test_eliza_native_passthrough_emits_valid_records() -> None:
    adapter = REGISTRY["eliza_native_passthrough"]
    encoder = make_expected_response_encoder("json")
    try:
        rows = [_native_row()]
        out = list(
            adapter(
                rows,
                slug="eliza-nightly-action-planner",
                license="proprietary",
                split="train",
                encoder=encoder,
            )
        )
        assert len(out) == 1
        rec = out[0]
        ok, _ = rec.is_valid()
        assert ok, rec.to_dict()
        md = rec.metadata
        assert md["task_type"] == "action_planner"
        assert md["source_dataset"] == "eliza-nightly-action-planner"
        assert md["trajectory_id"] == "traj-1"
        assert md["call_id"] == "call-1"
        assert rec.currentMessage["content"] == "hello"
        # System turns surface in metadata, not as a memory entry.
        assert "you are eliza" in md["system_prompt"]
        assert rec.expectedResponse.startswith("{")
    finally:
        encoder.close()


def test_eliza_native_passthrough_skips_malformed_rows() -> None:
    adapter = REGISTRY["eliza_native_passthrough"]
    encoder = make_expected_response_encoder("json")
    try:
        rows = [{"not": "a native row"}]
        out = list(
            adapter(
                rows,
                slug="x",
                license="proprietary",
                split="train",
                encoder=encoder,
            )
        )
        # Malformed rows emit an ElizaRecord that fails is_valid() — the
        # normalize.py harness routes those to errors.jsonl. The shape
        # under test is just that no exception is raised and the failure
        # is observable via is_valid().
        assert len(out) == 1
        ok, _ = out[0].is_valid()
        assert not ok
    finally:
        encoder.close()


def test_eliza_native_passthrough_carries_task_from_metadata() -> None:
    adapter = REGISTRY["eliza_native_passthrough"]
    encoder = make_expected_response_encoder("json")
    try:
        rows = [_native_row(task_type="should_respond")]
        out = list(
            adapter(
                rows,
                slug="eliza-nightly-should-respond",
                license="proprietary",
                split="train",
                encoder=encoder,
            )
        )
        assert out[0].metadata["task_type"] == "should_respond"
    finally:
        encoder.close()


# ---------------------------------------------------------------------------
# Manual end-to-end: drop a JSONL, stage, normalize.
# ---------------------------------------------------------------------------


def test_end_to_end_stage_then_normalize(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import download_datasets
    import normalize

    export_root = tmp_path / "export"
    raw_root = tmp_path / "raw"
    normalized_root = tmp_path / "normalized"
    (export_root / "2026-05-11").mkdir(parents=True)
    src = export_root / "2026-05-11" / "action_planner_trajectories.jsonl"
    src.write_text(json.dumps(_native_row()) + "\n")

    monkeypatch.setattr(download_datasets, "RAW_DIR", raw_root)
    monkeypatch.setattr(normalize, "RAW_DIR", raw_root)
    monkeypatch.setattr(normalize, "OUT_DIR", normalized_root)
    monkeypatch.setenv("MILADY_TEST_ROOT", str(export_root))

    entry = {
        "slug": "eliza-nightly-action-planner",
        "source": {
            "type": "local_path",
            "root": "${MILADY_TEST_ROOT}",
            "glob": "*/action_planner_trajectories.jsonl",
            "task": "action_planner",
        },
        "normalizer": "eliza_native_passthrough",
        "license": "proprietary",
        "weight": 1.0,
    }
    download_datasets.stage_local_path_source(entry)

    encoder = make_expected_response_encoder("json")
    try:
        n_in, n_out, n_err = normalize.normalize_dataset(
            entry, max_records=None, encoder=encoder
        )
    finally:
        encoder.close()
    assert (n_in, n_out, n_err) == (1, 1, 0)
    out_jsonl = normalized_root / "eliza-nightly-action-planner.jsonl"
    assert out_jsonl.is_file()
    lines = out_jsonl.read_text().splitlines()
    assert len(lines) == 1
    rec = json.loads(lines[0])
    assert rec["metadata"]["task_type"] == "action_planner"
    assert rec["metadata"]["source_dataset"] == "eliza-nightly-action-planner"
