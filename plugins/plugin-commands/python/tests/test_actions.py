"""Tests for actions and the provider."""

from __future__ import annotations

import pytest

from elizaos_plugin_commands.actions import (
    CommandsListAction,
    HelpCommandAction,
    ModelsCommandAction,
    StatusCommandAction,
    StopCommandAction,
)
from elizaos_plugin_commands.providers import CommandRegistryProvider
from elizaos_plugin_commands.registry import default_registry


def _message(text: str) -> dict:
    return {
        "content": {"text": text},
        "room_id": "room-123",
        "agent_id": "agent-456",
        "entity_id": "user-789",
    }


# ── Help action ──────────────────────────────────────────────────────────


class TestHelpAction:
    @pytest.mark.asyncio
    async def test_validate_positive(self) -> None:
        action = HelpCommandAction()
        assert await action.validate(_message("/help"), {})
        assert await action.validate(_message("/h"), {})

    @pytest.mark.asyncio
    async def test_validate_negative(self) -> None:
        action = HelpCommandAction()
        assert not await action.validate(_message("/status"), {})
        assert not await action.validate(_message("help me"), {})

    @pytest.mark.asyncio
    async def test_handler(self) -> None:
        action = HelpCommandAction()
        reg = default_registry()
        result = await action.handler(_message("/help"), {}, registry=reg)
        assert result.success
        assert "**Available Commands:**" in result.text
        assert "/help" in result.text

    @pytest.mark.asyncio
    async def test_handler_no_registry(self) -> None:
        action = HelpCommandAction()
        result = await action.handler(_message("/help"), {})
        assert not result.success


# ── Status action ────────────────────────────────────────────────────────


class TestStatusAction:
    @pytest.mark.asyncio
    async def test_validate_positive(self) -> None:
        action = StatusCommandAction()
        assert await action.validate(_message("/status"), {})
        assert await action.validate(_message("/s"), {})

    @pytest.mark.asyncio
    async def test_validate_negative(self) -> None:
        action = StatusCommandAction()
        assert not await action.validate(_message("/help"), {})
        assert not await action.validate(_message("status check"), {})

    @pytest.mark.asyncio
    async def test_handler(self) -> None:
        action = StatusCommandAction()
        result = await action.handler(_message("/status"), {})
        assert result.success
        assert "**Session Status:**" in result.text
        assert "agent-456" in result.text
        assert "room-123" in result.text


# ── Stop action ──────────────────────────────────────────────────────────


class TestStopAction:
    @pytest.mark.asyncio
    async def test_validate_all_aliases(self) -> None:
        action = StopCommandAction()
        assert await action.validate(_message("/stop"), {})
        assert await action.validate(_message("/abort"), {})
        assert await action.validate(_message("/cancel"), {})

    @pytest.mark.asyncio
    async def test_validate_negative(self) -> None:
        action = StopCommandAction()
        assert not await action.validate(_message("please stop"), {})

    @pytest.mark.asyncio
    async def test_handler(self) -> None:
        action = StopCommandAction()
        result = await action.handler(_message("/stop"), {})
        assert result.success
        assert "Stop requested" in result.text


# ── Models action ────────────────────────────────────────────────────────


class TestModelsAction:
    @pytest.mark.asyncio
    async def test_validate(self) -> None:
        action = ModelsCommandAction()
        assert await action.validate(_message("/models"), {})
        assert not await action.validate(_message("/help"), {})
        assert not await action.validate(_message("show models"), {})

    @pytest.mark.asyncio
    async def test_handler_no_models(self) -> None:
        action = ModelsCommandAction()
        result = await action.handler(_message("/models"), {})
        assert result.success
        assert "**Available Models:**" in result.text
        assert "No model information available" in result.text

    @pytest.mark.asyncio
    async def test_handler_with_models(self) -> None:
        action = ModelsCommandAction()
        state = {
            "registered_model_types": ["text_large", "text_small"],
            "model_provider": "openai",
            "model_name": "gpt-4",
        }
        result = await action.handler(_message("/models"), state)
        assert result.success
        assert "Text (Large)" in result.text
        assert "Text (Small)" in result.text
        assert "Provider: openai" in result.text
        assert "Model: gpt-4" in result.text


# ── Commands list action ─────────────────────────────────────────────────


class TestCommandsListAction:
    @pytest.mark.asyncio
    async def test_validate(self) -> None:
        action = CommandsListAction()
        assert await action.validate(_message("/commands"), {})
        assert await action.validate(_message("/cmds"), {})
        assert not await action.validate(_message("/help"), {})
        assert not await action.validate(_message("list commands"), {})

    @pytest.mark.asyncio
    async def test_handler(self) -> None:
        action = CommandsListAction()
        reg = default_registry()
        result = await action.handler(_message("/commands"), {}, registry=reg)
        assert result.success
        assert "**Commands (5):**" in result.text
        assert "**help**" in result.text
        assert "**status**" in result.text
        assert "**stop**" in result.text

    @pytest.mark.asyncio
    async def test_handler_no_registry(self) -> None:
        action = CommandsListAction()
        result = await action.handler(_message("/commands"), {})
        assert not result.success


# ── Provider ─────────────────────────────────────────────────────────────


class TestCommandRegistryProvider:
    @pytest.mark.asyncio
    async def test_command_message(self) -> None:
        provider = CommandRegistryProvider()
        reg = default_registry()
        result = await provider.get(_message("/help"), {}, registry=reg)
        assert "slash command" in result.text
        assert result.values["isCommand"] is True

    @pytest.mark.asyncio
    async def test_normal_message(self) -> None:
        provider = CommandRegistryProvider()
        reg = default_registry()
        result = await provider.get(_message("hello there"), {}, registry=reg)
        assert result.text == ""
        assert result.values["isCommand"] is False
        assert result.values["commandCount"] == 5

    @pytest.mark.asyncio
    async def test_no_registry(self) -> None:
        provider = CommandRegistryProvider()
        result = await provider.get(_message("/help"), {})
        assert result.values["commandCount"] == 0


# ── Action metadata ──────────────────────────────────────────────────────


class TestActionMetadata:
    def test_action_names(self) -> None:
        assert HelpCommandAction().name == "HELP_COMMAND"
        assert StatusCommandAction().name == "STATUS_COMMAND"
        assert StopCommandAction().name == "STOP_COMMAND"
        assert ModelsCommandAction().name == "MODELS_COMMAND"
        assert CommandsListAction().name == "COMMANDS_LIST_COMMAND"

    def test_similes_are_slash_only(self) -> None:
        actions = [
            HelpCommandAction(),
            StatusCommandAction(),
            StopCommandAction(),
            ModelsCommandAction(),
            CommandsListAction(),
        ]
        for action in actions:
            for simile in action.similes:
                assert simile.startswith("/"), (
                    f"Simile '{simile}' for {action.name} should start with /"
                )

    def test_examples_not_empty(self) -> None:
        actions = [
            HelpCommandAction(),
            StatusCommandAction(),
            StopCommandAction(),
            ModelsCommandAction(),
            CommandsListAction(),
        ]
        for action in actions:
            assert len(action.examples) > 0, f"{action.name} should have examples"
