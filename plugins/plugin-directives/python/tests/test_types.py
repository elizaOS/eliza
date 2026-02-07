"""Tests for directive types - construction and serialization."""

from __future__ import annotations

from elizaos_plugin_directives.types import (
    DirectiveState,
    ExecConfig,
    ModelConfig,
    ParsedDirectives,
)


def test_exec_config_defaults() -> None:
    cfg = ExecConfig()
    assert cfg.enabled is False
    assert cfg.auto_approve is False


def test_exec_config_custom() -> None:
    cfg = ExecConfig(enabled=True, auto_approve=True)
    assert cfg.enabled is True
    assert cfg.auto_approve is True


def test_model_config_defaults() -> None:
    cfg = ModelConfig()
    assert cfg.provider is None
    assert cfg.model is None
    assert cfg.temperature is None


def test_model_config_with_values() -> None:
    cfg = ModelConfig(provider="anthropic", model="claude-3", temperature=0.7)
    assert cfg.provider == "anthropic"
    assert cfg.model == "claude-3"
    assert cfg.temperature == 0.7


def test_parsed_directives_defaults() -> None:
    pd = ParsedDirectives()
    assert pd.cleaned_text == ""
    assert pd.directives_only is False
    assert pd.has_think is False
    assert pd.think is None
    assert pd.has_verbose is False
    assert pd.has_reasoning is False
    assert pd.has_elevated is False
    assert pd.has_exec is False
    assert pd.has_model is False
    assert pd.has_status is False


def test_parsed_directives_frozen() -> None:
    pd = ParsedDirectives(cleaned_text="hello", has_think=True, think="verbose")
    try:
        pd.think = "concise"  # type: ignore[misc]
        assert False, "Should have raised FrozenInstanceError"
    except AttributeError:
        pass  # expected — frozen dataclass


def test_directive_state_defaults() -> None:
    state = DirectiveState()
    assert state.thinking == "off"
    assert state.verbose == "off"
    assert state.reasoning == "off"
    assert state.elevated == "off"
    assert state.exec == ExecConfig()
    assert state.model == ModelConfig()


def test_directive_state_to_dict() -> None:
    state = DirectiveState(
        thinking="verbose",
        verbose="on",
        reasoning="brief",
        elevated="off",
        exec=ExecConfig(enabled=True, auto_approve=False),
        model=ModelConfig(provider="anthropic", model="claude-3", temperature=0.7),
    )
    d = state.to_dict()
    assert d["thinking"] == "verbose"
    assert d["verbose"] == "on"
    assert d["reasoning"] == "brief"
    assert d["elevated"] == "off"
    assert d["exec"]["enabled"] is True
    assert d["exec"]["auto_approve"] is False
    assert d["model"]["provider"] == "anthropic"
    assert d["model"]["model"] == "claude-3"
    assert d["model"]["temperature"] == 0.7


def test_directive_state_roundtrip() -> None:
    state = DirectiveState(
        thinking="concise",
        model=ModelConfig(provider="openai", model="gpt-4o"),
    )
    d = state.to_dict()
    reconstructed = DirectiveState(
        thinking=d["thinking"],  # type: ignore[arg-type]
        verbose=d["verbose"],  # type: ignore[arg-type]
        reasoning=d["reasoning"],  # type: ignore[arg-type]
        elevated=d["elevated"],  # type: ignore[arg-type]
        exec=ExecConfig(**d["exec"]),  # type: ignore[arg-type]
        model=ModelConfig(**d["model"]),  # type: ignore[arg-type]
    )
    assert reconstructed.thinking == "concise"
    assert reconstructed.model.provider == "openai"
    assert reconstructed.model.model == "gpt-4o"


def test_exec_config_frozen() -> None:
    cfg = ExecConfig(enabled=True)
    try:
        cfg.enabled = False  # type: ignore[misc]
        assert False, "Should have raised FrozenInstanceError"
    except AttributeError:
        pass


def test_model_config_frozen() -> None:
    cfg = ModelConfig(provider="test")
    try:
        cfg.provider = "changed"  # type: ignore[misc]
        assert False, "Should have raised FrozenInstanceError"
    except AttributeError:
        pass
