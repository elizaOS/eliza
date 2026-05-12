"""Audit normalized records against canonical elizaOS pipeline-stage schemas.

Reads every line under ``data/normalized/*.jsonl`` (skipping ``.errors.jsonl``),
JSON-decodes each ``expectedResponse``, then checks the decoded shape against
the schema documented in ``previews/PIPELINE_SCHEMAS.md`` for the record's
``metadata.task_type``.

Outputs:

- ``previews/PIPELINE_AUDIT.md``  — per-task_type conformance summary.
- ``previews/pipeline_audit.json`` — raw audit data with mismatch reasons
                                    and example records.

Usage:

    uv run python scripts/audit_pipeline_shapes.py
    uv run python scripts/audit_pipeline_shapes.py --sample 5000
    uv run python scripts/audit_pipeline_shapes.py --only agent-trove
"""

from __future__ import annotations

import argparse
import collections
import json
import logging
import re
import sys
from pathlib import Path
from typing import Any, Iterator

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from lib.runtime_phases import classify_phase, PHASE_OOB  # noqa: E402

log = logging.getLogger("audit")


# ─────────────────────────── per-stage validators ────────────────────────────

# task_types whose canonical envelope is the planner (5-key) document.
PLANNER_TASK_TYPES = {
    "agent_trace",
    "tool_call",
    "mcp_tool_call",
    "shell_command",
    "n8n_workflow_generation",
    "scam_defense",
    "mcp_routing",
}

# task_types where the slim {thought, text} or planner envelope are both OK.
REPLY_OR_PLANNER_TASK_TYPES = {"reply"}

# task_types where the slim {thought, text} or {text} reply form is canonical.
REPLY_SLIM_TASK_TYPES = {"reasoning_cot"}

# task_types using the shouldRespond classifier schema.
SHOULD_RESPOND_TASK_TYPES = {
    "should_respond",
    "should_respond_with_context",
    "context_routing",
}

# task_types using the (legacy) reflection scoring schema. The newer
# `reflection_evaluator` is validated by validate_reflection_evaluator below.
REFLECTION_TASK_TYPES = {"reflection"}

# Phase-4 evaluator task_types validated by dedicated functions.
FACT_EXTRACTOR_TASK_TYPES = {"fact_extractor", "fact_extraction"}
REFLECTION_EVALUATOR_TASK_TYPES = {"reflection_evaluator"}
SUMMARIZATION_TASK_TYPES = {"summarization", "initial_summarization"}
LONG_TERM_EXTRACTION_TASK_TYPES = {"long_term_extraction"}

# Phase-3 per-action templates handled by validate_action_specific.
ACTION_SPECIFIC_TASK_TYPES = {
    "add_contact",
    "remove_contact",
    "choose_option",
    "extract_option",
    "extract_secrets",
    "extract_secret_operation",
    "extract_secret_request",
    "post_creation",
    "post_action_decision",
}

# Allowed enums.
FACT_OP_TYPES = {"add_durable", "add_current", "strengthen", "decay", "contradict"}
LTM_CATEGORIES = {"episodic", "semantic", "procedural"}
LTM_MIN_CONFIDENCE = 0.85

PLANNER_KEYS = {"thought", "actions", "providers", "text", "simple"}
REPLY_KEYS = {"thought", "text"}
REPLY_KEYS_SLIM = {"text"}
SHOULD_RESPOND_REQUIRED = {
    "name",
    "reasoning",
    "action",
    "primaryContext",
    "secondaryContexts",
    "evidenceTurnIds",
}
SHOULD_RESPOND_OPTIONAL = {"speak_up", "hold_back"}
SHOULD_RESPOND_ACTIONS = {"RESPOND", "IGNORE", "STOP"}

# Modern (preferred) tool-call carrier inside planner.params.
ACCEPTED_PLANNER_PARAM_KEYS = {"workflow", "tool", "arguments", "command", "cwd",
                                "explanation", "params"}


def _is_str(v: Any) -> bool:
    return isinstance(v, str)


def _is_bool(v: Any) -> bool:
    return isinstance(v, bool)


def _is_list_or_csv_str(v: Any) -> bool:
    return isinstance(v, list) or isinstance(v, str)


def _action_is_valid(entry: Any) -> tuple[bool, str]:
    """Validate a single planner `actions[]` entry.

    Returns (ok, reason).
    """
    if isinstance(entry, str):
        return (entry.strip() != "", "" if entry.strip() else "empty_action_string")
    if not isinstance(entry, dict):
        return (False, f"action_not_string_or_dict({type(entry).__name__})")
    extra = set(entry.keys()) - {"name", "params"}
    if extra:
        return (False, f"action_extra_keys({sorted(extra)[0]})")
    name = entry.get("name")
    if not isinstance(name, str) or not name.strip():
        return (False, "action_missing_name")
    if name != name.upper():
        # Lowercase action names are common in the corpus (e.g. tool names like
        # `get_weather`). Runtime aliases handle this but it's flagged.
        return (False, "action_name_lowercase")
    return (True, "")


def validate_planner(decoded: Any) -> list[str]:
    """Validate a planner-envelope record. Returns a list of mismatch reasons.

    Empty list means fully conformant. We accept the legacy `{tool_calls: [...]}`
    shape with a separate reason code so we can split the audit between
    "structurally tool-call-like" and "true planner envelope".
    """
    reasons: list[str] = []
    if not isinstance(decoded, dict):
        return [f"top_level_not_object({type(decoded).__name__})"]

    keys = set(decoded.keys())

    # Legacy tool_calls envelope: `{tool_calls: [{name, arguments}]}`.
    if keys == {"tool_calls"} or (keys == {"tool_calls", "thought"}):
        tc = decoded.get("tool_calls")
        if not isinstance(tc, list) or not tc:
            return ["legacy_tool_calls_empty_or_not_list"]
        for i, c in enumerate(tc):
            if not isinstance(c, dict):
                return [f"legacy_tool_calls_entry_not_dict[{i}]"]
            if not c.get("name"):
                return [f"legacy_tool_calls_missing_name[{i}]"]
        return ["legacy_tool_calls_envelope"]

    # Legacy shell_command envelope: `{command, [explanation, cwd]}`.
    if "command" in keys and keys.issubset({"command", "explanation", "cwd"}):
        if not isinstance(decoded.get("command"), str) or not decoded["command"]:
            return ["legacy_shell_missing_command"]
        return ["legacy_shell_envelope"]

    # Legacy scam-defense envelope: `{response, action, scamDefense, [reasoning]}`.
    if "scamDefense" in keys or (
        "response" in keys and "action" in keys and "scamDefense" in keys
    ):
        return ["legacy_scam_defense_envelope"]

    # Modern planner envelope.
    missing = PLANNER_KEYS - keys
    extra = keys - PLANNER_KEYS
    if missing:
        for m in sorted(missing):
            reasons.append(f"missing_{m}")
    if extra:
        # Allow common extras carried from upstream (params is occasionally
        # surfaced at top level).
        unknown_extra = sorted(e for e in extra if e not in {"params"})
        for e in unknown_extra:
            reasons.append(f"extra_top_level_key({e})")

    if "thought" in keys:
        v = decoded["thought"]
        if not isinstance(v, str):
            reasons.append(f"thought_wrong_type({type(v).__name__})")

    if "actions" in keys:
        actions = decoded["actions"]
        if isinstance(actions, str):
            # CSV form — accepted but flagged for migration.
            reasons.append("actions_is_csv_string")
        elif isinstance(actions, list):
            for i, entry in enumerate(actions):
                ok, reason = _action_is_valid(entry)
                if not ok:
                    reasons.append(f"action[{i}]:{reason}")
                    break
            if not actions:
                # Empty actions are legal per the prompt (no actions to run);
                # don't flag as mismatch.
                pass
        elif isinstance(actions, dict) and not actions:
            # Empty TOON `actions:` decodes to {}. Accept as empty list.
            pass
        else:
            reasons.append(f"actions_wrong_type({type(actions).__name__})")

    if "providers" in keys:
        providers = decoded["providers"]
        if isinstance(providers, str):
            reasons.append("providers_is_csv_string")
        elif isinstance(providers, list):
            for i, p in enumerate(providers):
                if not isinstance(p, str):
                    reasons.append(f"provider[{i}]_not_string({type(p).__name__})")
                    break
        elif isinstance(providers, dict) and not providers:
            # Empty TOON `providers:` decodes to {}. Accept.
            pass
        else:
            reasons.append(f"providers_wrong_type({type(providers).__name__})")

    if "text" in keys:
        v = decoded["text"]
        if not isinstance(v, str):
            reasons.append(f"text_wrong_type({type(v).__name__})")

    if "simple" in keys:
        v = decoded["simple"]
        if not isinstance(v, bool):
            reasons.append(f"simple_wrong_type({type(v).__name__})")

    return reasons


def validate_reply(decoded: Any) -> list[str]:
    """Validate a reply or reasoning_cot record.

    Accepts either the planner envelope (5-key) OR `{thought, text}` OR
    `{text}` slim form. Anything else is a mismatch.
    """
    if not isinstance(decoded, dict):
        return [f"top_level_not_object({type(decoded).__name__})"]
    keys = set(decoded.keys())
    # Slim {text} or {thought, text} forms are the canonical reply shape.
    if keys == {"thought", "text"}:
        if not isinstance(decoded.get("thought"), str):
            return ["thought_wrong_type"]
        if not isinstance(decoded.get("text"), str):
            return ["text_wrong_type"]
        return []
    if keys == {"text"}:
        if not isinstance(decoded.get("text"), str):
            return ["text_wrong_type"]
        return []
    # Full planner envelope (5-key) is also accepted for reply.
    if keys == PLANNER_KEYS:
        return validate_planner(decoded)
    extras = sorted(keys - {"thought", "text"})
    if extras:
        return [f"reply_extra_top_level_key({extras[0]})"]
    return ["reply_unknown_shape"]


def validate_should_respond(decoded: Any) -> list[str]:
    """Validate a shouldRespond / shouldRespondWithContext record."""
    if not isinstance(decoded, dict):
        return [f"top_level_not_object({type(decoded).__name__})"]
    keys = set(decoded.keys())
    missing = SHOULD_RESPOND_REQUIRED - keys
    extra = keys - SHOULD_RESPOND_REQUIRED - SHOULD_RESPOND_OPTIONAL
    reasons: list[str] = []
    for m in sorted(missing):
        reasons.append(f"missing_{m}")
    for e in sorted(extra):
        reasons.append(f"extra_top_level_key({e})")
    action = decoded.get("action")
    if action is not None:
        if not isinstance(action, str):
            reasons.append(f"action_wrong_type({type(action).__name__})")
        elif action.strip().upper() not in SHOULD_RESPOND_ACTIONS:
            reasons.append(f"action_not_in_enum({action})")
    for k in ("name", "reasoning", "primaryContext"):
        v = decoded.get(k)
        if v is not None and not isinstance(v, str):
            reasons.append(f"{k}_wrong_type({type(v).__name__})")
    for k in ("secondaryContexts", "evidenceTurnIds"):
        v = decoded.get(k)
        # Empty TOON values may decode to "" or {}; both are acceptable.
        if v is not None and not isinstance(v, (str, list, dict)):
            reasons.append(f"{k}_wrong_type({type(v).__name__})")
    return reasons


def validate_reflection(decoded: Any) -> list[str]:
    """Validate `reflectionTemplate` output (eliza/packages/core/src/prompts.ts:867).

    Emits: thought, quality_score, strengths, improvements, learnings.
    NOT to be confused with `reflection_evaluator` (separate template,
    has task_completed / task_completion_reason / relationships)."""
    if not isinstance(decoded, dict):
        return [f"top_level_not_object({type(decoded).__name__})"]
    reasons: list[str] = []
    for required in ("thought", "quality_score", "strengths",
                     "improvements", "learnings"):
        if required not in decoded:
            reasons.append(f"missing_{required}")
    qs = decoded.get("quality_score")
    if qs is not None:
        # Accept int, float, or stringified forms — including the common
        # "78/100" denominator form that gpt-oss emits.
        n: float | None = None
        if isinstance(qs, (int, float)):
            n = float(qs)
        elif isinstance(qs, str):
            m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*(?:/\s*100)?\s*$", qs)
            if m:
                try:
                    n = float(m.group(1))
                except ValueError:
                    n = None
        if n is None:
            reasons.append(f"quality_score_wrong_type({type(qs).__name__})")
        elif not (0 <= n <= 100):
            reasons.append(f"quality_score_out_of_range({qs})")
    return reasons


def validate_fact_extractor(decoded: Any) -> list[str]:
    """Validate a fact_extractor record. Input is the RAW JSON-decoded object,
    NOT a TOON-decoded value (fact_extractor emits raw JSON per the template).

    Schema: ``{"ops": [...]}`` where each op has a known shape per ``op`` type.
    Empty ``ops`` is valid (and common — the template explicitly allows it).
    """
    if not isinstance(decoded, dict):
        return [f"top_level_not_object({type(decoded).__name__})"]
    if "ops" not in decoded:
        return ["missing_ops"]
    ops = decoded["ops"]
    if not isinstance(ops, list):
        return [f"ops_wrong_type({type(ops).__name__})"]
    extra_top = sorted(set(decoded.keys()) - {"ops"})
    reasons: list[str] = []
    for e in extra_top:
        reasons.append(f"extra_top_level_key({e})")
    for i, op in enumerate(ops):
        if not isinstance(op, dict):
            reasons.append(f"op[{i}]_not_dict({type(op).__name__})")
            break
        op_type = op.get("op")
        if not isinstance(op_type, str) or not op_type:
            reasons.append(f"op[{i}]_missing_op_type")
            continue
        if op_type not in FACT_OP_TYPES:
            reasons.append(f"op[{i}]_unknown_op_type({op_type})")
            continue
        if op_type in ("add_durable", "add_current"):
            for required in ("claim", "category", "structured_fields"):
                if required not in op:
                    reasons.append(f"op[{i}]({op_type})_missing_{required}")
            claim = op.get("claim")
            if claim is not None and not isinstance(claim, str):
                reasons.append(f"op[{i}]({op_type})_claim_wrong_type")
            category = op.get("category")
            if category is not None and not isinstance(category, str):
                reasons.append(f"op[{i}]({op_type})_category_wrong_type")
            sf = op.get("structured_fields")
            if sf is not None and not isinstance(sf, dict):
                reasons.append(f"op[{i}]({op_type})_structured_fields_wrong_type")
        elif op_type in ("strengthen", "decay", "contradict"):
            for required in ("factId", "reason"):
                if required not in op:
                    reasons.append(f"op[{i}]({op_type})_missing_{required}")
            fid = op.get("factId")
            if fid is not None and not isinstance(fid, str):
                reasons.append(f"op[{i}]({op_type})_factId_wrong_type")
            reason_field = op.get("reason")
            if reason_field is not None and not isinstance(reason_field, str):
                reasons.append(f"op[{i}]({op_type})_reason_wrong_type")
    return reasons


def validate_reflection_evaluator(decoded: Any) -> list[str]:
    """Validate a reflection_evaluator record (TOON-decoded).

    Required: ``thought`` (str), ``task_completed`` (bool),
    ``task_completion_reason`` (str). Optional: ``relationships[N]`` —
    each entry must be a dict with ``sourceEntityId``, ``targetEntityId``,
    optional ``tags[M]`` (list of strings).
    """
    if not isinstance(decoded, dict):
        return [f"top_level_not_object({type(decoded).__name__})"]
    reasons: list[str] = []
    for required in ("thought", "task_completed", "task_completion_reason"):
        if required not in decoded:
            reasons.append(f"missing_{required}")
    if "thought" in decoded and not isinstance(decoded["thought"], str):
        reasons.append("thought_wrong_type")
    if "task_completed" in decoded and not isinstance(decoded["task_completed"], bool):
        reasons.append("task_completed_wrong_type")
    if "task_completion_reason" in decoded and not isinstance(
        decoded["task_completion_reason"], str
    ):
        reasons.append("task_completion_reason_wrong_type")

    rels = decoded.get("relationships")
    if rels is None:
        return reasons
    # Empty TOON list decodes to {} or "" — accept those.
    if isinstance(rels, str) and rels == "":
        return reasons
    if isinstance(rels, dict) and not rels:
        return reasons
    if not isinstance(rels, list):
        reasons.append(f"relationships_wrong_type({type(rels).__name__})")
        return reasons
    for i, rel in enumerate(rels):
        if not isinstance(rel, dict):
            reasons.append(f"relationships[{i}]_not_dict({type(rel).__name__})")
            break
        for required in ("sourceEntityId", "targetEntityId"):
            if required not in rel:
                reasons.append(f"relationships[{i}]_missing_{required}")
            elif not isinstance(rel[required], str):
                reasons.append(f"relationships[{i}]_{required}_wrong_type")
        tags = rel.get("tags")
        if tags is None:
            continue
        if isinstance(tags, str) and tags == "":
            continue
        if isinstance(tags, dict) and not tags:
            continue
        if not isinstance(tags, list):
            reasons.append(f"relationships[{i}]_tags_wrong_type({type(tags).__name__})")
            continue
        for j, tag in enumerate(tags):
            if not isinstance(tag, str):
                reasons.append(f"relationships[{i}]_tag[{j}]_not_string")
                break
    return reasons


def validate_summarization(decoded: Any) -> list[str]:
    """Validate a summarization / initial_summarization record (TOON).

    Required: ``text`` (str), ``topics`` (list of str OR CSV str),
    ``keyPoints`` (list of str OR CSV str).
    """
    if not isinstance(decoded, dict):
        return [f"top_level_not_object({type(decoded).__name__})"]
    reasons: list[str] = []
    for required in ("text", "topics", "keyPoints"):
        if required not in decoded:
            reasons.append(f"missing_{required}")
    if "text" in decoded and not isinstance(decoded["text"], str):
        reasons.append(f"text_wrong_type({type(decoded['text']).__name__})")
    for field in ("topics", "keyPoints"):
        if field not in decoded:
            continue
        v = decoded[field]
        # Empty TOON list decodes to {} or "" — accept those.
        if isinstance(v, str):
            continue
        if isinstance(v, dict) and not v:
            continue
        if not isinstance(v, list):
            reasons.append(f"{field}_wrong_type({type(v).__name__})")
            continue
        for i, entry in enumerate(v):
            if not isinstance(entry, str):
                reasons.append(f"{field}[{i}]_not_string({type(entry).__name__})")
                break
    return reasons


def validate_long_term_extraction(decoded: Any) -> list[str]:
    """Validate a long_term_extraction record (TOON).

    The output is a (possibly empty) ``memories[N]`` block. Empty memories is
    explicitly legal and is the common case per the template. Each memory
    entry must have ``category`` ∈ {episodic, semantic, procedural},
    ``content`` (str), ``confidence`` (float ≥ 0.85).
    """
    # Empty output may decode to {} (no keys) or even an empty string.
    if isinstance(decoded, str) and decoded == "":
        return []
    if isinstance(decoded, dict) and not decoded:
        return []
    if not isinstance(decoded, dict):
        return [f"top_level_not_object({type(decoded).__name__})"]

    mems = decoded.get("memories")
    if mems is None:
        # No memories key — empty case is legal.
        return []
    if isinstance(mems, str) and mems == "":
        return []
    if isinstance(mems, dict) and not mems:
        return []
    if not isinstance(mems, list):
        return [f"memories_wrong_type({type(mems).__name__})"]

    reasons: list[str] = []
    for i, mem in enumerate(mems):
        if not isinstance(mem, dict):
            reasons.append(f"memories[{i}]_not_dict({type(mem).__name__})")
            break
        for required in ("category", "content", "confidence"):
            if required not in mem:
                reasons.append(f"memories[{i}]_missing_{required}")
        cat = mem.get("category")
        if cat is not None:
            if not isinstance(cat, str):
                reasons.append(f"memories[{i}]_category_wrong_type")
            elif cat not in LTM_CATEGORIES:
                reasons.append(f"memories[{i}]_category_not_in_enum({cat})")
        content = mem.get("content")
        if content is not None and not isinstance(content, str):
            reasons.append(f"memories[{i}]_content_wrong_type")
        conf = mem.get("confidence")
        if conf is not None:
            if not isinstance(conf, (int, float)) or isinstance(conf, bool):
                reasons.append(f"memories[{i}]_confidence_wrong_type")
            elif float(conf) < LTM_MIN_CONFIDENCE:
                reasons.append(
                    f"memories[{i}]_confidence_below_threshold({conf}<{LTM_MIN_CONFIDENCE})"
                )
    return reasons


def validate_action_specific(task_type: str, decoded: Any) -> list[str]:
    """Multi-dispatch validator for per-action templates (Phase 3).

    Field expectations are derived from the canonical templates in
    ``eliza/packages/core/src/prompts.ts``. When a template is permissive
    or under-documented, the validator only checks the top-level shape and
    a TODO comment marks the gap.
    """
    if not isinstance(decoded, dict):
        return [f"top_level_not_object({type(decoded).__name__})"]
    if not decoded:
        return ["empty_object"]
    keys = set(decoded.keys())

    if task_type == "add_contact":
        # addContactTemplate (prompts.ts:11): required `contactName` (a.k.a.
        # `name`); optional entityId, categories, notes, timezone, language,
        # reason. Accept either `contactName` or `name`.
        if "contactName" not in keys and "name" not in keys:
            return ["missing_contactName"]
        primary = decoded.get("contactName", decoded.get("name"))
        if not isinstance(primary, str) or not primary.strip():
            return ["contactName_wrong_type_or_empty"]
        return []

    if task_type == "remove_contact":
        # removeContactTemplate (prompts.ts:892): required `contactName`,
        # `confirmed: yes|no`. Accept either `contactName` or `name`.
        # Empty/null contactName is acceptable IFF `confirmed` is no/null/false
        # — that's the canonical "no removal requested" no-op response.
        reasons: list[str] = []
        if "contactName" not in keys and "name" not in keys:
            return ["missing_contactName"]
        primary = decoded.get("contactName", decoded.get("name"))
        confirmed = str(decoded.get("confirmed") or "").lower().strip()
        is_negative = confirmed in ("no", "false", "") or decoded.get("confirmed") is False
        if not isinstance(primary, str) or not primary.strip():
            if not is_negative:
                reasons.append("contactName_empty_with_positive_confirm")
        return reasons

    if task_type == "choose_option":
        # chooseOptionTemplate (prompts.ts:133) emits `thought` + `selected_id`.
        # Per the SCHEMA.md row, downstream synthesizers may use `option`
        # instead. Accept either pair: {option,reasoning} OR
        # {thought,selected_id}.
        reasons: list[str] = []
        if "option" in keys:
            if not isinstance(decoded.get("option"), str):
                reasons.append("option_wrong_type")
            if "reasoning" not in keys:
                reasons.append("missing_reasoning")
            elif not isinstance(decoded.get("reasoning"), str):
                reasons.append("reasoning_wrong_type")
            return reasons
        if "selected_id" in keys:
            if not isinstance(decoded.get("selected_id"), str):
                reasons.append("selected_id_wrong_type")
            if "thought" in keys and not isinstance(decoded.get("thought"), str):
                reasons.append("thought_wrong_type")
            return reasons
        return ["missing_option_or_selected_id"]

    if task_type == "extract_option":
        # optionExtractionTemplate (prompts.ts:611) — output is
        # `taskId` + `selectedOption`, both nullable strings.
        # The earlier audit validator targeted a stale schema asking for
        # `option` + `confidence`; corrected here so the synth's
        # `{taskId, selectedOption}` records audit cleanly.
        reasons = []
        if "taskId" not in keys:
            reasons.append("missing_taskId")
        elif decoded.get("taskId") is not None and not isinstance(decoded.get("taskId"), str):
            reasons.append("taskId_wrong_type")
        if "selectedOption" not in keys:
            reasons.append("missing_selectedOption")
        elif decoded.get("selectedOption") is not None \
                and not isinstance(decoded.get("selectedOption"), str):
            reasons.append("selectedOption_wrong_type")
        return reasons

    if task_type == "extract_secrets":
        # extractSecretsTemplate (prompts.ts:194) — output is
        # `key`, `value`, optional `description`/`type`.
        # SCHEMA.md row asks for `key`, `value`, `exists: bool`. Accept either
        # presentation but require `key` and `value` always.
        reasons = []
        for required in ("key", "value"):
            if required not in keys:
                reasons.append(f"missing_{required}")
            elif not isinstance(decoded.get(required), str):
                reasons.append(f"{required}_wrong_type")
        if "exists" in keys and not isinstance(decoded.get("exists"), bool):
            reasons.append("exists_wrong_type")
        return reasons

    if task_type == "extract_secret_operation":
        # extractSecretOperationTemplate (prompts.ts:152) — output is
        # `operation` (get|set|delete|list|check), `key`, `value`, `level`.
        if "operation" not in keys:
            return ["missing_operation"]
        if not isinstance(decoded.get("operation"), str):
            return ["operation_wrong_type"]
        return []

    if task_type == "extract_secret_request":
        # extractSecretRequestTemplate (prompts.ts:175) — output is
        # `key`, optional `reason`. Accept `key` or legacy `secret_name`.
        if "key" not in keys and "secret_name" not in keys:
            return ["missing_key"]
        primary = decoded.get("key", decoded.get("secret_name"))
        if not isinstance(primary, str) or not primary.strip():
            return ["key_wrong_type_or_empty"]
        return []

    if task_type == "post_creation":
        # postCreationTemplate (prompts.ts:661) — output is `thought`, `post`,
        # optional `imagePrompt`. SCHEMA.md row asks for `text`/`media`. Accept
        # either: `text` or `post` is required.
        if "text" not in keys and "post" not in keys:
            return ["missing_text_or_post"]
        primary = decoded.get("text", decoded.get("post"))
        if not isinstance(primary, str) or not primary.strip():
            return ["text_wrong_type_or_empty"]
        return []

    if task_type == "post_action_decision":
        # postActionDecisionTemplate (prompts.ts:621) — emits the planner
        # envelope (thought, actions, providers, text, simple). SCHEMA.md
        # row simplifies to {decision, reasoning}. Accept either: planner
        # envelope OR explicit {decision, reasoning} pair.
        if "decision" in keys:
            reasons = []
            if not isinstance(decoded.get("decision"), str):
                reasons.append("decision_wrong_type")
            if "reasoning" not in keys:
                reasons.append("missing_reasoning")
            elif not isinstance(decoded.get("reasoning"), str):
                reasons.append("reasoning_wrong_type")
            return reasons
        # Otherwise treat as planner envelope.
        return validate_planner(decoded)

    # Unknown action task_type — be permissive (caller routes here only for
    # known names, but guard anyway).
    return []


# ─────────────────────────── audit driver ────────────────────────────────────

def _json_or_none(text: str) -> tuple[Any | None, str | None]:
    try:
        return json.loads(text), None
    except (ValueError, TypeError) as e:
        return None, str(e)[:200]


def _is_json_target(task_type: str) -> bool:
    """All expectedResponse values are JSON in native v5."""
    return True


def _classify(task_type: str, decoded: Any) -> list[str]:
    if task_type in SHOULD_RESPOND_TASK_TYPES:
        return validate_should_respond(decoded)
    if task_type in REFLECTION_TASK_TYPES:
        return validate_reflection(decoded)
    if task_type in REFLECTION_EVALUATOR_TASK_TYPES:
        return validate_reflection_evaluator(decoded)
    if task_type in FACT_EXTRACTOR_TASK_TYPES:
        return validate_fact_extractor(decoded)
    if task_type in SUMMARIZATION_TASK_TYPES:
        return validate_summarization(decoded)
    if task_type in LONG_TERM_EXTRACTION_TASK_TYPES:
        return validate_long_term_extraction(decoded)
    if task_type in ACTION_SPECIFIC_TASK_TYPES:
        return validate_action_specific(task_type, decoded)
    if task_type in REPLY_SLIM_TASK_TYPES or task_type in REPLY_OR_PLANNER_TASK_TYPES:
        return validate_reply(decoded)
    if task_type in PLANNER_TASK_TYPES:
        return validate_planner(decoded)
    # Anything else (synth task_types like `lifeops.*`, `plugin-*`, etc.) is
    # treated as planner-envelope by default.
    return validate_planner(decoded)


def iter_records(
    normalized_dir: Path, *, only: str | None, sample_per_file: int | None,
) -> Iterator[tuple[str, str, dict[str, Any]]]:
    """Yield (slug, raw_line, parsed_record) for every record under
    ``normalized_dir/*.jsonl`` (skipping ``*.errors.jsonl``)."""
    for p in sorted(normalized_dir.glob("*.jsonl")):
        if p.name.endswith(".errors.jsonl"):
            continue
        slug = p.stem
        if only and only != slug:
            continue
        with p.open() as f:
            for i, line in enumerate(f):
                if sample_per_file is not None and i >= sample_per_file:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                yield slug, line, rec


def audit(
    normalized_dir: Path, *, only: str | None, sample_per_file: int | None,
) -> dict[str, Any]:
    """Run the full audit and return a structured report."""
    # task_type → {"total": int, "ok": int, "reasons": Counter,
    #              "examples": {reason: [{slug, original_id, decoded_preview}]}}
    by_task: dict[str, dict[str, Any]] = collections.defaultdict(
        lambda: {
            "total": 0,
            "ok": 0,
            "decode_errors": 0,
            "reasons": collections.Counter(),
            "examples": collections.defaultdict(list),
        }
    )

    # OOB tracking: task_type -> count, for the --strict-phases flag.
    oob_counts: collections.Counter[str] = collections.Counter()

    n_seen = 0
    for slug, _line, rec in iter_records(normalized_dir, only=only,
                                          sample_per_file=sample_per_file):
        n_seen += 1
        if n_seen % 50_000 == 0:
            log.info("audited %d records", n_seen)
        meta = rec.get("metadata") or {}
        task_type = str(meta.get("task_type") or "?")
        if classify_phase(task_type) == PHASE_OOB:
            oob_counts[task_type] += 1
        target = rec.get("expectedResponse")
        if not isinstance(target, str) or not target:
            by_task[task_type]["total"] += 1
            by_task[task_type]["reasons"]["missing_or_non_string_target"] += 1
            continue

        decoded, decode_err = _json_or_none(target)
        bucket = by_task[task_type]
        bucket["total"] += 1
        if decode_err is not None:
            bucket["decode_errors"] += 1
            bucket["reasons"]["decode_error"] += 1
            if len(bucket["examples"]["decode_error"]) < 3:
                bucket["examples"]["decode_error"].append({
                    "slug": slug,
                    "original_id": str(meta.get("original_id", ""))[:120],
                    "preview": target[:200],
                    "error": decode_err,
                })
            continue

        reasons = _classify(task_type, decoded)
        if not reasons:
            bucket["ok"] += 1
            continue
        for r in reasons:
            bucket["reasons"][r] += 1
            if len(bucket["examples"][r]) < 3:
                bucket["examples"][r].append({
                    "slug": slug,
                    "original_id": str(meta.get("original_id", ""))[:120],
                    "preview": target[:300],
                    "decoded_keys": (
                        sorted(decoded.keys())[:10]
                        if isinstance(decoded, dict) else None
                    ),
                })

    decoder.close()

    # Build the structured report.
    report: dict[str, Any] = {
        "n_audited": n_seen,
        "by_task_type": {},
        "oob": {
            "total": int(sum(oob_counts.values())),
            "task_types": dict(oob_counts),
        },
    }
    for tt, b in by_task.items():
        top_reasons = b["reasons"].most_common(8)
        report["by_task_type"][tt] = {
            "total": b["total"],
            "ok": b["ok"],
            "mismatch": b["total"] - b["ok"],
            "decode_errors": b["decode_errors"],
            "conformance_pct": (b["ok"] / b["total"] * 100.0) if b["total"] else 0.0,
            "top_reasons": [{"reason": r, "count": c} for r, c in top_reasons],
            "examples": {r: list(b["examples"][r]) for r, _ in top_reasons},
        }
    return report


def write_markdown(report: dict[str, Any], out_path: Path) -> None:
    lines: list[str] = []
    lines.append("# Pipeline-stage shape audit\n")
    lines.append(
        f"Total records audited: **{report['n_audited']:,}**\n"
    )
    lines.append("Conformance is measured against the canonical schemas in "
                 "[PIPELINE_SCHEMAS.md](./PIPELINE_SCHEMAS.md).\n")

    rows = sorted(
        report["by_task_type"].items(),
        key=lambda kv: -kv[1]["total"],
    )
    lines.append("## Summary by task_type\n")
    lines.append("| task_type | total | conformant | mismatch | decode_err | conformance% |")
    lines.append("|-----------|------:|-----------:|---------:|-----------:|-------------:|")
    for tt, b in rows:
        lines.append(
            f"| `{tt}` | {b['total']:,} | {b['ok']:,} | {b['mismatch']:,} | "
            f"{b['decode_errors']:,} | {b['conformance_pct']:.2f}% |"
        )
    lines.append("")

    for tt, b in rows:
        lines.append(f"## `{tt}` ({b['total']:,} records, "
                     f"{b['conformance_pct']:.2f}% conformant)\n")
        if not b["top_reasons"]:
            lines.append("No mismatches detected.\n")
            continue
        lines.append("Top mismatch reasons:\n")
        lines.append("| reason | count |")
        lines.append("|--------|------:|")
        for r in b["top_reasons"]:
            lines.append(f"| `{r['reason']}` | {r['count']:,} |")
        lines.append("")
        lines.append("Examples per reason (up to 3 each):\n")
        for r in b["top_reasons"]:
            reason = r["reason"]
            examples = b["examples"].get(reason, [])
            if not examples:
                continue
            lines.append(f"### `{reason}`\n")
            for ex in examples:
                lines.append(
                    f"- slug=`{ex['slug']}` id=`{ex.get('original_id','')}` "
                    f"keys=`{ex.get('decoded_keys')}`"
                )
                preview = ex["preview"].replace("\n", " ")[:240]
                lines.append(f"  - preview: `{preview}`")
            lines.append("")
    out_path.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data-dir", default=str(ROOT / "data" / "normalized"))
    ap.add_argument("--out-md", default=str(ROOT / "previews" / "PIPELINE_AUDIT.md"))
    ap.add_argument("--out-json", default=str(ROOT / "previews" / "pipeline_audit.json"))
    ap.add_argument("--sample", type=int, default=None,
                    help="audit only the first N records per file (default: all)")
    ap.add_argument("--only", default=None,
                    help="audit only the named slug (e.g. agent-trove)")
    ap.add_argument("--strict-phases", action="store_true",
                    help="fail with exit code 2 if any record's task_type is "
                         "out-of-band (not Phase 1-4 per lib.runtime_phases)")
    ap.add_argument("--log-level", default="INFO")
    args = ap.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper()),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    data_dir = Path(args.data_dir).resolve()
    out_md = Path(args.out_md).resolve()
    out_json = Path(args.out_json).resolve()
    out_md.parent.mkdir(parents=True, exist_ok=True)

    report = audit(data_dir, only=args.only, sample_per_file=args.sample)

    out_json.write_text(json.dumps(report, indent=2, ensure_ascii=False),
                        encoding="utf-8")
    write_markdown(report, out_md)
    log.info("wrote %s and %s", out_md, out_json)

    oob = report.get("oob", {"total": 0, "task_types": {}})
    oob_total = int(oob.get("total", 0))
    oob_types = oob.get("task_types", {}) or {}
    n_types = len(oob_types)
    type_summary = ", ".join(
        f"{k}({v})" for k, v in sorted(oob_types.items(), key=lambda kv: -kv[1])
    ) or "none"
    print(f"OOB records: {oob_total} across {n_types} task_types: {type_summary}")

    if args.strict_phases and oob_total > 0:
        log.error(
            "strict-phases failure: %d out-of-band records across %d task_types",
            oob_total, n_types,
        )
        sys.exit(2)


if __name__ == "__main__":
    main()
