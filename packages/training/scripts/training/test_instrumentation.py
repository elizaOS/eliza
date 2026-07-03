"""CPU-only tests for the training environment / reproducibility manifest.

`log_environment` writes environment.json with the AGENTS.md §9 reproducibility
manifest: sha256 of every dataset file, the tokenizer artifact hash, the
base-checkpoint hash, and the training git commit. These tests use tmp files +
a mocked git call so they run anywhere headlessly.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from scripts.training import instrumentation
from scripts.training.instrumentation import _hash_paths, log_environment


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

    assert repro["tokenizer_hashes"][str(tok_dir)].startswith("sha256:")
    assert repro["base_checkpoint_hashes"][str(ckpt)] == (
        "sha256:" + hashlib.sha256(ckpt.read_bytes()).hexdigest()
    )


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
