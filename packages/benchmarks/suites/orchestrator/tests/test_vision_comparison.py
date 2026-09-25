"""Comparison groups must include auxiliary vision routing, not only text models."""
import json
from pathlib import Path

import benchmarks
import pytest
from benchmarks.orchestrator.adapters import discover_adapters
from benchmarks.orchestrator.runner import _comparison_signature_for, _effective_request
from benchmarks.orchestrator.types import ExecutionContext, RunRequest


@pytest.mark.parametrize("benchmark", ["osworld", "visualwebbench"])
def test_auxiliary_vision_model_and_endpoint_change_comparison_group(benchmark, tmp_path):
    root = Path(benchmarks.__file__).parent
    adapter = discover_adapters(root).adapters[benchmark]
    request = RunRequest((benchmark,), "eliza", "openai", "text-model", {})
    environments = [
        {"OPENAI_IMAGE_DESCRIPTION_MODEL": "vision-a", "OPENAI_BASE_URL": "https://a.example/v1"},
        {"OPENAI_IMAGE_DESCRIPTION_MODEL": "vision-b", "OPENAI_BASE_URL": "https://a.example/v1"},
        {"OPENAI_IMAGE_DESCRIPTION_MODEL": "vision-a", "OPENAI_IMAGE_DESCRIPTION_BASE_URL": "https://user:secret@b.example/v1"},
    ]
    effective = [_effective_request(adapter, request, environment=env) for env in environments]
    assert len({_comparison_signature_for(adapter, run) for run in effective}) == 3
    assert "secret" not in json.dumps(effective[2].extra_config)
    assert "b.example" not in json.dumps(effective[2].extra_config)
    for env, run in zip(environments, effective, strict=True):
        ctx = ExecutionContext(root.parent.parent, root / "suites", tmp_path, tmp_path, run, "vision-test", env, {})
        assert adapter.env_builder is not None
        subprocess_env = {**env, **adapter.env_builder(ctx, adapter)}
        assert subprocess_env["OPENAI_IMAGE_DESCRIPTION_MODEL"] == run.extra_config["vision_model"]


def test_same_vision_contract_remains_comparable_across_harnesses():
    root = Path(benchmarks.__file__).parent
    adapter = discover_adapters(root).adapters["osworld"]
    signatures = []
    for harness in ("eliza", "hermes", "openclaw"):
        request = RunRequest(("osworld",), harness, "openai", "same-model", {})
        effective = _effective_request(adapter, request, environment={})
        assert effective.extra_config["vision_model"] == "same-model"
        signatures.append(_comparison_signature_for(adapter, effective))
    assert len(set(signatures)) == 1


@pytest.mark.parametrize("value", [None, "", 123, True])
def test_invalid_vision_model_is_not_silently_defaulted(value):
    root = Path(benchmarks.__file__).parent
    adapter = discover_adapters(root).adapters["osworld"]
    request = RunRequest(("osworld",), "eliza", "openai", "text", {"vision_model": value})
    with pytest.raises(ValueError, match="vision_model"):
        _effective_request(adapter, request, environment={})


@pytest.mark.parametrize("value", [None, "", "   ", 123, True])
def test_explicit_empty_endpoint_cannot_disagree_with_subprocess_routing(value):
    root = Path(benchmarks.__file__).parent
    adapter = discover_adapters(root).adapters["osworld"]
    request = RunRequest(("osworld",), "eliza", "openai", "text", {"vision_base_url": value})
    with pytest.raises(ValueError, match="vision_base_url"):
        _effective_request(adapter, request, environment={"OPENAI_BASE_URL": "https://provider.example/v1"})


@pytest.mark.parametrize("harness", ["hermes", "openclaw"])
def test_native_image_harness_does_not_claim_unused_auxiliary_model(harness, tmp_path):
    root = Path(benchmarks.__file__).parent
    adapter = discover_adapters(root).adapters["osworld"]
    request = RunRequest(("osworld",), harness, "openai", "primary-model", {})
    env = {"OPENAI_IMAGE_DESCRIPTION_MODEL":"unused-caption-model", "OPENAI_IMAGE_DESCRIPTION_BASE_URL":"https://unused.example/v1", "OPENAI_BASE_URL":"https://primary.example/v1"}
    effective = _effective_request(adapter, request, environment=env)
    assert effective.extra_config["vision_model"] == "primary-model"
    clean = _effective_request(adapter, request, environment={"OPENAI_BASE_URL":"https://primary.example/v1"})
    assert _comparison_signature_for(adapter, effective) == _comparison_signature_for(adapter, clean)
    ctx = ExecutionContext(root.parent.parent, root / "suites", tmp_path, tmp_path, effective, "vision-test", env, {})
    worker_env = adapter.env_builder(ctx, adapter)
    assert "OPENAI_IMAGE_DESCRIPTION_MODEL" not in worker_env
    eliza = _effective_request(adapter, RunRequest(("osworld",), "eliza", "openai", "primary-model", {}), environment=env)
    assert _comparison_signature_for(adapter, effective) != _comparison_signature_for(adapter, eliza)


@pytest.mark.parametrize("harness", ["hermes", "openclaw"])
@pytest.mark.parametrize("extra", [{"vision_model":"other-model"}, {"vision_base_url":"https://unused.example/v1"}])
def test_native_image_harness_rejects_unused_explicit_routing(harness, extra):
    root = Path(benchmarks.__file__).parent
    adapter = discover_adapters(root).adapters["osworld"]
    request = RunRequest(("osworld",), harness, "openai", "primary-model", extra)
    with pytest.raises(ValueError, match="Native image harness"):
        _effective_request(adapter, request, environment={})
