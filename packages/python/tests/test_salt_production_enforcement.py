from __future__ import annotations

import pytest

from elizaos.settings import get_salt


def test_get_salt_throws_in_production_when_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.delenv("SECRET_SALT", raising=False)
    monkeypatch.delenv("ELIZA_ALLOW_DEFAULT_SECRET_SALT", raising=False)

    with pytest.raises(RuntimeError, match="SECRET_SALT must be set"):
        get_salt()


def test_get_salt_allows_override_in_production(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.delenv("SECRET_SALT", raising=False)
    monkeypatch.setenv("ELIZA_ALLOW_DEFAULT_SECRET_SALT", "true")

    assert get_salt() == "secretsalt"
