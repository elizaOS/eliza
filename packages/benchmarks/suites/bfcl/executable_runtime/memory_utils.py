"""
Memory category utilities — vendored from upstream BFCL (Apache 2.0).

Source:
    https://github.com/ShishirPatil/gorilla
    berkeley-function-call-leaderboard/bfcl_eval/utils.py

Provides the small helpers that the MemoryAPI metaclass needs:
``is_first_memory_prereq_entry``, ``is_memory_prereq``,
``get_directory_structure_by_id``, plus the agentic substring checker
used to score the model's final response against ``possible_answer``.

Only the memory-related portions of upstream's much-larger ``utils.py`` are
vendored, since they are the only ones we depend on from the executable
runtime path. Pure functions, no side effects.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

# Path to the local memory-prereq conversation fixtures.
# Lives next to this module to keep the vendored layout self-contained.
_THIS_DIR = Path(__file__).resolve().parent
MEMORY_PREREQ_CONVERSATION_PATH: Path = _THIS_DIR / "memory_prereq_conversation"


# ---------------------------------------------------------------------------
# Identity / category predicates (verbatim from upstream).
# ---------------------------------------------------------------------------
def is_web_search(test_category: str) -> bool:
    return "web_search" in test_category


def is_memory(test_category: str) -> bool:
    return "memory" in test_category


def is_first_memory_prereq_entry(test_entry_id: str) -> bool:
    return "prereq" in test_entry_id and test_entry_id.endswith("-0")


def is_memory_prereq(test_category: str) -> bool:
    return "prereq" in test_category


def is_agentic(test_category: str) -> bool:
    return "web_search" in test_category or "memory" in test_category


def is_multi_turn(test_category: str) -> bool:
    return "multi_turn" in test_category


def extract_test_category_from_id(
    test_entry_id: str, remove_prereq: bool = False
) -> str:
    """Map ``memory_kv_3-finance-2`` -> ``memory_kv_3-finance``.

    When ``remove_prereq=True`` the ``_prereq`` suffix is stripped first.
    Verbatim from upstream's ``extract_test_category_from_id``.
    """
    if remove_prereq:
        test_entry_id = test_entry_id.replace("_prereq", "")
    if ":" in test_entry_id:
        test_entry_id = test_entry_id.split(":")[0]
    return test_entry_id.rsplit("_", 1)[0]


def extract_memory_backend_type(test_category: str) -> str:
    """``memory_kv`` -> ``kv``."""
    if not is_memory(test_category):
        raise ValueError(f"Test category {test_category} is not a memory category.")
    return test_category[len("memory_"):]


def get_general_grouping(test_id: str) -> str:
    """Map a test id to one of the high-level result groupings."""
    if is_agentic(test_id):
        return "agentic"
    if is_multi_turn(test_id):
        return "multi_turn"
    return "non_live"


def get_directory_structure_by_id(test_id: str) -> str:
    """Returns ``agentic/memory/kv`` for memory tests, ``agentic`` for
    web_search tests, etc. Used by the MemoryAPI snapshot folder layout.
    """
    group = get_general_grouping(test_id)
    if is_memory(test_id):
        return os.path.join(
            group,
            "memory",
            extract_memory_backend_type(
                extract_test_category_from_id(test_id, remove_prereq=True)
            ),
        )
    return group


# ---------------------------------------------------------------------------
# Agentic checker — vendored from upstream
# bfcl_eval/eval_checker/agentic_eval/agentic_checker.py
# ---------------------------------------------------------------------------
def _standardize_string(input_string: str) -> str:
    """Normalize whitespace + punctuation for substring matching.

    Strips ``,./-_*^()`` and lowercases.
    """
    regex_string = r"[\,\.\/\-\_\*\^\(\)]"
    return re.sub(regex_string, "", input_string).lower().replace("'", '"')


def agentic_checker(
    model_response: object, possible_answer_list: list[str]
) -> dict:
    """Substring-match the model response against any of the possible answers,
    ignoring case, whitespace, and ``,./-_*^()`` punctuation.

    Returns ``{"valid": True}`` on a hit, otherwise a structured failure with
    standardized strings for debugging.
    """
    standardized_possible_answer_list = [
        _standardize_string(possible_answer)
        for possible_answer in possible_answer_list
    ]
    if isinstance(model_response, list):
        model_response = model_response[0] if model_response else ""
    if not isinstance(model_response, str):
        model_response = str(model_response)

    standardized_model_response = _standardize_string(model_response)

    for possible_answer in standardized_possible_answer_list:
        if re.search(
            rf"\b{re.escape(possible_answer)}\b",
            standardized_model_response,
        ):
            return {"valid": True, "error": []}

    return {
        "valid": False,
        "error_message": "None of the expected answers were found in the model response.",
        "error_type": "agentic:answer_not_found",
        "details": {
            "model_response": model_response,
            "possible_answers": possible_answer_list,
            "standardized_model_response": standardized_model_response,
            "standardized_possible_answers": standardized_possible_answer_list,
        },
    }


__all__ = [
    "MEMORY_PREREQ_CONVERSATION_PATH",
    "agentic_checker",
    "extract_memory_backend_type",
    "extract_test_category_from_id",
    "get_directory_structure_by_id",
    "is_agentic",
    "is_first_memory_prereq_entry",
    "is_memory",
    "is_memory_prereq",
    "is_multi_turn",
    "is_web_search",
]
