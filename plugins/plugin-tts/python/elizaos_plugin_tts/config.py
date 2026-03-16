"""TTS configuration management.

Maintains per-session TTS settings that override defaults.
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Optional

from elizaos_plugin_tts.types import (
    DEFAULT_TTS_CONFIG,
    TtsApplyKind,
    TtsAutoMode,
    TtsConfig,
    TtsProvider,
    TtsSessionConfig,
)

# ---------------------------------------------------------------------------
# Session config store (in-memory, keyed by room / session ID)
# ---------------------------------------------------------------------------

_session_configs: dict[str, dict[str, object]] = {}


def get_tts_config(room_id: str) -> TtsConfig:
    """Get the merged TTS configuration for *room_id*.

    Returns defaults merged with any per-session overrides.
    """
    session = _session_configs.get(room_id, {})
    defaults = asdict(DEFAULT_TTS_CONFIG)
    merged = {**defaults, **{k: v for k, v in session.items() if v is not None}}
    return TtsConfig(**merged)


def set_tts_config(room_id: str, config: TtsSessionConfig) -> None:
    """Set (merge) TTS configuration for *room_id*."""
    existing = _session_configs.get(room_id, {})
    updates = {k: v for k, v in asdict(config).items() if v is not None}
    existing.update(updates)
    _session_configs[room_id] = existing


def clear_tts_config(room_id: str) -> None:
    """Clear all TTS configuration for *room_id*."""
    _session_configs.pop(room_id, None)


def should_apply_tts(
    config: TtsConfig,
    *,
    inbound_audio: bool = False,
    kind: Optional[TtsApplyKind] = None,
    has_directive: bool = False,
) -> bool:
    """Determine whether TTS should be applied given *config* and context.

    Modes:
    - ``off``      — never apply
    - ``always``   — always apply
    - ``inbound``  — only when the inbound message had audio
    - ``tagged``   — only when a ``[[tts]]`` directive is present
    """
    auto = config.auto

    if auto == TtsAutoMode.OFF:
        return False

    if auto == TtsAutoMode.ALWAYS:
        return True

    if auto == TtsAutoMode.INBOUND:
        return bool(inbound_audio)

    if auto == TtsAutoMode.TAGGED:
        return bool(has_directive)

    return False
