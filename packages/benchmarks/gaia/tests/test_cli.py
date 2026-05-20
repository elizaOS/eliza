from __future__ import annotations

from pathlib import Path

import pytest

from elizaos_gaia.cli import get_hf_token_from_env, prepare_dataset_access
from elizaos_gaia.types import GAIAConfig


def test_official_gaia_without_token_fails_before_harness_start() -> None:
    config = GAIAConfig(dataset_source="gaia")

    error = prepare_dataset_access(config, quick_test=False, hf_token=None)

    assert error is not None
    assert "HF_TOKEN" in error
    assert config.dataset_source == "gaia"


def test_quick_test_without_token_uses_sample_dataset() -> None:
    config = GAIAConfig(dataset_source="gaia")

    error = prepare_dataset_access(config, quick_test=True, hf_token=None)

    assert error is None
    assert config.dataset_source == "sample"


def test_official_gaia_with_token_keeps_official_dataset() -> None:
    config = GAIAConfig(dataset_source="gaia")

    error = prepare_dataset_access(config, quick_test=False, hf_token="present")

    assert error is None
    assert config.dataset_source == "gaia"


def test_official_gaia_with_cached_snapshot_keeps_official_dataset(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    metadata = (
        tmp_path
        / ".cache"
        / "gaia"
        / "datasets--gaia-benchmark--GAIA"
        / "snapshots"
        / "abc123"
        / "2023"
        / "validation"
        / "metadata.jsonl"
    )
    metadata.parent.mkdir(parents=True)
    metadata.write_text("{}", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    config = GAIAConfig(dataset_source="gaia", split="validation")

    error = prepare_dataset_access(config, quick_test=False, hf_token=None)

    assert error is None
    assert config.dataset_source == "gaia"


@pytest.mark.parametrize(
    "env_name",
    ["HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "HUGGINGFACE_TOKEN"],
)
def test_hf_token_env_aliases_are_supported(
    monkeypatch: pytest.MonkeyPatch,
    env_name: str,
) -> None:
    for name in ("HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "HUGGINGFACE_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv(env_name, "token-value")

    assert get_hf_token_from_env() == "token-value"
