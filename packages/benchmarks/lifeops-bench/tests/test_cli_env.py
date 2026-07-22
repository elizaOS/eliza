"""LifeOpsBench direct-CLI environment loading."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

from eliza_lifeops_bench.__main__ import _build_parser, _load_env_file, _run
from eliza_lifeops_bench.scenarios import ALL_SCENARIOS


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


def test_default_dry_run_does_not_silently_drop_live_scenarios(
    monkeypatch, capsys
) -> None:
    monkeypatch.delenv("CEREBRAS_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    args = _build_parser().parse_args(["--agent", "perfect", "--dry-run"])

    asyncio.run(_run(args))

    output = capsys.readouterr().out
    expected = len(ALL_SCENARIOS)
    assert f"Starting LifeOpsBench with {expected} scenarios" in output
    assert f"[dry-run] resolved {expected} scenarios" in output
