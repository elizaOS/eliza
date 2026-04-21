"""Tests for the advanced memory module.

Covers XML parsing, extraction checkpointing, config management,
confidence sorting, and formatted memory output.
"""

from __future__ import annotations

from uuid import uuid4

import pytest  # type: ignore[import-not-found]

from .memory_service import (
    MemoryService,
    _parse_memory_extraction_xml,
    _parse_summary_xml,
    _top_k_by_confidence,
)
from .types import (
    LongTermMemory,
    LongTermMemoryCategory,
)

# ============================================================================
# XML Parsing: Summary
# ============================================================================


class TestParseSummaryXml:
    def test_valid_xml(self):
        xml = """
<summary>
  <text>The user discussed their favorite coffee.</text>
  <topics>coffee, preferences, beverages</topics>
  <key_points>
    <point>User prefers dark roast</point>
    <point>User drinks 3 cups daily</point>
  </key_points>
</summary>"""
        result = _parse_summary_xml(xml)
        assert result.summary == "The user discussed their favorite coffee."
        assert result.topics == ["coffee", "preferences", "beverages"]
        assert len(result.key_points) == 2
        assert result.key_points[0] == "User prefers dark roast"
        assert result.key_points[1] == "User drinks 3 cups daily"

    def test_malformed_xml(self):
        result = _parse_summary_xml("This is not XML at all")
        assert result.summary == "Summary not available"
        assert result.topics == []
        assert result.key_points == []

    def test_partial_tags(self):
        result = _parse_summary_xml("<text>Just a summary</text>")
        assert result.summary == "Just a summary"
        assert result.topics == []
        assert result.key_points == []

    def test_empty_topics(self):
        result = _parse_summary_xml("<text>Summary here</text><topics></topics>")
        assert result.summary == "Summary here"
        assert result.topics == []


# ============================================================================
# XML Parsing: Memory Extraction
# ============================================================================


class TestParseMemoryExtractionXml:
    def test_valid_multiple(self):
        xml = """
<memories>
  <memory>
    <category>semantic</category>
    <content>User works as a software engineer</content>
    <confidence>0.95</confidence>
  </memory>
  <memory>
    <category>episodic</category>
    <content>User had a meeting yesterday</content>
    <confidence>0.8</confidence>
  </memory>
  <memory>
    <category>procedural</category>
    <content>User prefers TypeScript for backend</content>
    <confidence>0.9</confidence>
  </memory>
</memories>"""
        extractions = _parse_memory_extraction_xml(xml)
        assert len(extractions) == 3
        assert extractions[0].category == LongTermMemoryCategory.SEMANTIC
        assert extractions[0].content == "User works as a software engineer"
        assert abs(extractions[0].confidence - 0.95) < 0.001
        assert extractions[1].category == LongTermMemoryCategory.EPISODIC
        assert extractions[2].category == LongTermMemoryCategory.PROCEDURAL

    def test_invalid_category_skipped(self):
        xml = """
<memories>
  <memory>
    <category>invalid_type</category>
    <content>This should be skipped</content>
    <confidence>0.9</confidence>
  </memory>
  <memory>
    <category>semantic</category>
    <content>This should be kept</content>
    <confidence>0.85</confidence>
  </memory>
</memories>"""
        extractions = _parse_memory_extraction_xml(xml)
        assert len(extractions) == 1
        assert extractions[0].content == "This should be kept"

    def test_bad_confidence_skipped(self):
        xml = """
<memory>
  <category>semantic</category>
  <content>Bad confidence</content>
  <confidence>not_a_number</confidence>
</memory>"""
        extractions = _parse_memory_extraction_xml(xml)
        assert len(extractions) == 0

    def test_empty_input(self):
        assert _parse_memory_extraction_xml("") == []

    def test_no_memories(self):
        assert _parse_memory_extraction_xml("The model didn't return structured data.") == []


# ============================================================================
# top_k_by_confidence
# ============================================================================


class TestTopKByConfidence:
    def test_sorts_by_confidence(self):
        entity_id = uuid4()
        agent_id = uuid4()
        memories = [
            LongTermMemory(
                id=uuid4(),
                agent_id=agent_id,
                entity_id=entity_id,
                category=LongTermMemoryCategory.SEMANTIC,
                content="low",
                confidence=0.5,
            ),
            LongTermMemory(
                id=uuid4(),
                agent_id=agent_id,
                entity_id=entity_id,
                category=LongTermMemoryCategory.SEMANTIC,
                content="high",
                confidence=0.95,
            ),
            LongTermMemory(
                id=uuid4(),
                agent_id=agent_id,
                entity_id=entity_id,
                category=LongTermMemoryCategory.SEMANTIC,
                content="mid",
                confidence=0.8,
            ),
        ]
        result = _top_k_by_confidence(memories, 2)
        assert len(result) == 2
        assert result[0].content == "high"
        assert result[1].content == "mid"

    def test_zero_limit(self):
        entity_id = uuid4()
        agent_id = uuid4()
        memories = [
            LongTermMemory(
                id=uuid4(),
                agent_id=agent_id,
                entity_id=entity_id,
                category=LongTermMemoryCategory.SEMANTIC,
                content="x",
                confidence=0.9,
            ),
        ]
        assert _top_k_by_confidence(memories, 0) == []

    def test_empty_list(self):
        assert _top_k_by_confidence([], 5) == []


# ============================================================================
# Config Management
# ============================================================================


class TestConfigManagement:
    def test_defaults_are_sensible(self):
        svc = MemoryService()
        config = svc.get_config()
        assert config.short_term_summarization_threshold > 0
        assert config.long_term_extraction_threshold > 0
        assert config.long_term_extraction_interval > 0
        assert config.long_term_confidence_threshold > 0.0

    def test_get_config_returns_copy(self):
        svc = MemoryService()
        c1 = svc.get_config()
        c1.short_term_summarization_threshold = 99999
        c2 = svc.get_config()
        assert c2.short_term_summarization_threshold != 99999

    def test_update_config_partial(self):
        svc = MemoryService()
        original = svc.get_config()
        svc._config.short_term_summarization_threshold = 999
        updated = svc.get_config()
        assert updated.short_term_summarization_threshold == 999
        # Other fields preserved
        assert updated.long_term_extraction_threshold == original.long_term_extraction_threshold
        assert updated.long_term_extraction_interval == original.long_term_extraction_interval


# ============================================================================
# Extraction Checkpointing
# ============================================================================


class TestExtractionCheckpointing:
    @pytest.mark.asyncio
    async def test_below_threshold_does_not_run(self):
        svc = MemoryService()
        entity = uuid4()
        room = uuid4()
        assert not await svc.should_run_extraction(entity, room, 1)

    @pytest.mark.asyncio
    async def test_at_threshold_runs_first_time(self):
        svc = MemoryService()
        config = svc.get_config()
        entity = uuid4()
        room = uuid4()
        assert await svc.should_run_extraction(entity, room, config.long_term_extraction_threshold)

    @pytest.mark.asyncio
    async def test_checkpoint_prevents_rerun(self):
        svc = MemoryService()
        config = svc.get_config()
        threshold = config.long_term_extraction_threshold
        entity = uuid4()
        room = uuid4()
        await svc.set_last_extraction_checkpoint(entity, room, threshold)
        assert not await svc.should_run_extraction(entity, room, threshold)

    @pytest.mark.asyncio
    async def test_next_interval_runs(self):
        svc = MemoryService()
        config = svc.get_config()
        threshold = config.long_term_extraction_threshold
        interval = config.long_term_extraction_interval
        entity = uuid4()
        room = uuid4()
        await svc.set_last_extraction_checkpoint(entity, room, threshold)
        assert await svc.should_run_extraction(entity, room, threshold + interval)

    @pytest.mark.asyncio
    async def test_independent_entity_room_pairs(self):
        svc = MemoryService()
        config = svc.get_config()
        threshold = config.long_term_extraction_threshold
        entity_a = uuid4()
        entity_b = uuid4()
        room = uuid4()
        await svc.set_last_extraction_checkpoint(entity_a, room, threshold)
        # entity_b should still be eligible
        assert await svc.should_run_extraction(entity_b, room, threshold)
        # entity_a should not
        assert not await svc.should_run_extraction(entity_a, room, threshold)


# ============================================================================
# Formatted Memory Output
# ============================================================================


class TestFormattedLongTermMemories:
    @pytest.mark.asyncio
    async def test_groups_by_category(self):
        svc = MemoryService()
        entity_id = uuid4()
        agent_id = uuid4()

        # Manually inject memories into fallback storage
        key = str(entity_id)
        svc._long_term[key] = [
            LongTermMemory(
                id=uuid4(),
                agent_id=agent_id,
                entity_id=entity_id,
                category=LongTermMemoryCategory.SEMANTIC,
                content="Likes coffee",
                confidence=0.9,
            ),
            LongTermMemory(
                id=uuid4(),
                agent_id=agent_id,
                entity_id=entity_id,
                category=LongTermMemoryCategory.EPISODIC,
                content="Had meeting",
                confidence=0.85,
            ),
            LongTermMemory(
                id=uuid4(),
                agent_id=agent_id,
                entity_id=entity_id,
                category=LongTermMemoryCategory.SEMANTIC,
                content="Prefers dark mode",
                confidence=0.88,
            ),
        ]

        result = await svc.get_formatted_long_term_memories(entity_id)
        assert "**Semantic**:" in result
        assert "**Episodic**:" in result
        assert "- Likes coffee" in result
        assert "- Prefers dark mode" in result
        assert "- Had meeting" in result

    @pytest.mark.asyncio
    async def test_empty_returns_empty_string(self):
        svc = MemoryService()
        entity_id = uuid4()
        result = await svc.get_formatted_long_term_memories(entity_id)
        assert result == ""

    @pytest.mark.asyncio
    async def test_single_category(self):
        svc = MemoryService()
        entity_id = uuid4()
        agent_id = uuid4()

        svc._long_term[str(entity_id)] = [
            LongTermMemory(
                id=uuid4(),
                agent_id=agent_id,
                entity_id=entity_id,
                category=LongTermMemoryCategory.PROCEDURAL,
                content="Knows how to ride a bike",
                confidence=0.95,
            ),
        ]

        result = await svc.get_formatted_long_term_memories(entity_id)
        assert "**Procedural**:" in result
        assert "- Knows how to ride a bike" in result
        assert "**Semantic**:" not in result
        assert "**Episodic**:" not in result
