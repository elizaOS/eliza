"""LifeOpsBench direct-CLI environment loading."""

from __future__ import annotations

import asyncio
import base64
import os
from pathlib import Path

import pytest

from eliza_lifeops_bench.__main__ import (
    _build_parser,
    _build_trusted_execution,
    _load_env_file,
    _run,
)
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


def test_dry_run_allows_distinct_cerebras_evaluator_and_judge(
    monkeypatch, capsys
) -> None:
    monkeypatch.delenv("LIFEOPS_BENCH_EVALUATOR_PROVIDER", raising=False)
    monkeypatch.delenv("LIFEOPS_BENCH_JUDGE_PROVIDER", raising=False)
    args = _build_parser().parse_args(
        [
            "--agent",
            "perfect",
            "--evaluator-provider",
            "cerebras",
            "--evaluator-model",
            "zai-glm-4.7",
            "--judge-provider",
            "cerebras",
            "--judge-model",
            "gpt-oss-120b",
            "--dry-run",
        ]
    )

    asyncio.run(_run(args))

    output = capsys.readouterr().out
    assert "Evaluator:       cerebras → zai-glm-4.7" in output
    assert "Judge:           cerebras → gpt-oss-120b" in output


def test_environment_can_select_live_evaluator_providers(
    monkeypatch, capsys
) -> None:
    monkeypatch.setenv("LIFEOPS_BENCH_EVALUATOR_PROVIDER", "cerebras")
    monkeypatch.setenv("LIFEOPS_BENCH_JUDGE_PROVIDER", "cerebras")
    args = _build_parser().parse_args(
        [
            "--agent",
            "perfect",
            "--evaluator-model",
            "zai-glm-4.7",
            "--judge-model",
            "gpt-oss-120b",
            "--dry-run",
        ]
    )

    asyncio.run(_run(args))

    output = capsys.readouterr().out
    assert "Evaluator:       cerebras → zai-glm-4.7" in output
    assert "Judge:           cerebras → gpt-oss-120b" in output


def test_dry_run_rejects_same_evaluator_and_judge_model() -> None:
    args = _build_parser().parse_args(
        [
            "--agent",
            "perfect",
            "--evaluator-provider",
            "cerebras",
            "--evaluator-model",
            "gpt-oss-120b",
            "--judge-provider",
            "cerebras",
            "--judge-model",
            "gpt-oss-120b",
            "--dry-run",
        ]
    )

    with pytest.raises(SystemExit, match="self-agreement bias"):
        asyncio.run(_run(args))


def test_trusted_executor_uses_distinct_keys_and_removes_credentials(
    monkeypatch,
) -> None:
    scenario = next(
        item
        for item in ALL_SCENARIOS
        if item.trusted_evidence_requirement is not None
    )
    request_key = base64.b64encode(b"r" * 32).decode("ascii")
    receipt_key = base64.b64encode(b"s" * 32).decode("ascii")
    configuration = {
        "LIFEOPS_BENCH_TRUSTED_EXECUTOR_REQUEST_HMAC_KEY_B64": request_key,
        "LIFEOPS_BENCH_TRUSTED_EXECUTOR_RECEIPT_HMAC_KEY_B64": receipt_key,
        "LIFEOPS_BENCH_TRUSTED_EXECUTOR_REQUEST_KEY_ID": "request-key-v1",
        "LIFEOPS_BENCH_TRUSTED_EXECUTOR_RECEIPT_KEY_ID": "receipt-key-v1",
        "LIFEOPS_BENCH_TRUSTED_EXECUTOR_ALLOWED_PROVIDERS": "calendar-sandbox",
        "LIFEOPS_BENCH_TRUSTED_EXECUTOR_ALLOWED_BOUNDARIES": "sandbox_connector",
        "LIFEOPS_BENCH_TRUSTED_EXECUTOR_BEARER_TOKEN": "test-token",
    }
    for name, value in configuration.items():
        monkeypatch.setenv(name, value)
    args = _build_parser().parse_args(
        [
            "--trusted-executor-url",
            "http://127.0.0.1:4318/execute",
        ]
    )

    executor, verifier = _build_trusted_execution(args, [scenario])

    assert executor is not None
    assert verifier is not None
    assert executor._request_hmac_key != verifier._receipt_key
    assert all(name not in os.environ for name in configuration)


def test_legacy_shared_executor_key_does_not_enable_evidence(
    monkeypatch,
) -> None:
    scenario = next(
        item
        for item in ALL_SCENARIOS
        if item.trusted_evidence_requirement is not None
    )
    for name in (
        "LIFEOPS_BENCH_TRUSTED_EXECUTOR_REQUEST_HMAC_KEY_B64",
        "LIFEOPS_BENCH_TRUSTED_EXECUTOR_RECEIPT_HMAC_KEY_B64",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv(
        "LIFEOPS_BENCH_TRUSTED_EXECUTOR_HMAC_KEY_B64",
        base64.b64encode(b"x" * 32).decode("ascii"),
    )
    args = _build_parser().parse_args(
        [
            "--trusted-executor-url",
            "http://127.0.0.1:4318/execute",
        ]
    )

    with pytest.raises(SystemExit, match="REQUEST_HMAC_KEY"):
        _build_trusted_execution(args, [scenario])
