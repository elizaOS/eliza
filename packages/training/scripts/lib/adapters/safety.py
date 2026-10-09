"""Legacy corpus adapters: safety."""

from __future__ import annotations
import json
from typing import Any
from ..eliza_record import (
    REPLY_ACTIONS,
    build,
    stable_id,
)
from .common import (
    _planner_ignore_envelope,
    _planner_reply_envelope,
    _split_think_response,
)
from .tools import _normalize_scam_actions

_LEGITIMATE_CATEGORIES = {
    "legitimate",
    "benign",
    "banking-inquiry",
    "security-inquiry",
    "small-talk",
    "general",
}


def _scam_defense_flag(category: str | None) -> bool:
    if not category:
        return False
    if category.startswith("legitimate"):
        return False
    return category not in _LEGITIMATE_CATEGORIES


def _normalize_action(action: str) -> str:
    """request-verification → request_verification (match scambench shape)."""
    return action.replace("-", "_").strip().lower() if action else ""


def _parse_scam_user_prompt(
    prompt: str,
) -> tuple[dict[str, Any] | None, list[dict[str, str]]]:
    """Split the scam-defense userPrompt into (runtime_context, transcript).

    The userPrompt has the shape:

        Runtime context:
        { ...JSON... }

        Conversation transcript:
        [Speaker]: line
        [Speaker]: line
        ...
    """
    ctx: dict[str, Any] | None = None
    transcript: list[dict[str, str]] = []

    parts = prompt.split("Conversation transcript:", 1)
    if len(parts) == 2:
        head, tail = parts
        # Find the runtime-context JSON object
        ctx_start = head.find("{")
        if ctx_start != -1:
            depth = 0
            for i, ch in enumerate(head[ctx_start:], start=ctx_start):
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        try:
                            ctx = json.loads(head[ctx_start : i + 1])
                        except json.JSONDecodeError:
                            ctx = None
                        break
        body = tail
    else:
        body = prompt

    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not line.startswith("["):
            continue
        end = line.find("]:")
        if end == -1:
            continue
        speaker = line[1:end].strip()
        content = line[end + 2 :].strip()
        if not speaker or not content:
            continue
        transcript.append({"speaker": speaker, "content": content})
    return ctx, transcript


def scam_defense_corpus(records, *, slug, license, split, encoder):
    """Full-corpus-unweighted scam-defense trajectories.

    Each record is `{"trajectory": {steps: [{llmCalls: [...]}]}}`. Each
    llmCall has systemPrompt, userPrompt (runtime_context + transcript),
    response (often `<think>…</think>\\n<final text>`). Emits one
    ElizaRecord per llmCall with task_type=`scam_defense` and
    expectedResponse passed through verbatim (preserves the `<think>`
    block alongside the final reply).
    """
    seen: set[str] = set()
    for r in records:
        traj = r.get("trajectory") or {}
        agent_id = str(traj.get("agentId") or "agent")
        traj_id = str(traj.get("id") or traj.get("trajectoryId") or "")
        archetype = traj.get("archetype") or ""
        meta_json: dict[str, Any] = {}
        raw_meta = traj.get("metadataJson")
        if isinstance(raw_meta, str):
            try:
                meta_json = json.loads(raw_meta)
            except json.JSONDecodeError:
                meta_json = {}
        elif isinstance(raw_meta, dict):
            meta_json = raw_meta

        for step in traj.get("steps") or []:
            for call_idx, call in enumerate(step.get("llmCalls") or []):
                sys_prompt = str(call.get("systemPrompt") or "")
                user_prompt = str(call.get("userPrompt") or "")
                response = str(call.get("response") or "")
                if not user_prompt or not response:
                    continue

                ctx, transcript = _parse_scam_user_prompt(user_prompt)
                if not transcript:
                    continue

                memory = [
                    {
                        "role": "assistant" if t["speaker"] == agent_id else "user",
                        "speaker": t["speaker"],
                        "content": t["content"],
                        "channel": "dm",
                    }
                    for t in transcript[:-1]
                ]
                last = transcript[-1]
                # Drop trailing agent turns; we want the most recent inbound turn
                # as currentMessage so the supervised target is the next reply.
                while memory and last["speaker"] == agent_id:
                    last = memory.pop()
                if last["speaker"] == agent_id:
                    continue
                current = {
                    "role": "user",
                    "speaker": last["speaker"],
                    "content": last["content"],
                    "channel": "dm",
                }

                dedup = stable_id(
                    traj_id, step.get("stepNumber", 0), call_idx, response
                )
                if dedup in seen:
                    continue
                seen.add(dedup)

                action = step.get("action") or {}
                action_type = action.get("actionType") or call.get("actionType") or ""
                params = action.get("parameters") or {}
                chosen_action = (
                    params.get("chosenAction") or meta_json.get("chosenAction") or ""
                )
                avail = []
                if isinstance(ctx, dict):
                    for a in ctx.get("availableActions") or []:
                        if isinstance(a, dict) and a.get("name"):
                            avail.append(a["name"])
                if not avail:
                    avail = REPLY_ACTIONS.copy()
                # Normalize lowercase scam-defense decision names
                # (refuse / escalate / accept / etc.) to canonical eliza
                # actions (REPLY / IGNORE) — eliza runtime parsers expect
                # uppercase.
                avail = _normalize_scam_actions(avail)

                category = meta_json.get("category")
                reasoning, final_text = _split_think_response(response)
                # Prefer the action.result.responseText when present — that's
                # the canonical agent reply; the LLM `response` field may
                # carry trailing chain-of-thought we already split out.
                result_text = ""
                if isinstance(action.get("result"), dict):
                    result_text = str(action["result"].get("responseText") or "")
                final_response = result_text or final_text

                # Map the upstream decision class to a planner-envelope
                # action (PIPELINE_SCHEMAS.md §9). `block` / `ignore` /
                # `decline` / `refuse` → IGNORE; everything else → REPLY.
                norm_action = _normalize_action(chosen_action).lower()
                if norm_action in (
                    "ignore",
                    "block",
                    "decline_to_answer",
                    "decline",
                    "refuse",
                ):
                    target = _planner_ignore_envelope(
                        thought=reasoning,
                        text=final_response,
                        seed=final_response,
                    )
                else:
                    target = _planner_reply_envelope(
                        thought=reasoning,
                        text=final_response,
                        providers=[],
                        seed=final_response,
                    )
                target = encoder.encode(target)

                md: dict[str, Any] = {
                    "original_id": dedup,
                    "trajectory_id": traj_id,
                    "step_number": step.get("stepNumber"),
                    "call_index": call_idx,
                    "archetype": archetype,
                    "purpose": call.get("purpose"),
                    "action_type": action_type,
                    "chosen_action": chosen_action,
                    "category": category,
                    "scenario_category": category,
                    "should_trigger_scam_defense": _scam_defense_flag(category),
                    "language": meta_json.get("language"),
                    "style_variant": meta_json.get("styleVariant"),
                    "scenario_profile": meta_json.get("scenarioProfile"),
                    "source_pool": meta_json.get("sourcePool"),
                    "has_reasoning": meta_json.get("hasReasoning"),
                    "reasoning_source": call.get("reasoningSource"),
                    "reward": step.get("reward"),
                }
                if sys_prompt:
                    md["system_prompt"] = sys_prompt
                if isinstance(ctx, dict):
                    md["runtime_context"] = ctx

                yield build(
                    roomName=stable_id(slug, dedup),
                    agentId=agent_id,
                    memoryEntries=memory,
                    currentMessage=current,
                    expectedResponse=target,
                    availableActions=avail,
                    task_type="scam_defense",
                    source_dataset=slug,
                    license=license,
                    split=split,
                    extra_metadata=md,
                )
