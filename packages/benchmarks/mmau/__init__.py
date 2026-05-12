"""MMAU benchmark scaffold."""

from benchmarks.mmau.agent import (
    AgentFn,
    CascadedSTTAgent,
    MMAUAgentProtocol,
    OracleMMAUAgent,
    SttFn,
    format_mcq_prompt,
)
from benchmarks.mmau.dataset import MMAUDataset
from benchmarks.mmau.evaluator import (
    MMAUEvaluator,
    choice_letters,
    extract_answer_letter,
    extract_letter_from_option,
)
from benchmarks.mmau.runner import MMAURunner
from benchmarks.mmau.types import (
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
