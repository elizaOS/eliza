from __future__ import annotations

from types import SimpleNamespace

from elizaos.prompt_compression import (
    compress_prompt_description,
    get_prompt_action_description,
    get_prompt_parameter_description,
    get_prompt_provider_description,
    is_prompt_compression_enabled,
)


def _runtime(setting: object | None) -> SimpleNamespace:
    return SimpleNamespace(get_setting=lambda key: setting if key == "PROMPT_COMPRESSION" else None)


def test_prompt_compression_disabled_uses_full_descriptions() -> None:
    runtime = _runtime(False)
    action = SimpleNamespace(name="REPLY", description="Full action description.")
    provider = SimpleNamespace(name="ACTIONS", description="Full provider description.")
    parameter = SimpleNamespace(name="content", description="Full parameter description.")

    assert get_prompt_action_description(action, runtime) == "Full action description."
    assert get_prompt_provider_description(provider, runtime) == "Full provider description."
    assert get_prompt_parameter_description("SEND_MESSAGE", parameter, runtime) == (
        "Full parameter description."
    )


def test_prompt_compression_enabled_prefers_compressed_descriptions() -> None:
    runtime = _runtime(True)

    action = SimpleNamespace(
        name="REPLY", description="Verbose action.", description_compressed=None
    )
    provider = SimpleNamespace(
        name="ACTIONS", description="Verbose provider.", description_compressed=None
    )
    parameter = SimpleNamespace(
        name="content",
        description="Verbose parameter.",
        description_compressed="Inline parameter compression.",
    )

    assert get_prompt_action_description(action, runtime) == (
        "Reply with generated msg. Default when responding with no other action. Use first as ack, last as final response."
    )
    assert get_prompt_provider_description(provider, runtime) == "Available response actions."
    assert get_prompt_parameter_description("SEND_MESSAGE", parameter, runtime) == (
        "Inline parameter compression."
    )


def test_prompt_compression_falls_back_to_inline_and_truncation() -> None:
    runtime = _runtime(True)
    provider = SimpleNamespace(
        name="CUSTOM_PROVIDER",
        description=" ".join(["custom"] * 80),
        description_compressed="short provider",
    )
    parameter = SimpleNamespace(name="custom", description=" ".join(["parameter"] * 60))

    assert get_prompt_provider_description(provider, runtime) == "short provider"
    assert get_prompt_parameter_description("CUSTOM_ACTION", parameter, runtime).endswith("...")
    assert len(compress_prompt_description(" ".join(["word"] * 80))) <= 160


def test_prompt_compression_detects_truthy_settings() -> None:
    runtime = _runtime("true")
    assert is_prompt_compression_enabled(runtime) is True
