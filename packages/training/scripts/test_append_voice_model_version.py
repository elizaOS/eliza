"""Tests for `append_voice_model_version.py`.

Covers:
 - Validates `--id` against the known voice model set.
 - Asset parsing rejects bad shape / bad sha256 / bad quant.
 - Idempotent re-run (no double-write) when the entry already exists.
 - `--append-changelog` inserts an H3 under the matching H2.
 - `--dry-run` writes nothing to disk.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from textwrap import dedent


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = (
    REPO_ROOT / "packages" / "training" / "scripts" / "append_voice_model_version.py"
)

VOICE_MODELS_TS_TEMPLATE = json.dumps([{
    "id": "kokoro", "version": "0.1.0", "ggufAssets": [],
    "hfRepo": "elizaos/eliza-1", "hfRevision": "main",
}])

CHANGELOG_MD_TEMPLATE = dedent(
    """\
    # Eliza voice sub-models — changelog

    ## kokoro

    ### 0.1.0 — 2026-05-14

    - Initial release.
    """
)


def _setup_workspace(tmp_path: Path) -> tuple[Path, Path]:
    ts_path = tmp_path / "voice-model-versions.json"
    md_path = tmp_path / "CHANGELOG.md"
    ts_path.write_text(VOICE_MODELS_TS_TEMPLATE, encoding="utf-8")
    md_path.write_text(CHANGELOG_MD_TEMPLATE, encoding="utf-8")
    return ts_path, md_path


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        check=False,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )


def test_unknown_id_rejected(tmp_path: Path) -> None:
    ts_path, _ = _setup_workspace(tmp_path)
    res = _run(
        "--id",
        "not-a-real-id",
        "--version",
        "0.2.0",
        "--hf-repo",
        "elizaos/foo",
        "--hf-revision",
        "main",
        "--min-bundle",
        "0.0.0",
        "--changelog-entry",
        "hi",
        "--registry",
        str(ts_path),
    )
    assert res.returncode != 0
    assert "invalid choice" in res.stderr or "not-a-real-id" in res.stderr


def test_invalid_semver_rejected(tmp_path: Path) -> None:
    ts_path, _ = _setup_workspace(tmp_path)
    res = _run(
        "--id",
        "kokoro",
        "--version",
        "bogus",
        "--hf-repo",
        "elizaos/eliza-1-voice-kokoro-same",
        "--hf-revision",
        "main",
        "--min-bundle",
        "0.0.0",
        "--changelog-entry",
        "hi",
        "--registry",
        str(ts_path),
    )
    assert res.returncode == 2


def test_bad_asset_rejected(tmp_path: Path) -> None:
    ts_path, _ = _setup_workspace(tmp_path)
    res = _run(
        "--id",
        "kokoro",
        "--version",
        "0.2.0",
        "--hf-repo",
        "elizaos/eliza-1-voice-kokoro-same",
        "--hf-revision",
        "main",
        "--asset",
        "kokoro.onnx:not-a-sha:1024:onnx-fp16",
        "--min-bundle",
        "0.0.0",
        "--changelog-entry",
        "hi",
        "--registry",
        str(ts_path),
    )
    assert res.returncode != 0


def test_writes_new_version_block(tmp_path: Path) -> None:
    ts_path, _ = _setup_workspace(tmp_path)
    res = _run(
        "--id",
        "kokoro",
        "--version",
        "0.2.0",
        "--parent-version",
        "0.1.0",
        "--hf-repo",
        "elizaos/eliza-1-voice-kokoro-same",
        "--hf-revision",
        "abc123def456abc123def456abc123def456abcd",
        "--asset",
        "kokoro.onnx:" + "a" * 64 + ":2048:onnx-fp16",
        "--min-bundle",
        "0.1.0",
        "--net-improvement",
        "true",
        "--rtf-delta",
        "-0.05",
        "--mos-delta",
        "0.12",
        "--changelog-entry",
        "sam clone v2 (lower RTF, higher MOS).",
        "--registry",
        str(ts_path),
    )
    assert res.returncode == 0, res.stderr
    versions = json.loads(ts_path.read_text(encoding="utf-8"))
    assert [row["version"] for row in versions] == ["0.2.0", "0.1.0"]
    newest = versions[0]
    assert newest["id"] == "kokoro"
    assert newest["parentVersion"] == "0.1.0"
    assert newest["ggufAssets"] == [{"filename": "kokoro.onnx", "sha256": "a" * 64, "sizeBytes": 2048, "quant": "onnx-fp16"}]
    assert newest["evalDeltas"] == {"rtfDelta": -0.05, "mosDelta": 0.12, "netImprovement": True}


def test_idempotent_rerun(tmp_path: Path) -> None:
    ts_path, _ = _setup_workspace(tmp_path)
    common = [
        "--id",
        "kokoro",
        "--version",
        "0.2.0",
        "--parent-version",
        "0.1.0",
        "--hf-repo",
        "elizaos/eliza-1-voice-kokoro-same",
        "--hf-revision",
        "main",
        "--asset",
        "kokoro.onnx:" + "a" * 64 + ":2048:onnx-fp16",
        "--min-bundle",
        "0.1.0",
        "--net-improvement",
        "true",
        "--changelog-entry",
        "sam v2.",
        "--registry",
        str(ts_path),
    ]
    res1 = _run(*common)
    assert res1.returncode == 0, res1.stderr
    contents1 = ts_path.read_text(encoding="utf-8")
    res2 = _run(*common)
    assert res2.returncode == 0, res2.stderr
    contents2 = ts_path.read_text(encoding="utf-8")
    # Second run leaves the file unchanged.
    assert contents1 == contents2
    # The version literal appears exactly once.
    assert sum(row["version"] == "0.2.0" for row in json.loads(contents2)) == 1


def test_append_changelog_inserts_h3(tmp_path: Path) -> None:
    ts_path, md_path = _setup_workspace(tmp_path)
    res = _run(
        "--id",
        "kokoro",
        "--version",
        "0.2.0",
        "--parent-version",
        "0.1.0",
        "--hf-repo",
        "elizaos/eliza-1-voice-kokoro-same",
        "--hf-revision",
        "abc",
        "--asset",
        "kokoro.onnx:" + "b" * 64 + ":1024:onnx-fp16",
        "--min-bundle",
        "0.1.0",
        "--net-improvement",
        "true",
        "--changelog-entry",
        "sam v2 with lower RTF.",
        "--registry",
        str(ts_path),
        "--changelog-md",
        str(md_path),
        "--append-changelog",
    )
    assert res.returncode == 0, res.stderr
    md_contents = md_path.read_text(encoding="utf-8")
    assert "### 0.2.0 — " in md_contents
    assert "sam v2 with lower RTF." in md_contents
    # H2 ordering preserved.
    assert md_contents.index("## kokoro") < md_contents.index("### 0.2.0")
    # Reverse chrono: new H3 above the old one.
    assert md_contents.index("### 0.2.0") < md_contents.index("### 0.1.0")


def test_dry_run_writes_nothing(tmp_path: Path) -> None:
    ts_path, md_path = _setup_workspace(tmp_path)
    ts_before = ts_path.read_text(encoding="utf-8")
    md_before = md_path.read_text(encoding="utf-8")
    res = _run(
        "--id",
        "kokoro",
        "--version",
        "0.2.0",
        "--parent-version",
        "0.1.0",
        "--hf-repo",
        "elizaos/eliza-1-voice-kokoro-same",
        "--hf-revision",
        "main",
        "--asset",
        "kokoro.onnx:" + "c" * 64 + ":1024:onnx-fp16",
        "--min-bundle",
        "0.1.0",
        "--net-improvement",
        "true",
        "--changelog-entry",
        "sam v2.",
        "--registry",
        str(ts_path),
        "--changelog-md",
        str(md_path),
        "--append-changelog",
        "--dry-run",
    )
    assert res.returncode == 0, res.stderr
    assert ts_path.read_text(encoding="utf-8") == ts_before
    assert md_path.read_text(encoding="utf-8") == md_before


def test_successor_requires_net_improvement(tmp_path: Path) -> None:
    ts_path, _ = _setup_workspace(tmp_path)
    res = _run(
        "--id",
        "kokoro",
        "--version",
        "0.2.0",
        "--parent-version",
        "0.1.0",
        "--hf-repo",
        "elizaos/eliza-1-voice-kokoro-same",
        "--hf-revision",
        "main",
        "--min-bundle",
        "0.1.0",
        "--changelog-entry",
        "sam v2.",
        "--registry",
        str(ts_path),
    )
    assert res.returncode == 2
    assert "--net-improvement is required" in res.stderr
