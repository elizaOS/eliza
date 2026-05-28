"""Offline unit tests for SmithersManager."""

from __future__ import annotations

from pathlib import Path

import pytest

from smithers_adapter.client import SmithersClient
from smithers_adapter.server_manager import SmithersManager


def test_rejects_both_install_dir_and_client(tmp_path: Path) -> None:
    client = SmithersClient(install_dir=tmp_path)
    with pytest.raises(ValueError):
        SmithersManager(install_dir=tmp_path, client=client)


def test_start_raises_when_not_ready(tmp_path: Path) -> None:
    client = SmithersClient(install_dir=tmp_path)
    mgr = SmithersManager(client=client)
    # tmp_path has no node_modules -> health() reports error -> start() raises.
    with pytest.raises(RuntimeError):
        mgr.start()


def test_install_dir_property(tmp_path: Path) -> None:
    client = SmithersClient(install_dir=tmp_path)
    mgr = SmithersManager(client=client)
    assert mgr.install_dir == tmp_path
    mgr.stop()  # no-op
