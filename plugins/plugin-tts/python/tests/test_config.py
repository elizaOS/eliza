"""Tests for TTS config management — mirrors TypeScript test coverage."""

from __future__ import annotations

import pytest

from elizaos_plugin_tts.config import (
    clear_tts_config,
    get_tts_config,
    set_tts_config,
    should_apply_tts,
)
from elizaos_plugin_tts.types import (
    DEFAULT_TTS_CONFIG,
    TtsAutoMode,
    TtsConfig,
    TtsProvider,
    TtsSessionConfig,
)

ROOM_ID = "test-room-config"


@pytest.fixture(autouse=True)
def _clean_room() -> None:
    """Ensure each test starts with a clean config."""
    clear_tts_config(ROOM_ID)


# =========================================================================
# getTtsConfig
# =========================================================================


class TestGetTtsConfig:
    def test_returns_default_config_for_new_room(self) -> None:
        config = get_tts_config(ROOM_ID)
        assert config.auto == DEFAULT_TTS_CONFIG.auto
        assert config.provider == DEFAULT_TTS_CONFIG.provider

    def test_returns_merged_config_for_room_with_overrides(self) -> None:
        set_tts_config(ROOM_ID, TtsSessionConfig(auto=TtsAutoMode.ALWAYS))
        config = get_tts_config(ROOM_ID)
        assert config.auto == TtsAutoMode.ALWAYS
        assert config.provider == DEFAULT_TTS_CONFIG.provider  # default preserved


# =========================================================================
# setTtsConfig
# =========================================================================


class TestSetTtsConfig:
    def test_sets_config_values(self) -> None:
        set_tts_config(
            ROOM_ID,
            TtsSessionConfig(auto=TtsAutoMode.INBOUND, provider=TtsProvider.EDGE),
        )
        config = get_tts_config(ROOM_ID)
        assert config.auto == TtsAutoMode.INBOUND
        assert config.provider == TtsProvider.EDGE

    def test_merges_with_existing_config(self) -> None:
        set_tts_config(ROOM_ID, TtsSessionConfig(auto=TtsAutoMode.ALWAYS))
        set_tts_config(ROOM_ID, TtsSessionConfig(provider=TtsProvider.OPENAI))
        config = get_tts_config(ROOM_ID)
        assert config.auto == TtsAutoMode.ALWAYS  # preserved
        assert config.provider == TtsProvider.OPENAI  # updated


# =========================================================================
# clearTtsConfig
# =========================================================================


class TestClearTtsConfig:
    def test_clears_config_for_room(self) -> None:
        set_tts_config(ROOM_ID, TtsSessionConfig(auto=TtsAutoMode.ALWAYS))
        clear_tts_config(ROOM_ID)
        config = get_tts_config(ROOM_ID)
        assert config.auto == DEFAULT_TTS_CONFIG.auto  # back to default


# =========================================================================
# shouldApplyTts
# =========================================================================


class TestShouldApplyTts:
    @staticmethod
    def _cfg(auto: TtsAutoMode) -> TtsConfig:
        return TtsConfig(
            provider=DEFAULT_TTS_CONFIG.provider,
            auto=auto,
            max_length=DEFAULT_TTS_CONFIG.max_length,
            summarize=DEFAULT_TTS_CONFIG.summarize,
        )

    def test_returns_false_when_auto_is_off(self) -> None:
        assert should_apply_tts(self._cfg(TtsAutoMode.OFF)) is False

    def test_returns_true_when_auto_is_always(self) -> None:
        assert should_apply_tts(self._cfg(TtsAutoMode.ALWAYS)) is True

    def test_respects_inbound_mode(self) -> None:
        cfg = self._cfg(TtsAutoMode.INBOUND)
        assert should_apply_tts(cfg) is False
        assert should_apply_tts(cfg, inbound_audio=False) is False
        assert should_apply_tts(cfg, inbound_audio=True) is True

    def test_respects_tagged_mode(self) -> None:
        cfg = self._cfg(TtsAutoMode.TAGGED)
        assert should_apply_tts(cfg) is False
        assert should_apply_tts(cfg, has_directive=False) is False
        assert should_apply_tts(cfg, has_directive=True) is True
