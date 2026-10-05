"""Legacy corpus adapters: dialogue."""

from __future__ import annotations
import json
import re
from typing import Any
from ..eliza_record import (
    ACTION_IGNORE,
    ACTION_RESPOND,
    REPLY_ACTIONS,
    ROUTING_ACTIONS,
    build,
    stable_id,
)


def dialogue_raw(records, *, slug, license, split, encoder):
    """Raw chat datasets (Discord/Telegram). The normalizer treats these as
    *unmolded* multi-turn corpora — we don't build supervised records here.
    Instead, the dialogue routing synthesizer reads `data/raw/<slug>/` later
    to mix conversations and label RESPOND/IGNORE turns. Yield nothing.
    """
    if False:
        yield  # type: ignore[unreachable]
    return


_LIGHT_PRIMARY_CONTEXT = "light-fantasy-roleplay"


def _light_has_addressing(text: str, speaker: str) -> bool:
    """Does `text` directly address `speaker`? (mention / leading vocative /
    standalone name token)."""
    if not text or not speaker:
        return False
    s = speaker.strip().lower()
    if not s or s in {"user", "human", "ai", "assistant", "bot"}:
        return False
    t = text.lower()
    if f"@{s}" in t:
        return True
    if re.search(rf"^\s*{re.escape(s)}\s*[,:?!\.]", t, re.I):
        return True
    if re.search(rf"\b{re.escape(s)}\b", t, re.I):
        return True
    return False


def _light_persona_for(characters: list[dict[str, Any]], name: str) -> str:
    for ch in characters or []:
        if (ch.get("name") or "").lower() == (name or "").lower():
            persona = (ch.get("persona") or "").strip()
            desc = (ch.get("desc") or "").strip()
            if persona and desc and persona != desc:
                return f"{persona}\n\n{desc}"
            return persona or desc
    return ""


def _light_memory_from_turns(
    turns: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    return [
        {
            "role": "user",
            "speaker": t.get("speaker") or "user",
            "content": t.get("text") or "",
            "channel": "public",
        }
        for t in turns
        if (t.get("text") or "").strip()
    ]


def light_multilight(records, *, slug, license, split, encoder):
    """Facebook LIGHT MultiLIGHT — multi-party fantasy text-adventure dialogues.

    Source schema (one conversation per JSONL line, produced by our preproc
    of the upstream EpisodeDB tarball):

        {
          "episode_id": "EPI-…",
          "split":      "train" | "validation" | "test",
          "location":   {"name", "description", "extra_desc"},
          "characters": [{"name", "persona", "desc"} × 3],
          "messages":   [{"speaker", "text", "timestamp"} …]
        }

    Each conversation has exactly 3 named characters speaking in turn. For
    every message at index i ≥ 1 we walk it from the perspective of the
    speaker at index i (the "agent") and emit:

      - one `should_respond_with_context` record where the latest other
        character's turn is `currentMessage` and the agent decides
        RESPOND (because it actually spoke next) — yielding a positive
        routing label.

      - one `should_respond_with_context` record from the perspective of
        each *other* character at the same point: their `currentMessage`
        is the same latest other-character turn, and their target action
        is IGNORE (they did NOT speak next). This yields negatives without
        synthesis.

      - one `reply` record for the agent that actually spoke, training the
        model to produce the exact line the corpus shows.

    All routing targets render as the canonical structured document
    `{name, reasoning, action, primaryContext, secondaryContexts,
    evidenceTurnIds}`; reply targets render as `{thought, text}`.
    """
    for r in records:
        if not isinstance(r, dict):
            continue
        messages = r.get("messages") or []
        characters = r.get("characters") or []
        if len(messages) < 2 or not characters:
            continue
        episode_id = r.get("episode_id") or stable_id(slug, json.dumps(messages))
        location = r.get("location") or {}
        location_name = (location.get("name") or "").strip()
        location_desc = (location.get("description") or "").strip()
        rec_split = r.get("split") or split or "train"

        all_speakers = [
            (ch.get("name") or "").strip()
            for ch in characters
            if (ch.get("name") or "").strip()
        ]
        if not all_speakers:
            continue

        for i in range(1, len(messages)):
            spoken = messages[i]
            actual_speaker = (spoken.get("speaker") or "").strip()
            actual_text = (spoken.get("text") or "").strip()
            if not actual_speaker or not actual_text:
                continue

            # The latest non-actual-speaker turn before i is what the agent
            # is "responding to". For multi-party we just take messages[i-1]
            # — that's the conversation as played out.
            prev = messages[i - 1]
            prev_speaker = (prev.get("speaker") or "").strip()
            prev_text = (prev.get("text") or "").strip()
            if not prev_speaker or not prev_text:
                continue

            # Skip if the previous message is from the same speaker — the
            # multiparty pattern needs a different "current" speaker.
            if prev_speaker.lower() == actual_speaker.lower():
                continue

            context_turns = messages[: i - 1]

            current_msg = {
                "role": "user",
                "speaker": prev_speaker,
                "content": prev_text,
                "channel": "public",
            }
            memory = _light_memory_from_turns(context_turns)

            # ------ Positive routing record (the speaker that actually spoke)
            agent_persona = _light_persona_for(characters, actual_speaker)
            addressed = _light_has_addressing(prev_text, actual_speaker)
            reasoning = (
                f"{actual_speaker} is named/addressed in the prior turn, so "
                "they should reply."
                if addressed
                else f"It is {actual_speaker}'s turn in the conversation, so "
                "they should reply."
            )
            target = {
                "name": actual_speaker,
                "reasoning": reasoning,
                "action": ACTION_RESPOND,
                "primaryContext": _LIGHT_PRIMARY_CONTEXT,
                "secondaryContexts": location_name,
                "evidenceTurnIds": "",
            }
            md_routing: dict[str, Any] = {
                "episode_id": episode_id,
                "agent_name": actual_speaker,
                "synth_target_action": ACTION_RESPOND,
                "task_type_handler": "should_respond",
                "addressed_by_name": addressed,
                "location_name": location_name,
                "num_speakers": len(all_speakers),
            }
            if agent_persona:
                md_routing["persona"] = agent_persona
            if location_desc:
                md_routing["location_description"] = location_desc

            yield build(
                roomName=stable_id(slug, episode_id, i, "respond", actual_speaker),
                agentId=actual_speaker.lower(),
                memoryEntries=memory,
                currentMessage=current_msg,
                expectedResponse=encoder.encode(target),
                availableActions=ROUTING_ACTIONS.copy(),
                task_type="should_respond_with_context",
                source_dataset=slug,
                license=license,
                split=rec_split,
                extra_metadata=md_routing,
            )

            # ------ Negative routing records: each other named character
            # who did NOT speak at turn i. Ground-truth IGNORE label.
            for other in all_speakers:
                if other.lower() == actual_speaker.lower():
                    continue
                if other.lower() == prev_speaker.lower():
                    # The prior speaker isn't expected to immediately respond
                    # to themselves; conventionally we still yield this as
                    # IGNORE, but skip to keep records cleaner — they just
                    # spoke.
                    continue
                other_persona = _light_persona_for(characters, other)
                other_addressed = _light_has_addressing(prev_text, other)
                other_reasoning = (
                    f"{other} is not named or addressed in the prior turn, "
                    f"and {actual_speaker} is the one taking the turn."
                    if not other_addressed
                    else f"Although {other} could plausibly speak, "
                    f"{actual_speaker} takes this turn instead."
                )
                neg_target = {
                    "name": other,
                    "reasoning": other_reasoning,
                    "action": ACTION_IGNORE,
                    "primaryContext": _LIGHT_PRIMARY_CONTEXT,
                    "secondaryContexts": location_name,
                    "evidenceTurnIds": "",
                }
                md_neg: dict[str, Any] = {
                    "episode_id": episode_id,
                    "agent_name": other,
                    "synth_target_action": ACTION_IGNORE,
                    "task_type_handler": "should_respond",
                    "addressed_by_name": other_addressed,
                    "location_name": location_name,
                    "num_speakers": len(all_speakers),
                    "actual_speaker": actual_speaker,
                }
                if other_persona:
                    md_neg["persona"] = other_persona
                if location_desc:
                    md_neg["location_description"] = location_desc

                yield build(
                    roomName=stable_id(slug, episode_id, i, "ignore", other),
                    agentId=other.lower(),
                    memoryEntries=memory,
                    currentMessage=current_msg,
                    expectedResponse=encoder.encode(neg_target),
                    availableActions=ROUTING_ACTIONS.copy(),
                    task_type="should_respond_with_context",
                    source_dataset=slug,
                    license=license,
                    split=rec_split,
                    extra_metadata=md_neg,
                )

            # ------ Reply record for the agent that actually spoke. The
            # supervised target is `{thought, text}` rendered with the configured expected-response encoder.
            reply_target = {
                "thought": (
                    f"As {actual_speaker}, I respond to {prev_speaker} in "
                    f"{location_name}."
                    if location_name
                    else f"As {actual_speaker}, I respond to {prev_speaker}."
                ),
                "text": actual_text,
            }
            md_reply: dict[str, Any] = {
                "episode_id": episode_id,
                "agent_name": actual_speaker,
                "task_type_handler": "reply",
                "location_name": location_name,
                "num_speakers": len(all_speakers),
            }
            if agent_persona:
                md_reply["persona"] = agent_persona
            if location_desc:
                md_reply["location_description"] = location_desc

            yield build(
                roomName=stable_id(slug, episode_id, i, "reply", actual_speaker),
                agentId=actual_speaker.lower(),
                memoryEntries=memory,
                currentMessage=current_msg,
                expectedResponse=encoder.encode(reply_target),
                availableActions=REPLY_ACTIONS.copy(),
                task_type="reply",
                source_dataset=slug,
                license=license,
                split=rec_split,
                extra_metadata=md_reply,
            )
