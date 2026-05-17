"""elizaOS runtime phase mapping — single source of truth.

Every training record must map to one of the four runtime phases the
runtime exercises per turn (see docs/dataset/RUNTIME_PHASES.md):

    1  should_respond
    2  response       (planner / messageHandler)
    3  action         (per-action handler LLM call)
    4  evaluation     (post-turn evaluator)

Anything else is OUT_OF_BAND and must be transformed or dropped per
docs/dataset/COVERAGE_AUDIT.md before it reaches the SFT mix.

This module is the dependency for both `classify_records_by_phase.py`
and the OOB acceptance gate in `pack_dataset.py`.
"""

from __future__ import annotations


PHASE_1_SHOULD_RESPOND: frozenset[str] = frozenset({
    "should_respond",
    "should_respond_with_context",
    "dialogue_routing",
    "multiparty_should_respond",
    "should_mute_room",
    "should_unmute_room",
    "should_follow_room",
    "should_unfollow_room",
    "context_routing",
})


PHASE_2_RESPONSE: frozenset[str] = frozenset({
    "message_handler",
    "agent_trace",
    "reply",
    "casual_reply",
    "tool_call",
    "mcp_tool_call",
    "mcp_routing",
    "shell_command",
    "mobile_action",
    "scam_defense",
    "multi_step_decision",
    "message_classifier",
    "n8n_workflow_generation",
})


PHASE_3_ACTION: frozenset[str] = frozenset({
    "add_contact",
    "remove_contact",
    "choose_option",
    "extract_option",
    "extract_secrets",
    "extract_secret_operation",
    "extract_secret_request",
    "image_description",
    "image_generation",
    "post_creation",
    "post_action_decision",
    "autonomy_decide",
    "autonomy_summary",
    "autonomy_choose",
    "autonomy_evaluate",
})


PHASE_4_EVALUATION: frozenset[str] = frozenset({
    "reflection",
    "reflection_evaluator",
    "fact_extraction",
    "fact_extractor",
    "summarization",
    "initial_summarization",
    "relationship_extraction",
    "skill_extraction",
    "skill_refinement",
    "long_term_extraction",
})


# task_types we KNOW are OOB and must be dropped or transformed
KNOWN_OOB: frozenset[str] = frozenset({
    "reasoning_cot",
    "claude_distill",
    "abliteration_harmful",
    "abliteration_harmless",
    "dataset",
    "prompt_entry",
})


PHASE_OOB = "OOB"


def classify_phase(task_type: str | None) -> str:
    """Return the runtime phase for a given task_type.

    Returns one of: "1", "2", "3", "4", "OOB".
    """
    if not task_type:
        return PHASE_OOB
    tt = task_type.strip().lower()
    if tt in PHASE_1_SHOULD_RESPOND:
        return "1"
    if tt in PHASE_2_RESPONSE:
        return "2"
    if tt in PHASE_3_ACTION:
        return "3"
    if tt in PHASE_4_EVALUATION:
        return "4"
    return PHASE_OOB


def is_in_band(task_type: str | None) -> bool:
    """True iff the task_type maps to one of the four runtime phases."""
    return classify_phase(task_type) != PHASE_OOB
