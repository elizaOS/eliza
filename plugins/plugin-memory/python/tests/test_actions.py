"""Tests for the memory plugin actions, types, and providers."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from elizaos_plugin_memory.actions.forget import forget_action
from elizaos_plugin_memory.actions.recall import recall_action
from elizaos_plugin_memory.actions.remember import remember_action
from elizaos_plugin_memory.providers.memory_context import memory_context_provider
from elizaos_plugin_memory.types import (
    MEMORY_METADATA_SEPARATOR,
    MEMORY_SOURCE,
    MemoryImportance,
    decode_memory_text,
    encode_memory_text,
)


# --- Type Encoding / Decoding ---


class TestEncoding:
    def test_encode_decode_roundtrip(self) -> None:
        content = "My favorite color is blue"
        tags = ["preference", "color"]
        importance = MemoryImportance.HIGH

        encoded = encode_memory_text(content, tags, importance)
        decoded = decode_memory_text(encoded)

        assert decoded.content == content
        assert decoded.tags == tags
        assert decoded.importance == importance

    def test_decode_plain_text(self) -> None:
        text = "Just some text without metadata"
        decoded = decode_memory_text(text)

        assert decoded.content == text
        assert decoded.tags == []
        assert decoded.importance == MemoryImportance.NORMAL

    def test_decode_malformed_metadata(self) -> None:
        text = f"not-valid-json{MEMORY_METADATA_SEPARATOR}actual content"
        decoded = decode_memory_text(text)

        assert decoded.content == text
        assert decoded.tags == []
        assert decoded.importance == MemoryImportance.NORMAL

    def test_encode_empty_tags(self) -> None:
        encoded = encode_memory_text("test", [], MemoryImportance.LOW)
        decoded = decode_memory_text(encoded)

        assert decoded.content == "test"
        assert decoded.tags == []
        assert decoded.importance == MemoryImportance.LOW

    def test_all_importance_levels(self) -> None:
        for importance in MemoryImportance:
            encoded = encode_memory_text("test", [], importance)
            decoded = decode_memory_text(encoded)
            assert decoded.importance == importance

    def test_special_characters(self) -> None:
        content = 'Content with "quotes" and\nnewlines and {braces}'
        encoded = encode_memory_text(content, ["special"], MemoryImportance.NORMAL)
        decoded = decode_memory_text(encoded)
        assert decoded.content == content


# --- Mock Runtime (aligned with runtime DB API) ---


class MockRuntime:
    def __init__(
        self,
        memories: list[dict] | None = None,
        model_response: str | None = None,
    ) -> None:
        self._memories = memories or []
        self._model_response = model_response
        self.agent_id = "test-agent"
        self.create_memory = AsyncMock(return_value="mem-uuid")
        self.delete_memory = AsyncMock()

    async def get_memories(self, params: dict) -> list[dict]:
        return self._memories

    def get_setting(self, key: str) -> str | None:
        return None

    def get_service(self, name: str) -> object | None:
        return None

    async def use_model(self, model_type: str, params: dict) -> str | None:
        return self._model_response


# --- REMEMBER Action ---


class TestRememberAction:
    def test_metadata(self) -> None:
        assert remember_action.name == "REMEMBER"
        assert remember_action.description
        assert "remember" in remember_action.similes
        assert len(remember_action.examples) > 0

    @pytest.mark.asyncio
    async def test_validate_with_create_memory(self) -> None:
        runtime = MockRuntime()
        result = await remember_action.validate(runtime, {"content": {"text": "test"}})
        assert result is True

    @pytest.mark.asyncio
    async def test_validate_without_create_memory(self) -> None:
        runtime = MockRuntime()
        del runtime.create_memory
        result = await remember_action.validate(runtime, {"content": {"text": "test"}})
        assert result is False

    @pytest.mark.asyncio
    async def test_store_memory(self) -> None:
        runtime = MockRuntime(
            model_response='{"memory": "User likes dark mode", "tags": ["preference"], "importance": 2}',
        )
        message = {
            "agentId": "a1",
            "roomId": "r1",
            "userId": "u1",
            "content": {"text": "I like dark mode"},
        }

        result = await remember_action.handler(runtime, message)
        assert result["success"] is True
        assert "Remembered" in result["text"]
        runtime.create_memory.assert_called_once()


# --- RECALL Action ---


class TestRecallAction:
    def test_metadata(self) -> None:
        assert recall_action.name == "RECALL"
        assert recall_action.description
        assert "recall" in recall_action.similes

    @pytest.mark.asyncio
    async def test_no_memories(self) -> None:
        runtime = MockRuntime(memories=[])
        message = {"roomId": "r1", "content": {"text": "what do you remember?"}}

        result = await recall_action.handler(runtime, message)
        assert result["success"] is True
        assert "don't have any stored memories" in result["text"]

    @pytest.mark.asyncio
    async def test_find_matching_memory(self) -> None:
        encoded = encode_memory_text("Favorite color is blue", ["preference"], MemoryImportance.NORMAL)
        memories = [
            {
                "id": "m1",
                "agentId": "a1",
                "roomId": "r1",
                "content": {"text": encoded, "source": MEMORY_SOURCE},
                "createdAt": 1700000000000,
            }
        ]
        runtime = MockRuntime(memories=memories)
        message = {"roomId": "r1", "content": {"text": "color"}}

        result = await recall_action.handler(runtime, message)
        assert result["success"] is True
        assert "Found 1 memory" in result["text"]
        assert "Favorite color is blue" in result["text"]


# --- FORGET Action ---


class TestForgetAction:
    def test_metadata(self) -> None:
        assert forget_action.name == "FORGET"
        assert forget_action.description
        assert "forget" in forget_action.similes

    @pytest.mark.asyncio
    async def test_remove_by_id(self) -> None:
        runtime = MockRuntime()
        message = {"roomId": "r1", "content": {"text": "forget this"}}
        options = {"memoryId": "mem-123"}

        result = await forget_action.handler(runtime, message, None, options)
        assert result["success"] is True
        runtime.delete_memory.assert_called_once_with("mem-123")

    @pytest.mark.asyncio
    async def test_no_memories_to_remove(self) -> None:
        runtime = MockRuntime(memories=[])
        message = {"roomId": "r1", "content": {"text": "forget about colors"}}

        result = await forget_action.handler(runtime, message)
        assert result["success"] is True
        assert "No stored memories" in result["text"]


# --- Memory Context Provider ---


class TestMemoryContextProvider:
    def test_metadata(self) -> None:
        assert memory_context_provider.name == "MEMORY_CONTEXT"
        assert memory_context_provider.description

    @pytest.mark.asyncio
    async def test_empty_store(self) -> None:
        runtime = MockRuntime(memories=[])
        message = {"roomId": "r1", "content": {"text": ""}}

        result = await memory_context_provider.get(runtime, message, {})
        assert "No stored memories" in result.text

    @pytest.mark.asyncio
    async def test_with_memories(self) -> None:
        encoded = encode_memory_text("Test memory", ["test"], MemoryImportance.HIGH)
        memories = [
            {
                "id": "m1",
                "content": {"text": encoded, "source": MEMORY_SOURCE},
                "createdAt": 1000,
            }
        ]
        runtime = MockRuntime(memories=memories)
        message = {"roomId": "r1", "content": {"text": ""}}

        result = await memory_context_provider.get(runtime, message, {})
        assert "Stored Memories (1)" in result.text
        assert "Test memory" in result.text

    @pytest.mark.asyncio
    async def test_sorted_by_importance(self) -> None:
        low = encode_memory_text("Low item", [], MemoryImportance.LOW)
        high = encode_memory_text("High item", [], MemoryImportance.HIGH)
        memories = [
            {"id": "m1", "content": {"text": low, "source": MEMORY_SOURCE}, "createdAt": 1000},
            {"id": "m2", "content": {"text": high, "source": MEMORY_SOURCE}, "createdAt": 2000},
        ]
        runtime = MockRuntime(memories=memories)
        message = {"roomId": "r1", "content": {"text": ""}}

        result = await memory_context_provider.get(runtime, message, {})
        high_idx = result.text.index("High item")
        low_idx = result.text.index("Low item")
        assert high_idx < low_idx
