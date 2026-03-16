"""Tests for plugin-prose provider (ProseProvider)."""

from __future__ import annotations

import pytest

from elizaos_plugin_prose.providers.prose import ProseProvider
from elizaos_plugin_prose.services.prose_service import ProseService

from .conftest import make_message, make_state


class TestProseProviderMetadata:
    def test_name(self) -> None:
        provider = ProseProvider()
        assert provider.name == "prose"

    def test_description(self) -> None:
        provider = ProseProvider()
        assert "OpenProse" in provider.description

    def test_position(self) -> None:
        provider = ProseProvider()
        assert provider.position == 100


class TestProseProviderGet:
    @pytest.fixture()
    def provider(self) -> ProseProvider:
        return ProseProvider()

    @pytest.mark.asyncio
    async def test_non_prose_message_returns_available(self, provider: ProseProvider) -> None:
        msg = make_message("hello world")
        result = await provider.get(msg)
        assert "text" in result
        assert "OpenProse" in result["text"]
        assert result["values"]["available"] is True

    @pytest.mark.asyncio
    async def test_non_prose_with_active_run_id(self, provider: ProseProvider) -> None:
        msg = make_message("hello world")
        state = make_state(proseRunId="run-123")
        result = await provider.get(msg, state=state)
        # With an active run, should still return something meaningful
        assert "text" in result

    @pytest.mark.asyncio
    async def test_prose_help_message(self, provider: ProseProvider) -> None:
        msg = make_message("prose help")
        result = await provider.get(msg)
        assert "text" in result

    @pytest.mark.asyncio
    async def test_prose_run_message(self, provider: ProseProvider) -> None:
        msg = make_message("prose run test.prose")
        result = await provider.get(msg)
        assert "text" in result

    @pytest.mark.asyncio
    async def test_prose_compile_message(self, provider: ProseProvider) -> None:
        msg = make_message("prose compile test.prose")
        result = await provider.get(msg)
        assert "text" in result

    @pytest.mark.asyncio
    async def test_prose_examples_message(self, provider: ProseProvider) -> None:
        msg = make_message("prose examples")
        result = await provider.get(msg)
        assert "text" in result

    @pytest.mark.asyncio
    async def test_prose_syntax_message(self, provider: ProseProvider) -> None:
        msg = make_message("prose syntax")
        result = await provider.get(msg)
        assert "text" in result

    @pytest.mark.asyncio
    async def test_validate_prose_message(self, provider: ProseProvider) -> None:
        msg = make_message("validate my-workflow.prose")
        result = await provider.get(msg)
        assert "text" in result

    @pytest.mark.asyncio
    async def test_prose_update_message(self, provider: ProseProvider) -> None:
        msg = make_message("prose update")
        result = await provider.get(msg)
        assert "text" in result

    @pytest.mark.asyncio
    async def test_invalid_state_mode_falls_back(self, provider: ProseProvider) -> None:
        msg = make_message("prose run test.prose")
        state = make_state(proseStateMode="nonexistent")
        result = await provider.get(msg, state=state)
        # Should fall back to filesystem mode without error
        assert "text" in result

    @pytest.mark.asyncio
    async def test_with_explicit_service(self, provider: ProseProvider) -> None:
        svc = ProseService()
        msg = make_message("prose help")
        result = await provider.get(msg, service=svc)
        assert "text" in result

    @pytest.mark.asyncio
    async def test_help_with_populated_cache(
        self, provider: ProseProvider, populated_skill_cache: dict[str, str]
    ) -> None:
        svc = ProseService()
        msg = make_message("prose help")
        result = await provider.get(msg, service=svc)
        assert "text" in result

    @pytest.mark.asyncio
    async def test_compile_with_populated_cache(
        self, provider: ProseProvider, populated_skill_cache: dict[str, str]
    ) -> None:
        svc = ProseService()
        msg = make_message("prose compile test.prose")
        result = await provider.get(msg, service=svc)
        assert "text" in result
        assert "OpenProse VM" in result["text"]

    @pytest.mark.asyncio
    async def test_run_with_populated_cache(
        self, provider: ProseProvider, populated_skill_cache: dict[str, str]
    ) -> None:
        svc = ProseService()
        msg = make_message("prose run test.prose")
        result = await provider.get(msg, service=svc)
        assert "text" in result
        assert "OpenProse VM" in result["text"]
