"""Modify character action -- direct character modification.

Handles both explicit user requests and agent-initiated modifications.
Admins/owners get global character changes; non-admin users are routed
to per-user interaction preferences.

Includes full intent detection, safety evaluation, LLM-based parsing,
per-user preference handling, and modification summary generation.
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import TYPE_CHECKING, Any

from elizaos.types import Action, ActionExample, ActionResult, Content, MemoryType, ModelType
from elizaos.utils.xml import parse_key_value_xml

from ..services.character_file_manager import CharacterFileManager
from ..types import MAX_PREFS_PER_USER, PERSONALITY_SERVICE_TYPE, USER_PREFS_TABLE

if TYPE_CHECKING:
    from elizaos.types import HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

ModifyCharacterScope = str  # "auto" | "global" | "user"


# ---------------------------------------------------------------------------
# Helper: scope resolution
# ---------------------------------------------------------------------------


def _normalize_scope(value: Any) -> str:
    if value == "global" or value == "user":
        return value
    return "auto"


def _resolve_effective_request(
    message: Memory,
    options: dict[str, Any] | None = None,
) -> tuple[str, str]:
    """Returns (text, request_source)."""
    param_request = ""
    if options and isinstance(options.get("parameters"), dict):
        param_request = (options["parameters"].get("request") or "").strip()

    raw_text = (message.content.text or "").strip()

    if not param_request:
        return raw_text, "message"
    if not raw_text or raw_text == param_request:
        return param_request, "parameter"
    if len(raw_text) > len(param_request) and param_request.lower() in raw_text.lower():
        return raw_text, "message"
    return param_request, "parameter"


def _resolve_scope(scope_hint: str, is_admin: bool) -> str:
    if not is_admin:
        return "user"
    return "user" if scope_hint == "user" else "global"


# ---------------------------------------------------------------------------
# Helper: intent detection by rules
# ---------------------------------------------------------------------------

_CHARACTER_KW = re.compile(
    r"\b(personality|character|tone|style|voice|behavior|response(?:\s+style|\s+format)?|"
    r"interaction(?:\s+style)?|preferences?|bio|topics?|name|language)\b",
    re.I,
)
_DIRECT_CHANGE = re.compile(r"\b(change|update|modify|adjust|set|rename|call)\b", re.I)
_STYLISTIC_ADJ = re.compile(
    r"\b(be|sound|act|respond|reply|talk|speak)\b[\s\S]{0,80}"
    r"\b(more|less|warmer|cooler|friendlier|formal|casual|direct|verbose|concise|"
    r"skeptical|encouraging|supportive|detailed|brief|professional|polite)\b",
    re.I,
)
_INTERACTION_SCOPE = re.compile(
    r"\b(with me|to me|our interactions?|when talking to me|from now on)\b", re.I
)
_GROUP_BEHAVIOR = re.compile(
    r"\b(group conversations?|group chats?|chime in|jump in|mentioned by name|"
    r"directly addressed|messaged directly|only respond when)\b",
    re.I,
)
_REPLY_RULE = re.compile(r"\b(avoid|only|don't|do not|stop|reply|respond|chime|jump)\b", re.I)
_RESET_PREF = re.compile(
    r"\b(reset|clear)\b[\s\S]{0,40}\b(interaction preferences?|preferences?)\b", re.I
)
_SOUND_LIKE_ME = re.compile(r"\b(sound like me|be more like me|mirror my|my voice)\b", re.I)
_RESPOND_IN_LANG = re.compile(r"\b(respond|reply|speak|talk)\s+in\s+[a-z]", re.I)
_DIRECT_STYLE = re.compile(
    r"^(?:please\s+)?(?:not|do not|don't|avoid|stop|only|be|respond|reply|talk|speak)\b", re.I
)
_STYLE_CUE = re.compile(
    r"\b(chatty|responsive|quiet|silent|brief|verbose|concise|formal|casual|warm|direct|"
    r"skeptical|encouraging|supportive|mentioned|messaged directly|directly addressed|"
    r"group conversations?|group chats?|follow-up questions?|emoji|language)\b",
    re.I,
)


def _detect_intent_by_rules(message_text: str) -> dict[str, Any]:
    """Heuristic intent detection. Returns {intent, definitive, potentialRequest}."""
    normalized = message_text.strip().lower()
    if not normalized:
        return {
            "intent": {"isModificationRequest": False, "requestType": "none", "confidence": 0},
            "definitive": True,
            "potentialRequest": False,
        }

    # Definitive explicit matches
    if (
        _RESET_PREF.search(normalized)
        or (_DIRECT_CHANGE.search(normalized) and _CHARACTER_KW.search(normalized))
        or _SOUND_LIKE_ME.search(normalized)
        or _RESPOND_IN_LANG.search(normalized)
        or (_INTERACTION_SCOPE.search(normalized) and _STYLISTIC_ADJ.search(normalized))
        or (_GROUP_BEHAVIOR.search(normalized) and _REPLY_RULE.search(normalized))
        or (_DIRECT_STYLE.search(normalized) and _STYLE_CUE.search(normalized))
    ):
        return {
            "intent": {
                "isModificationRequest": True,
                "requestType": "explicit",
                "confidence": 0.95,
            },
            "definitive": True,
            "potentialRequest": True,
        }

    # Check for any cue
    has_any_cue = any(
        pattern.search(normalized)
        for pattern in [
            _CHARACTER_KW,
            _INTERACTION_SCOPE,
            _GROUP_BEHAVIOR,
            _STYLISTIC_ADJ,
            _RESET_PREF,
            _SOUND_LIKE_ME,
            _RESPOND_IN_LANG,
        ]
    )

    if not has_any_cue:
        return {
            "intent": {"isModificationRequest": False, "requestType": "none", "confidence": 0.99},
            "definitive": True,
            "potentialRequest": False,
        }

    return {
        "intent": {"isModificationRequest": False, "requestType": "suggestion", "confidence": 0.35},
        "definitive": False,
        "potentialRequest": True,
    }


# ---------------------------------------------------------------------------
# Helper: LLM intent detection
# ---------------------------------------------------------------------------


def _is_record(value: Any) -> bool:
    return isinstance(value, dict)


def _parse_structured(response: str) -> dict[str, Any] | None:
    parsed = parse_key_value_xml(response)
    return parsed if _is_record(parsed) else None


def _norm_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        n = value.strip().lower()
        return True if n == "true" else (False if n == "false" else None)
    return None


def _norm_num(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value) if value == value else None
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _norm_string_list(value: Any) -> list[str] | None:
    if isinstance(value, list):
        result = [e.strip() for e in value if isinstance(e, str) and e.strip()]
        return result or None
    if isinstance(value, str):
        trimmed = value.strip()
        if not trimmed:
            return None
        items = [e.strip() for e in trimmed.split("||") if e.strip()]
        return items or None
    return None


def _norm_style(value: Any) -> dict[str, list[str]] | None:
    if not _is_record(value):
        return None
    style: dict[str, list[str]] = {}
    for k in ("all", "chat", "post"):
        items = _norm_string_list(value.get(k))
        if items:
            style[k] = items
    return style or None


def _norm_style_from_flat(parsed: dict[str, Any], prefix: str = "") -> dict[str, list[str]] | None:
    style: dict[str, list[str]] = {}
    for k in ("all", "chat", "post"):
        items = _norm_string_list(parsed.get(f"{prefix}style_{k}"))
        if items:
            style[k] = items
    return style or None


def _build_modification_from_record(
    parsed: dict[str, Any], prefix: str = ""
) -> dict[str, Any] | None:
    mod: dict[str, Any] = {}

    name = parsed.get(f"{prefix}name")
    if isinstance(name, str) and name.strip():
        mod["name"] = name.strip()

    system = parsed.get(f"{prefix}system")
    if isinstance(system, str) and system.strip():
        mod["system"] = system.strip()

    bio = _norm_string_list(parsed.get(f"{prefix}bio"))
    if bio:
        mod["bio"] = bio

    topics = _norm_string_list(parsed.get(f"{prefix}topics"))
    if topics:
        mod["topics"] = topics

    style = _norm_style(parsed.get(f"{prefix}style")) or _norm_style_from_flat(parsed, prefix)
    if style:
        mod["style"] = style

    return mod or None


async def _detect_modification_intent(runtime: IAgentRuntime, message_text: str) -> dict[str, Any]:
    """LLM-based intent detection with heuristic fallback."""
    heuristic = _detect_intent_by_rules(message_text)
    if heuristic["definitive"]:
        return heuristic["intent"]

    prompt = f"""Analyze this message for character modification intent.

Message:
"{message_text}"

Classify:
- explicit = a direct request to change shared character behavior or per-user interaction style
- suggestion = a soft or indirect request for a change
- none = not a character/personality/interaction change request

TOON only. Return exactly one TOON document. No prose before or after it.

Example:
isModificationRequest: true
requestType: explicit
confidence: 0.93"""

    try:
        response = await runtime.use_model(ModelType.TEXT_SMALL, prompt=prompt)
        raw = _parse_structured(str(response))
        if not raw:
            return heuristic["intent"]

        confidence = _norm_num(raw.get("confidence")) or 0
        llm_result = {
            "isModificationRequest": (_norm_bool(raw.get("isModificationRequest")) or False)
            and confidence > 0.5,
            "requestType": raw.get("requestType", "none")
            if isinstance(raw.get("requestType"), str)
            else "none",
            "confidence": confidence,
        }
        return llm_result if llm_result["isModificationRequest"] else heuristic["intent"]
    except Exception as e:
        logger.debug("Intent detection failed, using heuristic: %s", e)
        return heuristic["intent"]


# ---------------------------------------------------------------------------
# Helper: build conversation context
# ---------------------------------------------------------------------------


async def _build_recent_conversation(
    runtime: IAgentRuntime, message: Memory, max_messages: int = 6
) -> str:
    try:
        recent = await runtime.get_memories(
            {
                "roomId": str(message.room_id),
                "count": max_messages,
                "unique": True,
                "tableName": "messages",
            }
        )
        return "\n".join(
            f"{getattr(runtime.character, 'name', 'Agent') if m.entity_id == runtime.agent_id else 'User'}: {(m.content.text or '').strip()}"
            for m in recent[-max_messages:]
            if hasattr(m, "content") and m.content.text and m.content.text.strip()
        )
    except Exception as e:
        logger.debug("Failed to load conversation context: %s", e)
        return ""


# ---------------------------------------------------------------------------
# Helper: parse user modification request (LLM)
# ---------------------------------------------------------------------------


def _request_explicitly_renames(text: str) -> bool:
    n = text.strip().lower()
    return bool(
        re.search(r"\bcall yourself\b", n)
        or re.search(r"\brename\b[\s\S]{0,30}\b(?:yourself|the agent|the bot|it|you)\b", n)
        or re.search(
            r"\b(?:change|update|set)\b[\s\S]{0,30}\b(?:your|its|the agent'?s)?\s*name\b", n
        )
    )


def _sanitize_modification(request_text: str, mod: dict[str, Any]) -> dict[str, Any] | None:
    sanitized = dict(mod)
    if "name" in sanitized and not _request_explicitly_renames(request_text):
        del sanitized["name"]
    return sanitized or None


async def _parse_user_modification(
    runtime: IAgentRuntime, message: Memory, message_text: str
) -> dict[str, Any] | None:
    conversation = await _build_recent_conversation(runtime, message)
    prompt = f"""The MODIFY_CHARACTER action has already been selected.
Evaluate this request flexibly and convert it into a structured global character update:

RECENT CONVERSATION:
{conversation or "(no recent conversation available)"}

LATEST USER REQUEST:
"{message_text}"

Extract any of the following types of modifications:
- Name changes only when the user explicitly asks to rename the agent
- System prompt changes (fundamental behavioral instructions)
- Bio elements (personality traits, background info)
- Topics (areas of knowledge or expertise)
- Style preferences (how to respond or communicate)
- Behavioral changes, including moderation behavior, participation rules

Interpret the request generously when it is clearly about changing the agent's behavior.
Do not infer a name change from requests about tone, style, personality, bio, voice, or "sound like me".

TOON only. Return exactly one TOON document. No prose before or after it.
Set apply: false only when the request truly does not specify any change.

Fields you may include:
apply: true or false
name: replacement agent name
system: replacement system prompt
bio: bio item 1 || bio item 2
topics: topic 1 || topic 2
style_all: style item 1 || style item 2
style_chat: style item 1 || style item 2
style_post: style item 1 || style item 2"""

    try:
        response = await runtime.use_model(ModelType.TEXT_LARGE, prompt=prompt)
        raw = _parse_structured(str(response))
        if not raw or _norm_bool(raw.get("apply")) is False:
            return None
        parsed = _build_modification_from_record(raw)
        if not parsed:
            return None
        return _sanitize_modification(message_text, parsed)
    except Exception as e:
        logger.warning("Failed to parse user modification request: %s", e)
        return None


# ---------------------------------------------------------------------------
# Helper: safety evaluation
# ---------------------------------------------------------------------------


async def _evaluate_safety(
    runtime: IAgentRuntime,
    modification: dict[str, Any],
    request_text: str,
) -> dict[str, Any]:
    prompt = f"""You are evaluating a character modification request for safety and appropriateness.

ORIGINAL REQUEST: "{request_text}"

PARSED MODIFICATION:
{json.dumps(modification, indent=2)}

SAFETY EVALUATION CRITERIA:

1. HARMFUL TRAITS (REJECT): Aggressive, rude, dishonest, manipulative, harmful behavior
2. CORE VALUE CONFLICTS (REJECT): Requests to be less helpful, honest, or ethical
3. ACCEPTABLE STYLE CHANGES (ACCEPT): Communication style, positive traits, domain expertise
4. APPROPRIATE IMPROVEMENTS (ACCEPT): Teaching capabilities, interpersonal traits

TOON only. Return exactly one TOON document.

Fields:
isAppropriate: true or false
concerns: concern 1 || concern 2
reasoning: detailed explanation
acceptable_name: replacement name
acceptable_system: replacement system prompt
acceptable_bio: bio item 1 || bio item 2
acceptable_topics: topic 1 || topic 2
acceptable_style_all: style item 1 || style item 2
acceptable_style_chat: style item 1 || style item 2
acceptable_style_post: style item 1 || style item 2"""

    try:
        response = await runtime.use_model(ModelType.TEXT_LARGE, prompt=prompt)
        raw = _parse_structured(str(response))
        if not raw:
            raise ValueError("No structured response")

        is_appropriate = _norm_bool(raw.get("isAppropriate")) is True
        concerns = _norm_string_list(raw.get("concerns")) or []
        reasoning = raw.get("reasoning", "") if isinstance(raw.get("reasoning"), str) else ""
        acceptable = _build_modification_from_record(raw, "acceptable_")

        return {
            "isAppropriate": is_appropriate,
            "concerns": concerns,
            "reasoning": reasoning,
            "acceptableChanges": acceptable,
        }
    except Exception as e:
        logger.warning("Failed to evaluate modification safety: %s", e)
        return {
            "isAppropriate": False,
            "concerns": ["Safety evaluation unavailable"],
            "reasoning": "Could not complete safety evaluation.",
        }


# ---------------------------------------------------------------------------
# Helper: admin permission check
# ---------------------------------------------------------------------------


async def _check_admin(runtime: IAgentRuntime, message: Memory) -> bool:
    if message.entity_id == runtime.agent_id:
        return True
    try:
        # Use the elizaOS role system
        from elizaos.types import check_sender_role  # type: ignore[attr-defined]

        role_result = await check_sender_role(runtime, message)
        if not role_result:
            return False
        return role_result.get("isAdmin", False) is True
    except (ImportError, AttributeError):
        # Fallback: check if there's a role check method on runtime
        if hasattr(runtime, "check_sender_role"):
            result = await runtime.check_sender_role(message)
            return result.get("isAdmin", False) if result else False
        return False


# ---------------------------------------------------------------------------
# Helper: summarize modification
# ---------------------------------------------------------------------------


def _summarize_modification(mod: dict[str, Any]) -> str:
    parts: list[str] = []
    if isinstance(mod.get("name"), str):
        parts.append(f'Changed name to "{mod["name"]}"')
    if isinstance(mod.get("system"), str):
        parts.append(f"Updated system prompt ({len(mod['system'])} characters)")
    bio = mod.get("bio")
    if isinstance(bio, list) and bio:
        parts.append(f"Added {len(bio)} new bio element(s)")
    topics = mod.get("topics")
    if isinstance(topics, list) and topics:
        parts.append(f"Added topics: {', '.join(topics)}")
    style = mod.get("style")
    if isinstance(style, dict):
        parts.append(f"Updated {len(style)} style preference(s)")
    examples = mod.get("message_examples")
    if isinstance(examples, list) and examples:
        parts.append(f"Added {len(examples)} new response example(s)")
    return "; ".join(parts) if parts else "Applied character updates"


# ---------------------------------------------------------------------------
# Helper: per-user preference handling
# ---------------------------------------------------------------------------


def _infer_preference_category(text: str) -> str:
    if re.search(r"\b(verbose|concise|brief|shorter|detailed)\b", text, re.I):
        return "verbosity"
    if re.search(r"\b(formal|casual|professional|polite)\b", text, re.I):
        return "formality"
    if re.search(r"\b(warm|direct|skeptical|encouraging|supportive|friendly)\b", text, re.I):
        return "tone"
    if re.search(
        r"\b(chime|jump in|follow-up question|emoji|language|mentioned|directly addressed|messaged directly)\b",
        text,
        re.I,
    ):
        return "style"
    return "other"


async def _parse_user_preference(
    runtime: IAgentRuntime, message: Memory, message_text: str
) -> dict[str, str] | None:
    conversation = await _build_recent_conversation(runtime, message)
    prompt = f"""The MODIFY_CHARACTER action has already been selected.
Evaluate this request and convert it into a per-user interaction preference:

RECENT CONVERSATION:
{conversation or "(no recent conversation available)"}

LATEST USER REQUEST:
"{message_text}"

Determine:
1. Is this a request to RESET/CLEAR all preferences? (action: "reset")
2. Or a request to SET a new preference? (action: "set")

If setting, extract a concise preference statement.
Category options: "verbosity", "formality", "tone", "style", "content", "frequency", "other"

TOON only. Return exactly one TOON document. No prose.
Set action: none if the request truly does not specify any interaction preference.

Example:
action: set
text: avoid chiming into group conversations unless mentioned by name
category: frequency"""

    try:
        response = await runtime.use_model(ModelType.TEXT_SMALL, prompt=prompt)
        raw = _parse_structured(str(response))
        if not raw:
            return None

        action = raw.get("action", "")
        if isinstance(action, str) and action.strip().lower() == "none":
            return None

        if action == "reset":
            return {"text": "", "category": "other", "action": "reset"}

        text = raw.get("text")
        if not isinstance(text, str) or not text.strip():
            return None

        category = raw.get("category", "")
        if not isinstance(category, str) or not category.strip():
            category = _infer_preference_category(text)

        return {"text": text.strip(), "category": category.strip(), "action": "set"}
    except Exception:
        return None


async def _handle_preference_reset(
    runtime: IAgentRuntime,
    message: Memory,
    callback: HandlerCallback | None,
) -> ActionResult:
    existing = await runtime.get_memories(
        {
            "entityId": str(message.entity_id),
            "roomId": str(runtime.agent_id),
            "tableName": USER_PREFS_TABLE,
            "count": MAX_PREFS_PER_USER + 5,
        }
    )

    if not existing:
        if callback:
            await callback(Content(text="You don't have any custom interaction preferences set."))
        return ActionResult(text="No preferences to reset", success=True, values={"resetCount": 0})

    deleted_count = 0
    for pref in existing:
        if hasattr(pref, "id") and pref.id:
            try:
                await runtime.delete_memory(pref.id)
                deleted_count += 1
            except Exception as e:
                logger.warning("Failed to delete preference memory: %s", e)

    msg = f"I've cleared {deleted_count} custom interaction preference(s). I'll go back to my default interaction style with you."
    if callback:
        await callback(Content(text=msg, actions=["MODIFY_CHARACTER"]))
    return ActionResult(
        text=f"Reset {deleted_count} preferences",
        success=True,
        values={"resetCount": deleted_count},
    )


async def _handle_user_preference(
    runtime: IAgentRuntime,
    message: Memory,
    message_text: str,
    callback: HandlerCallback | None,
) -> ActionResult:
    try:
        preference = await _parse_user_preference(runtime, message, message_text)
        if not preference:
            if callback:
                await callback(
                    Content(
                        text="I couldn't understand your preference. Could you be more specific? "
                        "For example: 'be more formal with me' or 'don't use emojis when talking to me'."
                    )
                )
            return ActionResult(
                text="Could not parse preference", success=False, values={"error": "parse_failed"}
            )

        if preference["action"] == "reset":
            return await _handle_preference_reset(runtime, message, callback)

        # Enforce per-user limit
        existing = await runtime.get_memories(
            {
                "entityId": str(message.entity_id),
                "roomId": str(runtime.agent_id),
                "tableName": USER_PREFS_TABLE,
                "count": MAX_PREFS_PER_USER + 1,
            }
        )

        if len(existing) >= MAX_PREFS_PER_USER:
            if callback:
                await callback(
                    Content(
                        text=f"You already have {MAX_PREFS_PER_USER} interaction preferences set. "
                        'Please clear some first by saying "reset my interaction preferences".'
                    )
                )
            return ActionResult(
                text="Preference limit reached", success=False, values={"error": "limit_exceeded"}
            )

        # Check for duplicates
        is_dup = any(
            (getattr(e.content, "text", "") or "").lower() == preference["text"].lower()
            for e in existing
        )
        if is_dup:
            if callback:
                await callback(
                    Content(text="I already have that preference noted for our interactions.")
                )
            return ActionResult(
                text="Preference already exists", success=True, values={"duplicate": True}
            )

        # Store the preference
        await runtime.create_memory(
            {
                "entityId": str(message.entity_id),
                "roomId": str(runtime.agent_id),
                "content": {
                    "text": preference["text"],
                    "source": "user_personality_preference",
                },
                "metadata": {
                    "type": MemoryType.CUSTOM,
                    "category": preference["category"],
                    "timestamp": int(time.time() * 1000),
                    "originalRequest": message_text[:200],
                },
            },
            USER_PREFS_TABLE,
        )

        msg = (
            f'Got it! I\'ll remember that for our interactions: "{preference["text"]}". '
            "This only affects how I interact with you, not my core personality."
        )
        if callback:
            await callback(Content(text=msg, actions=["MODIFY_CHARACTER"]))

        logger.info(
            "Stored per-user preference: userId=%s, text=%s, category=%s",
            message.entity_id,
            preference["text"],
            preference["category"],
        )

        return ActionResult(
            text=f"Stored user preference: {preference['text']}",
            success=True,
            values={"preferenceStored": True, "preferenceText": preference["text"]},
            data={"action": "MODIFY_CHARACTER", "preferenceData": preference},
        )
    except Exception as e:
        logger.error("Error storing user preference: %s", e)
        if callback:
            await callback(
                Content(text="I encountered an error saving your preference. Please try again.")
            )
        return ActionResult(
            text="Error storing preference", success=False, values={"error": str(e)}
        )


# ---------------------------------------------------------------------------
# Helper: extract evolution modification from metadata
# ---------------------------------------------------------------------------


def _extract_evolution_modification(metadata: dict[str, Any] | None) -> dict[str, Any] | None:
    if not metadata:
        return None
    raw_data = metadata.get("evolutionData")
    if isinstance(raw_data, str):
        try:
            raw_data = json.loads(raw_data)
        except (json.JSONDecodeError, TypeError):
            return None
    if not isinstance(raw_data, dict):
        return None
    mods = raw_data.get("modifications")
    return mods if isinstance(mods, dict) and mods else None


# ---------------------------------------------------------------------------
# Action: validate
# ---------------------------------------------------------------------------


async def _validate(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | None = None,
) -> bool:
    file_manager = runtime.get_service(PERSONALITY_SERVICE_TYPE)
    if not file_manager or not isinstance(file_manager, CharacterFileManager):
        return False

    message_text = message.content.text or ""
    intent_result = _detect_intent_by_rules(message_text)

    # Check for evolution suggestions
    evolution_suggestions = await runtime.get_memories(
        {
            "entityId": str(runtime.agent_id),
            "roomId": str(message.room_id),
            "count": 5,
            "tableName": "character_evolution",
        }
    )

    has_recent_evolution = False
    for suggestion in evolution_suggestions:
        meta = suggestion.metadata if hasattr(suggestion, "metadata") else {}
        if isinstance(meta, dict):
            ts = meta.get("timestamp", 0)
            if isinstance(ts, (int, float)) and (time.time() * 1000 - ts) < 30 * 60 * 1000:
                if _extract_evolution_modification(meta) is not None:
                    has_recent_evolution = True
                    break

    if (
        intent_result["intent"]["isModificationRequest"]
        and intent_result["intent"]["requestType"] == "explicit"
    ):
        logger.info("Explicit modification request detected")
        return True

    if has_recent_evolution:
        logger.info("Recent evolution suggestion detected")
        return True

    if intent_result["potentialRequest"]:
        logger.info("Potential modification request detected by heuristic")
        return True

    return False


# ---------------------------------------------------------------------------
# Action: handler
# ---------------------------------------------------------------------------


async def _handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    callback: HandlerCallback | None = None,
    responses: list[Memory] | None = None,
) -> ActionResult:
    try:
        file_manager = runtime.get_service(PERSONALITY_SERVICE_TYPE)
        if not isinstance(file_manager, CharacterFileManager):
            raise RuntimeError("Character file manager service not available")

        handler_options = options if isinstance(options, dict) else None
        message_text, request_source = _resolve_effective_request(message, handler_options)
        scope_hint = _normalize_scope(
            handler_options.get("parameters", {}).get("scope") if handler_options else None
        )
        modification: dict[str, Any] | None = None
        is_user_requested = False

        # Detect modification intent
        mod_intent = await _detect_modification_intent(runtime, message_text)

        if mod_intent.get("isModificationRequest"):
            is_admin = await _check_admin(runtime, message)
            effective_scope = _resolve_scope(scope_hint, is_admin)

            if effective_scope == "user":
                return await _handle_user_preference(runtime, message, message_text, callback)

            is_user_requested = True
            modification = await _parse_user_modification(runtime, message, message_text)
        else:
            # Check for agent-initiated evolution
            evolution_suggestions = await runtime.get_memories(
                {
                    "entityId": str(runtime.agent_id),
                    "roomId": str(message.room_id),
                    "count": 1,
                    "tableName": "character_evolution",
                }
            )
            if evolution_suggestions:
                meta = (
                    evolution_suggestions[0].metadata
                    if hasattr(evolution_suggestions[0], "metadata")
                    else {}
                )
                if isinstance(meta, dict):
                    modification = _extract_evolution_modification(meta)

        if not modification:
            if callback:
                await callback(
                    Content(
                        text="I don't see any clear modification instructions. Could you be more specific about how you'd like me to change?"
                    )
                )
            return ActionResult(
                text="No modification found",
                success=False,
                values={"error": "no_modification_found"},
            )

        # Safety evaluation
        safety = await _evaluate_safety(runtime, modification, message_text)

        if not safety["isAppropriate"]:
            response_text = "I understand you'd like me to change, but I need to decline some of those modifications."
            if safety.get("concerns"):
                response_text += f" My concerns are: {', '.join(safety['concerns'])}."
            response_text += f" {safety.get('reasoning', '')}"

            acceptable = safety.get("acceptableChanges")
            if acceptable and isinstance(acceptable, dict) and acceptable:
                response_text += (
                    " However, I can work on the appropriate improvements you mentioned."
                )
                modification = acceptable
            else:
                if callback:
                    await callback(Content(text=response_text))
                return ActionResult(
                    text=response_text,
                    success=False,
                    values={"error": "safety_rejection", "concerns": safety.get("concerns", [])},
                )

        # Validate
        validation = file_manager.validate_modification(modification)
        if not validation["valid"]:
            msg = f"I can't make those changes because: {', '.join(validation['errors'])}"
            if callback:
                await callback(Content(text=msg))
            return ActionResult(text=msg, success=False, values={"error": "validation_failed"})

        # Apply
        result = await file_manager.apply_modification(modification)

        if result["success"]:
            summary = _summarize_modification(modification)
            msg = f"I've successfully updated my character. {summary}"
            if callback:
                await callback(Content(text=msg, actions=["MODIFY_CHARACTER"]))

            # Audit log
            try:
                await runtime.create_memory(
                    {
                        "entityId": str(runtime.agent_id),
                        "roomId": str(message.room_id),
                        "content": {
                            "text": f"Character modification completed: {summary}",
                            "source": "character_modification_success",
                        },
                        "metadata": {
                            "type": MemoryType.CUSTOM,
                            "isUserRequested": is_user_requested,
                            "timestamp": int(time.time() * 1000),
                            "requesterId": str(message.entity_id),
                            "modification": {
                                "summary": summary,
                                "fieldsModified": list(modification.keys()),
                            },
                        },
                    },
                    "modifications",
                )
            except Exception as e:
                logger.warning("Character modification success log failed: %s", e)

            return ActionResult(
                text=msg,
                success=True,
                values={
                    "modificationsApplied": True,
                    "summary": summary,
                    "fieldsModified": list(modification.keys()),
                },
                data={
                    "action": "MODIFY_CHARACTER",
                    "modificationData": {
                        "modification": modification,
                        "summary": summary,
                        "isUserRequested": is_user_requested,
                    },
                },
            )
        else:
            msg = f"I couldn't update my character: {result.get('error', 'Unknown error')}"
            if callback:
                await callback(Content(text=msg))
            return ActionResult(text=msg, success=False, values={"error": result.get("error")})

    except Exception as e:
        logger.error("Error in modify character action: %s", e)
        if callback:
            await callback(
                Content(
                    text="I encountered an error while trying to modify my character. Please try again."
                )
            )
        return ActionResult(
            text="Error in character modification",
            success=False,
            values={"error": str(e)},
        )


# ---------------------------------------------------------------------------
# Action definition
# ---------------------------------------------------------------------------


modify_character_action = Action(
    name="MODIFY_CHARACTER",
    similes=[
        "UPDATE_PERSONALITY",
        "CHANGE_PERSONALITY",
        "UPDATE_CHARACTER",
        "CHANGE_CHARACTER",
        "CHANGE_BEHAVIOR",
        "ADJUST_BEHAVIOR",
        "CHANGE_TONE",
        "UPDATE_TONE",
        "CHANGE_STYLE",
        "UPDATE_STYLE",
        "CHANGE_VOICE",
        "CHANGE_RESPONSE_STYLE",
        "UPDATE_RESPONSE_STYLE",
        "EVOLVE_CHARACTER",
        "SELF_MODIFY",
        "SET_RESPONSE_STYLE",
        "SET_LANGUAGE",
        "SET_INTERACTION_MODE",
        "SET_USER_PREFERENCE",
    ],
    description=(
        "Updates the agent's character when a user asks to change personality, tone, "
        "voice, style, response format, language, name, bio, topics, or moderation behavior. "
        "Admins apply global changes; non-admin users are routed to per-user preferences."
    ),
    validate=_validate,
    handler=_handler,
    examples=[
        [
            ActionExample(
                name="{{user}}",
                content=Content(text="Update your personality to have shorter responses"),
            ),
            ActionExample(
                name="{{agent}}",
                content=Content(
                    text="Done -- I've updated my style to keep responses shorter and more concise.",
                    actions=["MODIFY_CHARACTER"],
                ),
            ),
        ],
        [
            ActionExample(
                name="{{user}}",
                content=Content(text="Be less verbose with me"),
            ),
            ActionExample(
                name="{{agent}}",
                content=Content(
                    text='Got it! I\'ll remember that for our interactions: "be less verbose". '
                    "This only affects how I interact with you, not my core personality.",
                    actions=["MODIFY_CHARACTER"],
                ),
            ),
        ],
    ],
)
