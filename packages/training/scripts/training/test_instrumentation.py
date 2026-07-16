"""CPU-only tests for the training environment / reproducibility manifest.

`log_environment` writes environment.json with the AGENTS.md §9 reproducibility
manifest: sha256 of every dataset file, the tokenizer artifact hash, the
base-checkpoint hash, and the training git commit. These tests use tmp files +
a mocked git call so they run anywhere headlessly.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from scripts.training import instrumentation
from scripts.training.instrumentation import _git_head, _hash_paths, log_environment


def _read_env(out_dir: Path) -> dict:
    return json.loads((out_dir / "environment.json").read_text())


def test_log_environment_hashes_dataset_files(tmp_path, monkeypatch):
    monkeypatch.setattr(
        instrumentation, "_git_head", lambda: {"available": True, "head": "deadbeef"}
    )
    train = tmp_path / "train.jsonl"
    val = tmp_path / "val.jsonl"
    train.write_bytes(b'{"a": 1}\n')
    val.write_bytes(b'{"b": 2}\n')

    out = tmp_path / "run"
    log_environment(out, dataset_files=[train, val])
    env = _read_env(out)

    repro = env["reproducibility"]
    expected_train = "sha256:" + hashlib.sha256(train.read_bytes()).hexdigest()
    expected_val = "sha256:" + hashlib.sha256(val.read_bytes()).hexdigest()
    assert repro["dataset_hashes"][str(train)] == expected_train
    assert repro["dataset_hashes"][str(val)] == expected_val


def test_log_environment_captures_git_head(tmp_path, monkeypatch):
    monkeypatch.setattr(
        instrumentation,
        "_git_head",
        lambda: {"available": True, "head": "abc123def456", "dirty": False},
    )
    out = tmp_path / "run"
    log_environment(out)
    env = _read_env(out)
    assert env["reproducibility"]["git"] == {
        "available": True,
        "head": "abc123def456",
        "dirty": False,
    }


def test_git_head_preserves_commit_when_dirty_probe_times_out(monkeypatch):
    calls = 0
    status_command = None

    def run(*args, **kwargs):
        nonlocal calls, status_command
        calls += 1
        if calls == 1:
            return subprocess.CompletedProcess(args[0], 0, stdout="abc123\n", stderr="")
        status_command = args[0]
        raise subprocess.TimeoutExpired(args[0], kwargs["timeout_seconds"])

    monkeypatch.setattr(instrumentation.shutil, "which", lambda _name: "/usr/bin/git")
    monkeypatch.setattr(instrumentation, "_run_git", run)

    assert _git_head() == {
        "available": True,
        "head": "abc123",
        "dirty": None,
        "dirty_reason": "git status timed out after 5 seconds",
    }
    assert status_command[:2] == ["git", "--no-optional-locks"]


def test_git_head_reports_unavailable_when_head_probe_times_out(monkeypatch):
    def run(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], kwargs["timeout_seconds"])

    monkeypatch.setattr(instrumentation.shutil, "which", lambda _name: "/usr/bin/git")
    monkeypatch.setattr(instrumentation, "_run_git", run)

    assert _git_head() == {
        "available": False,
        "reason": "git rev-parse timed out after 5 seconds",
    }


def test_git_head_reports_nonzero_dirty_probe_without_fabricating_clean(monkeypatch):
    calls = 0

    def run(*args, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            return subprocess.CompletedProcess(args[0], 0, stdout="abc123\n", stderr="")
        return subprocess.CompletedProcess(
            args[0], 128, stdout="", stderr="fatal: index is corrupt\n"
        )

    monkeypatch.setattr(instrumentation.shutil, "which", lambda _name: "/usr/bin/git")
    monkeypatch.setattr(instrumentation, "_run_git", run)

    assert _git_head() == {
        "available": True,
        "head": "abc123",
        "dirty": None,
        "dirty_reason": "git status failed: fatal: index is corrupt",
    }


def test_git_head_preserves_head_when_real_status_subprocess_is_slow(
    tmp_path, monkeypatch
):
    """Exercise the failing status process boundary, not a mocked run call."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    leaked_child_marker = tmp_path / "git-child-survived"
    child = tmp_path / "git-child.py"
    child.write_text(
        (
            "import pathlib\n"
            "import sys\n"
            "import time\n"
            "time.sleep(1)\n"
            "pathlib.Path(sys.argv[1]).write_text('leaked', encoding='utf-8')\n"
        ),
        encoding="utf-8",
    )
    fake_git = bin_dir / "git"
    fake_git.write_text(
        (
            f"#!{sys.executable}\n"
            "import subprocess\n"
            "import sys\n"
            "import time\n"
            "if 'rev-parse' in sys.argv:\n"
            "    print('abc123')\n"
            "else:\n"
            f"    subprocess.Popen([{sys.executable!r}, {str(child)!r}, {str(leaked_child_marker)!r}])\n"
            "    time.sleep(10)\n"
        ),
        encoding="utf-8",
    )
    fake_git.chmod(0o755)
    monkeypatch.setenv("PATH", str(bin_dir))

    started = time.monotonic()
    result = _git_head(timeout_seconds=0.5)
    elapsed = time.monotonic() - started

    assert result == {
        "available": True,
        "head": "abc123",
        "dirty": None,
        "dirty_reason": "git status timed out after 0.5 seconds",
    }
    assert elapsed < 2, "slow provenance probe should be terminated at its deadline"
    if os.name == "posix":
        time.sleep(0.75)
        assert not leaked_child_marker.exists(), "timed-out Git child survived"


def test_log_environment_hashes_tokenizer_and_base_checkpoint(tmp_path, monkeypatch):
    monkeypatch.setattr(instrumentation, "_git_head", lambda: {"available": False})
    # Tokenizer as a directory (as HF saves it) → one combined digest.
    tok_dir = tmp_path / "tokenizer"
    tok_dir.mkdir()
    (tok_dir / "tokenizer.json").write_bytes(b"{}")
    (tok_dir / "special_tokens_map.json").write_bytes(b"{}")
    # Base checkpoint as a single file.
    ckpt = tmp_path / "model.safetensors"
    ckpt.write_bytes(b"\x00\x01\x02")

    out = tmp_path / "run"
    log_environment(out, tokenizer_path=tok_dir, base_checkpoint=ckpt)
    repro = _read_env(out)["reproducibility"]

    # The tokenizer artifact hash is REQUIRED by AGENTS.md §9 — it must be
    # present and a real sha256 (64 hex chars), not just a prefix or empty.
    tok_hash = repro["tokenizer_hashes"][str(tok_dir)]
    assert re.fullmatch(r"sha256:[a-f0-9]{64}", tok_hash), tok_hash
    assert repro["base_checkpoint_hashes"][str(ckpt)] == (
        "sha256:" + hashlib.sha256(ckpt.read_bytes()).hexdigest()
    )


def test_log_environment_records_tokenizer_hash_when_passed(tmp_path, monkeypatch):
    """Regression for the C10 wiring gap: train_local.py must pass tokenizer_path
    so the reproducibility manifest is COMPLETE. Without a tokenizer_path the map
    is empty; with one it carries the artifact hash. This guards that the
    tokenizer slot is populated (the train_local.py call now passes it)."""
    monkeypatch.setattr(instrumentation, "_git_head", lambda: {"available": False})
    tok_dir = tmp_path / "tokenizer"
    tok_dir.mkdir()
    (tok_dir / "tokenizer.json").write_bytes(b'{"model":"gemma4"}')

    # Not passing tokenizer_path → empty (proves the field is opt-in on inputs).
    out_no_tok = tmp_path / "run-none"
    log_environment(out_no_tok, base_checkpoint="org/repo-id")
    assert _read_env(out_no_tok)["reproducibility"]["tokenizer_hashes"] == {}

    # Passing it → the artifact hash is captured.
    out_tok = tmp_path / "run-tok"
    log_environment(out_tok, tokenizer_path=tok_dir)
    hashes = _read_env(out_tok)["reproducibility"]["tokenizer_hashes"]
    assert list(hashes) == [str(tok_dir)]
    assert re.fullmatch(r"sha256:[a-f0-9]{64}", hashes[str(tok_dir)])


def test_log_environment_skips_non_local_base_checkpoint(tmp_path, monkeypatch):
    """A bare HF repo id (e.g. google/gemma-4-E2B) is not a local path — it must
    be skipped, not faked into a hash."""
    monkeypatch.setattr(instrumentation, "_git_head", lambda: {"available": False})
    out = tmp_path / "run"
    log_environment(out, base_checkpoint="google/gemma-4-E2B")
    repro = _read_env(out)["reproducibility"]
    assert repro["base_checkpoint_hashes"] == {}


def test_hash_paths_directory_digest_is_content_sensitive(tmp_path):
    d = tmp_path / "d"
    d.mkdir()
    (d / "a.txt").write_bytes(b"hello")
    h1 = _hash_paths([d])[str(d)]
    (d / "a.txt").write_bytes(b"HELLO")
    h2 = _hash_paths([d])[str(d)]
    assert h1 != h2, "directory digest must change when a file's content changes"


def test_hash_paths_empty_when_nothing_local(tmp_path):
    assert _hash_paths(None) == {}
    assert _hash_paths([tmp_path / "nope.jsonl", "org/repo-id"]) == {}
