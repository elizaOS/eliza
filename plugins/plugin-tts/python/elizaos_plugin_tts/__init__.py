"""elizaOS TTS Plugin — text-to-speech coordinator with multi-provider support."""

from elizaos_plugin_tts.config import (
    clear_tts_config,
    get_tts_config,
    set_tts_config,
    should_apply_tts,
)
from elizaos_plugin_tts.directives import (
    JsonVoiceDirectiveResult,
    get_tts_text,
    has_tts_directive,
    normalize_provider,
    parse_json_voice_directive,
    parse_tts_directive,
    strip_tts_directives,
)
from elizaos_plugin_tts.plugin import (
    PLUGIN_CONFIG,
    PLUGIN_DESCRIPTION,
    PLUGIN_NAME,
    format_tts_config,
    get_best_provider,
    is_provider_available,
    synthesize,
)
from elizaos_plugin_tts.text_processor import (
    clean_text_for_tts,
    process_text_for_tts,
    summarize_for_tts,
    truncate_text,
)
from elizaos_plugin_tts.types import (
    DEFAULT_TTS_CONFIG,
    TTS_PROVIDER_API_KEYS,
    TTS_PROVIDER_PRIORITY,
    TtsApplyKind,
    TtsAudioFormat,
    TtsAutoMode,
    TtsConfig,
    TtsDirective,
    TtsProvider,
    TtsRequest,
    TtsResult,
    TtsSessionConfig,
)

__version__ = "1.0.0"

__all__ = [
    # Types
    "TtsProvider",
    "TtsAutoMode",
    "TtsApplyKind",
    "TtsAudioFormat",
    "TtsConfig",
    "TtsDirective",
    "TtsRequest",
    "TtsResult",
    "TtsSessionConfig",
    "DEFAULT_TTS_CONFIG",
    "TTS_PROVIDER_PRIORITY",
    "TTS_PROVIDER_API_KEYS",
    # Directives
    "has_tts_directive",
    "parse_tts_directive",
    "parse_json_voice_directive",
    "JsonVoiceDirectiveResult",
    "normalize_provider",
    "strip_tts_directives",
    "get_tts_text",
    # Text processing
    "clean_text_for_tts",
    "truncate_text",
    "summarize_for_tts",
    "process_text_for_tts",
    # Config
    "get_tts_config",
    "set_tts_config",
    "clear_tts_config",
    "should_apply_tts",
    # Plugin
    "PLUGIN_NAME",
    "PLUGIN_DESCRIPTION",
    "PLUGIN_CONFIG",
    "format_tts_config",
    "is_provider_available",
    "get_best_provider",
    "synthesize",
]
