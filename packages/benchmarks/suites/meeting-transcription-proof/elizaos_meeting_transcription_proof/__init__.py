"""Meeting transcription proof benchmark package."""

from .cli import build_report, main, validate_manifest
from .dataset_adapters import build_adapter_contract, validate_adapter_contract
from .network_qoe_adapters import (
    build_qoe_adapter_contract,
    validate_qoe_adapter_contract,
)
from .meeting_scoring import (
    compare_to_baseline,
    diarization_error_rate,
    score_transcript,
    word_error_rate,
)
from .zoom_vtt import parse_zoom_vtt

__all__ = [
    "build_report",
    "main",
    "validate_manifest",
    "build_adapter_contract",
    "validate_adapter_contract",
    "build_qoe_adapter_contract",
    "validate_qoe_adapter_contract",
    "parse_zoom_vtt",
    "score_transcript",
    "compare_to_baseline",
    "word_error_rate",
    "diarization_error_rate",
]
