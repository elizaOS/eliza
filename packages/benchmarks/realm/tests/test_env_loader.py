from pathlib import Path

import pytest

from benchmarks.realm.cli import _parse_env_line, load_env_file


def test_parse_env_line() -> None:
    assert _parse_env_line("") is None
    assert _parse_env_line("# comment") is None
    assert _parse_env_line("NO_EQUALS") is None

    assert _parse_env_line("A=1") == ("A", "1")
    assert _parse_env_line("export B=two") == ("B", "two")
    assert _parse_env_line("C='three'") == ("C", "three")
    assert _parse_env_line('D="four"') == ("D", "four")


def test_load_env_file_does_not_override(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    p = tmp_path / ".env"
    p.write_text("X=from_file\nY=from_file\n", encoding="utf-8")

    monkeypatch.setenv("Y", "existing")
    loaded = load_env_file(p, override=False)

    assert loaded["X"] == "from_file"
    assert "Y" not in loaded  # should not override
    assert loaded == {"X": "from_file"}


def test_load_env_file_can_override(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    p = tmp_path / ".env"
    p.write_text("Y=from_file\n", encoding="utf-8")

    monkeypatch.setenv("Y", "existing")
    loaded = load_env_file(p, override=True)

    assert loaded == {"Y": "from_file"}

