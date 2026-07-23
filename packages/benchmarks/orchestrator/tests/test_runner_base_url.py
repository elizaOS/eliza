"""Base-URL resolution for OpenAI-compatible provider lanes in the runner's
subprocess env: operator-exported proxy endpoints and per-run extra_config must
win over the hardcoded provider defaults. Exercises the real _default_env."""

from __future__ import annotations

from pathlib import Path

import pytest

from benchmarks.orchestrator import runner
from benchmarks.orchestrator.types import RunRequest

PROXY_URL = "https://elizacloud.ai/api/v1"
OTHER_PROXY_URL = "https://proxy.example.test/v1"

AMBIENT_BASE_URL_VARS = (
    "OPENAI_BASE_URL",
    "BENCHMARK_BASE_URL",
    "CEREBRAS_BASE_URL",
    "GROQ_BASE_URL",
    "OPENROUTER_BASE_URL",
    "VLLM_BASE_URL",
)


@pytest.fixture(autouse=True)
def _clean_ambient_base_urls(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in AMBIENT_BASE_URL_VARS:
        monkeypatch.delenv(name, raising=False)


def _request(
    provider: str, extra_config: dict[str, object] | None = None
) -> RunRequest:
    return RunRequest(
        benchmarks=("gsm8k",),
        agent="eliza",
        provider=provider,
        model="gemma-4-31b",
        extra_config=dict(extra_config or {}),
    )


def test_ambient_cerebras_base_url_survives_into_subprocess_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CEREBRAS_BASE_URL", PROXY_URL)

    env = runner._default_env(tmp_path, _request("cerebras"))

    assert env["CEREBRAS_BASE_URL"] == PROXY_URL
    assert env["OPENAI_BASE_URL"] == PROXY_URL


def test_ambient_benchmark_base_url_used_when_provider_var_absent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("BENCHMARK_BASE_URL", PROXY_URL)

    env = runner._default_env(tmp_path, _request("cerebras"))

    assert env["OPENAI_BASE_URL"] == PROXY_URL
    assert env["CEREBRAS_BASE_URL"] == PROXY_URL


def test_ambient_openai_base_url_used_as_last_env_resort(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_BASE_URL", PROXY_URL)

    env = runner._default_env(tmp_path, _request("cerebras"))

    assert env["OPENAI_BASE_URL"] == PROXY_URL
    assert env["CEREBRAS_BASE_URL"] == PROXY_URL


def test_provider_specific_env_var_outranks_generic_ambient_vars(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CEREBRAS_BASE_URL", PROXY_URL)
    monkeypatch.setenv("BENCHMARK_BASE_URL", OTHER_PROXY_URL)
    monkeypatch.setenv("OPENAI_BASE_URL", OTHER_PROXY_URL)

    env = runner._default_env(tmp_path, _request("cerebras"))

    assert env["OPENAI_BASE_URL"] == PROXY_URL
    assert env["CEREBRAS_BASE_URL"] == PROXY_URL


def test_extra_config_base_url_beats_ambient_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CEREBRAS_BASE_URL", PROXY_URL)

    env = runner._default_env(
        tmp_path, _request("cerebras", {"base_url": OTHER_PROXY_URL})
    )

    assert env["OPENAI_BASE_URL"] == OTHER_PROXY_URL
    assert env["CEREBRAS_BASE_URL"] == OTHER_PROXY_URL


def test_provider_specific_extra_config_beats_generic_extra_config(
    tmp_path: Path,
) -> None:
    env = runner._default_env(
        tmp_path,
        _request(
            "cerebras",
            {"cerebras_base_url": PROXY_URL, "base_url": OTHER_PROXY_URL},
        ),
    )

    assert env["OPENAI_BASE_URL"] == PROXY_URL
    assert env["CEREBRAS_BASE_URL"] == PROXY_URL


def test_unset_env_falls_back_to_public_cerebras_endpoint(tmp_path: Path) -> None:
    env = runner._default_env(tmp_path, _request("cerebras"))

    assert env["OPENAI_BASE_URL"] == "https://api.cerebras.ai/v1"
    assert env["CEREBRAS_BASE_URL"] == "https://api.cerebras.ai/v1"


def test_cerebras_key_still_mirrors_into_openai_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CEREBRAS_API_KEY", "cloud-key")
    monkeypatch.setenv("CEREBRAS_BASE_URL", PROXY_URL)

    env = runner._default_env(tmp_path, _request("cerebras"))

    assert env["OPENAI_API_KEY"] == "cloud-key"
    assert env["OPENAI_BASE_URL"] == PROXY_URL


def test_groq_honors_ambient_env_and_falls_back_to_public_endpoint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GROQ_BASE_URL", PROXY_URL)
    proxied = runner._default_env(tmp_path, _request("groq"))
    monkeypatch.delenv("GROQ_BASE_URL")
    fallback = runner._default_env(tmp_path, _request("groq"))

    assert proxied["OPENAI_BASE_URL"] == PROXY_URL
    assert proxied["GROQ_BASE_URL"] == PROXY_URL
    assert fallback["OPENAI_BASE_URL"] == "https://api.groq.com/openai/v1"


def test_vllm_extra_config_override_still_wins(tmp_path: Path) -> None:
    env = runner._default_env(
        tmp_path, _request("vllm", {"vllm_base_url": "http://10.0.0.5:8001/v1"})
    )

    assert env["OPENAI_BASE_URL"] == "http://10.0.0.5:8001/v1"
    assert env["VLLM_BASE_URL"] == "http://10.0.0.5:8001/v1"


def test_vllm_ambient_env_still_wins_over_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("VLLM_BASE_URL", "http://10.0.0.9:8001/v1")

    env = runner._default_env(tmp_path, _request("vllm"))

    assert env["OPENAI_BASE_URL"] == "http://10.0.0.9:8001/v1"
    assert env["VLLM_BASE_URL"] == "http://10.0.0.9:8001/v1"


def test_vllm_falls_back_to_local_default(tmp_path: Path) -> None:
    env = runner._default_env(tmp_path, _request("vllm"))

    assert env["OPENAI_BASE_URL"] == "http://127.0.0.1:8001/v1"
    assert env["VLLM_BASE_URL"] == "http://127.0.0.1:8001/v1"
