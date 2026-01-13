"""Tests for MemoryService."""

from uuid import uuid4

from elizaos_plugin_memory import (
    LongTermMemoryCategory,
    MemoryConfig,
    MemoryService,
)


class TestMemoryConfig:
    """Tests for MemoryConfig."""

    def test_default_values(self) -> None:
        """Test default configuration values."""
        config = MemoryConfig()

        assert config.short_term_summarization_threshold == 16
        assert config.short_term_retain_recent == 6
        assert config.short_term_summarization_interval == 10
        assert config.long_term_extraction_enabled is True
        assert config.long_term_vector_search_enabled is False
        assert config.long_term_confidence_threshold == 0.85
        assert config.long_term_extraction_threshold == 30
        assert config.long_term_extraction_interval == 10

    def test_custom_values(self) -> None:
        """Test custom configuration values."""
        config = MemoryConfig(
            short_term_summarization_threshold=20,
            long_term_extraction_enabled=False,
        )

        assert config.short_term_summarization_threshold == 20
        assert config.long_term_extraction_enabled is False


class TestMemoryService:
    """Tests for MemoryService."""

    def test_initialization(self) -> None:
        """Test service initialization."""
        service = MemoryService()

        assert service.service_type == "memory"
        assert service.config is not None

    def test_get_config_returns_copy(self) -> None:
        """Test that get_config returns a copy."""
        service = MemoryService()
        config1 = service.get_config()
        config2 = service.get_config()

        config1.short_term_summarization_threshold = 999
        assert config2.short_term_summarization_threshold != 999

    def test_update_config(self) -> None:
        """Test configuration update."""
        service = MemoryService()

        service.update_config(short_term_summarization_threshold=50)

        config = service.get_config()
        assert config.short_term_summarization_threshold == 50

    def test_increment_message_count(self) -> None:
        """Test message count increment."""
        service = MemoryService()
        room_id = uuid4()

        count1 = service.increment_message_count(room_id)
        count2 = service.increment_message_count(room_id)
        count3 = service.increment_message_count(room_id)

        assert count1 == 1
        assert count2 == 2
        assert count3 == 3

    def test_reset_message_count(self) -> None:
        """Test message count reset."""
        service = MemoryService()
        room_id = uuid4()

        service.increment_message_count(room_id)
        service.increment_message_count(room_id)
        service.reset_message_count(room_id)

        count = service.increment_message_count(room_id)
        assert count == 1


class TestLongTermMemoryCategory:
    """Tests for LongTermMemoryCategory."""

    def test_category_values(self) -> None:
        """Test category enum values."""
        assert LongTermMemoryCategory.EPISODIC.value == "episodic"
        assert LongTermMemoryCategory.SEMANTIC.value == "semantic"
        assert LongTermMemoryCategory.PROCEDURAL.value == "procedural"

    def test_category_from_string(self) -> None:
        """Test creating category from string."""
        category = LongTermMemoryCategory("semantic")
        assert category == LongTermMemoryCategory.SEMANTIC
