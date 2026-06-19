"""Tests for the Card Game SDK auto-fetch flow."""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest

from elizaos_agentbench.adapters import card_game_adapter as cga
from elizaos_agentbench.adapters.card_game_adapter import (
    BINARY_RELPATH,
    AvalonSDKError,
    CardGameAdapter,
    default_cache_dir,
    ensure_avalon_sdk,
)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Strip out all influencing env vars and reset module-level state."""
    for var in (
        "AGENTBENCH_CARD_GAME_BIN",
        "AGENTBENCH_CARD_GAME_CACHE_DIR",
        "AGENTBENCH_NO_AUTOFETCH",
    ):
        monkeypatch.delenv(var, raising=False)
    cga._reset_autofetch_state_for_tests()
    yield
    cga._reset_autofetch_state_for_tests()


def _fake_clone_factory(repo_dir: Path):
    """Create a fake git_clone callable that materialises the binary."""

    def _fake_clone(target: Path, timeout: int) -> None:
        # The real clone places the repo at ``target``; mirror that layout.
        assert target == repo_dir, f"unexpected target: {target}"
        bin_path = target / BINARY_RELPATH
        bin_path.parent.mkdir(parents=True, exist_ok=True)
        bin_path.write_bytes(b"#!/bin/sh\necho fake\n")

    return _fake_clone


def test_default_cache_dir_override(monkeypatch, tmp_path):
    monkeypatch.setenv("AGENTBENCH_CARD_GAME_CACHE_DIR", str(tmp_path / "ovr"))
    assert default_cache_dir() == tmp_path / "ovr"


def test_uses_existing_env_var(monkeypatch, tmp_path):
    """If AGENTBENCH_CARD_GAME_BIN is set + file exists, that path wins."""
    bin_path = tmp_path / "main"
    bin_path.write_bytes(b"prebuilt")
    monkeypatch.setenv("AGENTBENCH_CARD_GAME_BIN", str(bin_path))

    result = ensure_avalon_sdk(cache_dir=tmp_path / "cache")
    assert result == bin_path
    # Cache must not be touched.
    assert not (tmp_path / "cache").exists()


def test_autofetch_invokes_git_clone(monkeypatch, tmp_path):
    """With a mocked clone, ensure_avalon_sdk materialises the binary."""
    # Force the linux x86_64 happy-path regardless of host OS.
    monkeypatch.setattr(cga.sys, "platform", "linux")
    monkeypatch.setattr(cga.platform, "machine", lambda: "x86_64")
    cache = tmp_path / "cache"
    repo = cache / "AgentBench"
    fake_clone = _fake_clone_factory(repo)

    result = ensure_avalon_sdk(cache_dir=cache, git_clone=fake_clone)

    assert result == repo / BINARY_RELPATH
    assert result.exists()
    assert os.environ["AGENTBENCH_CARD_GAME_BIN"] == str(result)


def test_autofetch_reuses_existing_cache(monkeypatch, tmp_path):
    """If the binary already lives in the cache, no clone is performed."""
    cache = tmp_path / "cache"
    bin_path = cache / "AgentBench" / BINARY_RELPATH
    bin_path.parent.mkdir(parents=True, exist_ok=True)
    bin_path.write_bytes(b"already there")

    calls: list[Path] = []

    def _no_clone(target: Path, timeout: int) -> None:
        calls.append(target)

    result = ensure_avalon_sdk(cache_dir=cache, git_clone=_no_clone)

    assert result == bin_path
    assert calls == [], "git clone should not run when cache is populated"
    assert os.environ["AGENTBENCH_CARD_GAME_BIN"] == str(bin_path)


def test_opt_out_raises(monkeypatch, tmp_path):
    monkeypatch.setenv("AGENTBENCH_NO_AUTOFETCH", "1")
    cache = tmp_path / "cache"

    with pytest.raises(AvalonSDKError) as excinfo:
        ensure_avalon_sdk(cache_dir=cache)

    assert "AGENTBENCH_NO_AUTOFETCH" in str(excinfo.value)
    # Must not even attempt to create the cache dir contents.
    assert not (cache / "AgentBench").exists()


def test_windows_surfaces_clear_error(monkeypatch, tmp_path):
    """On non-Linux platforms the upstream binary cannot run; fail clearly."""
    if sys.platform.startswith("linux"):
        # Pretend we're on Windows.
        monkeypatch.setattr(cga.sys, "platform", "win32")
        monkeypatch.setattr(cga.platform, "machine", lambda: "AMD64")
    cache = tmp_path / "cache"

    with pytest.raises(AvalonSDKError) as excinfo:
        ensure_avalon_sdk(cache_dir=cache, git_clone=_fake_clone_factory(cache / "AgentBench"))

    msg = str(excinfo.value)
    assert "Linux x86_64" in msg
    assert "WSL" in msg or "Docker" in msg


def test_clone_failure_propagates(monkeypatch, tmp_path):
    """A failing clone surfaces as AvalonSDKError, not a bare CalledProcessError."""
    monkeypatch.setattr(cga.sys, "platform", "linux")
    monkeypatch.setattr(cga.platform, "machine", lambda: "x86_64")
    cache = tmp_path / "cache"

    def _broken_clone(target: Path, timeout: int) -> None:
        raise AvalonSDKError("simulated network failure")

    with pytest.raises(AvalonSDKError, match="simulated network failure"):
        ensure_avalon_sdk(cache_dir=cache, git_clone=_broken_clone)


def test_adapter_initialize_skips_on_no_autofetch(monkeypatch, tmp_path):
    """The adapter wraps fetch errors as a skip reason rather than crashing."""
    monkeypatch.setenv("AGENTBENCH_NO_AUTOFETCH", "1")
    monkeypatch.setenv("AGENTBENCH_CARD_GAME_CACHE_DIR", str(tmp_path / "cache"))

    adapter = CardGameAdapter()
    asyncio.run(adapter.initialize())

    assert adapter._sdk_path is None
    assert adapter._skipped_reason is not None
    assert "AGENTBENCH_NO_AUTOFETCH" in adapter._skipped_reason


def test_adapter_initialize_picks_up_preset_binary(monkeypatch, tmp_path):
    """If AGENTBENCH_CARD_GAME_BIN points at a real file, the adapter activates."""
    bin_path = tmp_path / "main"
    bin_path.write_bytes(b"prebuilt")
    monkeypatch.setenv("AGENTBENCH_CARD_GAME_BIN", str(bin_path))

    adapter = CardGameAdapter()
    asyncio.run(adapter.initialize())

    assert adapter._sdk_path == str(bin_path)
    assert adapter._skipped_reason is None
