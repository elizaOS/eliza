"""LifeOpsBench direct-CLI environment loading."""

from __future__ import annotations

import os
from pathlib import Path

from eliza_lifeops_bench.__main__ import _load_env_file


def test_load_env_file_loads_values_without_overriding(
    tmp_path: Path,
    monkeypatch,
) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text(
        "\n".join(
            [
                "LIFEOPS_TEST_API_KEY=test-key",
                "export LIFEOPS_TEST_BASE_URL='https://api.example/v1'",
                "EXISTING=from-file",
            ]
        )
    )
    monkeypatch.delenv("LIFEOPS_TEST_API_KEY", raising=False)
    monkeypatch.delenv("LIFEOPS_TEST_BASE_URL", raising=False)
    monkeypatch.setenv("EXISTING", "keep-me")

    _load_env_file(env_file)

    assert os.environ["LIFEOPS_TEST_API_KEY"] == "test-key"
    assert os.environ["LIFEOPS_TEST_BASE_URL"] == "https://api.example/v1"
    assert os.environ["EXISTING"] == "keep-me"
