"""LifeOpsBench direct-CLI environment loading."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from eliza_lifeops_bench.__main__ import _build_agent_fn, _load_env_file


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


def test_openclaw_lifeops_agent_defaults_to_direct_tool_path(monkeypatch) -> None:
    """LifeOps OpenClaw must pass benchmark tools instead of flattening via CLI."""
    from eliza_lifeops_bench.agents.adapter_paths import ensure_benchmark_adapter_importable

    ensure_benchmark_adapter_importable("openclaw")
    from openclaw_adapter.client import OpenClawClient

    captured: dict[str, Any] = {}

    def fake_init(self: Any, **kwargs: Any) -> None:
        captured.update(kwargs)
        self.model = kwargs.get("model") or "gpt-oss-120b"

    def fail_wait(self: Any, *args: Any, **kwargs: Any) -> None:
        raise AssertionError("direct OpenClaw LifeOps path should not wait for CLI")

    monkeypatch.delenv("OPENCLAW_USE_CLI", raising=False)
    monkeypatch.setattr(OpenClawClient, "__init__", fake_init)
    monkeypatch.setattr(OpenClawClient, "wait_until_ready", fail_wait)

    agent = _build_agent_fn("openclaw", model_override="gpt-oss-120b")

    assert callable(agent)
    assert captured["direct_openai_compatible"] is True
