"""Compatibility shim for the renamed Audio MMAU package."""

from ._compat import ensure_mmau_audio_path

ensure_mmau_audio_path()

from elizaos_mmau_audio.agent import (
    AgentFn,
    CascadedSTTAgent,
    MMAUAgentProtocol,
    OracleMMAUAgent,
    SttFn,
    format_mcq_prompt,
)
from elizaos_mmau_audio.dataset import MMAUDataset
from elizaos_mmau_audio.evaluator import (
    MMAUEvaluator,
    choice_letters,
    extract_answer_letter,
    extract_letter_from_option,
)
from elizaos_mmau_audio.runner import MMAURunner
from elizaos_mmau_audio.types import (
    MMAU_CATEGORIES,
    MMAUCategory,
    MMAUConfig,
    MMAUPrediction,
    MMAUReport,
    MMAUResult,
    MMAUSample,
    MMAUSplit,
)

__all__ = [
    "MMAU_CATEGORIES",
    "AgentFn",
    "CascadedSTTAgent",
    "MMAUAgentProtocol",
    "MMAUCategory",
    "MMAUConfig",
    "MMAUDataset",
    "MMAUEvaluator",
    "MMAUPrediction",
    "MMAUReport",
    "MMAUResult",
    "MMAURunner",
    "MMAUSample",
    "MMAUSplit",
    "OracleMMAUAgent",
    "SttFn",
    "choice_letters",
    "extract_answer_letter",
    "extract_letter_from_option",
    "format_mcq_prompt",
]
