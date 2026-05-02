"""Reflection evaluator.

Generates a self-reflective thought on the conversation, then extracts
facts and relationships between entities. Ported from the TypeScript
``reflectionEvaluator``.
"""

from __future__ import annotations

import contextlib
import json
from typing import TYPE_CHECKING, Any

from elizaos.types import Evaluator, EvaluatorResult, HandlerOptions

if TYPE_CHECKING:
    from elizaos.types import ActionResult, IAgentRuntime, Memory, State


REFLECTION_TEMPLATE = """# Task: Generate Agent Reflection, Extract Facts and Relationships

# Entities in Room
{entities_in_room}

# Existing Relationships
{existing_relationships}

# Current Context:
Agent Name: {agent_name}
Room Type: {room_type}
Message Sender: {sender_name} (ID: {sender_id})

# Recent Messages:
{recent_messages}

# Known Facts:
{known_facts}

# Instructions:
1. Generate a self-reflective thought on the conversation about your performance and interaction quality.
2. Extract new facts from the conversation.
3. Identify and describe relationships between entities.
   - The sourceEntityId is the UUID of the entity initiating the interaction.
   - The targetEntityId is the UUID of the entity being interacted with.

Generate a response in the following JSON format:
{{
  "thought": "a self-reflective thought on the conversation",
  "facts": [
      {{
          "claim": "factual statement",
          "type": "fact|opinion|status",
          "in_bio": false,
          "already_known": false
      }}
  ],
  "relationships": [
      {{
          "sourceEntityId": "entity_initiating_interaction",
          "targetEntityId": "entity_being_interacted_with",
          "tags": ["group_interaction", "additional_tag"]
      }}
  ]
}}"""


def _format_facts(facts: list[Any]) -> str:
    """Format fact memories into a text block."""
    lines: list[str] = []
    for fact in reversed(facts):
        content = getattr(fact, "content", None)
        if content:
            text = getattr(content, "text", None) or (
                content.get("text") if isinstance(content, dict) else ""
            )
            if text:
                lines.append(str(text))
    return "\n".join(lines) if lines else "No known facts."


async def _validate(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> bool:
    """Run reflection after enough messages have accumulated since last reflection."""
    if not message.room_id:
        return False

    # Check cache for last processed message
    get_cache = getattr(runtime, "get_cache", None)
    last_message_id = None
    if callable(get_cache):
        cache_key = f"{message.room_id}-reflection-last-processed"
        last_message_id = await get_cache(cache_key)

    # Get recent messages
    get_memories = getattr(runtime, "get_memories", None)
    if not callable(get_memories):
        return False

    get_conv_length = getattr(runtime, "get_conversation_length", None)
    conv_length = get_conv_length() if callable(get_conv_length) else 20
    count = max(conv_length, 10)

    messages = await get_memories(
        table_name="messages",
        room_id=message.room_id,
        count=count,
    )

    if last_message_id:
        # Find the index of the last processed message and only count newer ones
        last_idx = None
        for i, msg in enumerate(messages):
            if getattr(msg, "id", None) == last_message_id:
                last_idx = i
                break
        if last_idx is not None:
            messages = messages[:last_idx]

    reflection_interval = max(1, conv_length // 4)
    return len(messages) > reflection_interval


async def _handler(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
    options: HandlerOptions | None = None,
    responses: list[Memory] | None = None,
    action_results: list[ActionResult] | None = None,
) -> EvaluatorResult:
    """Generate reflection, extract facts and relationships."""
    agent_id = getattr(message, "agent_id", None) or getattr(message, "agentId", None)
    room_id = message.room_id
    entity_id = message.entity_id

    if not agent_id or not room_id:
        return EvaluatorResult.pass_result(score=50, reason="Missing agentId or roomId")

    # Gather context
    get_relationships = getattr(runtime, "get_relationships", None)
    get_memories = getattr(runtime, "get_memories", None)
    get_entities_for_room = getattr(runtime, "get_entities_for_room", None)

    existing_relationships: list[Any] = []
    if callable(get_relationships) and entity_id:
        try:
            existing_relationships = await get_relationships(entity_ids=[entity_id])
        except Exception:
            existing_relationships = []

    entities: list[Any] = []
    if callable(get_entities_for_room):
        try:
            entities = await get_entities_for_room(room_id)
        except Exception:
            entities = []

    known_facts: list[Any] = []
    if callable(get_memories):
        try:
            known_facts = await get_memories(
                table_name="facts",
                room_id=room_id,
                count=30,
                unique=True,
            )
        except Exception:
            known_facts = []

    # Build prompt
    character = getattr(runtime, "character", None)
    agent_name = getattr(character, "name", "Agent") if character else "Agent"
    sender_name = ""
    if state:
        sender_name = getattr(state, "sender_name", "") or getattr(state, "senderName", "")
    channel_type = (
        getattr(message.content, "channel_type", "unknown") if message.content else "unknown"
    )

    prompt = REFLECTION_TEMPLATE.format(
        entities_in_room=json.dumps([str(e) for e in entities] if entities else [], indent=2),
        existing_relationships=json.dumps(
            [str(r) for r in existing_relationships] if existing_relationships else [],
            indent=2,
        ),
        agent_name=agent_name,
        room_type=str(channel_type),
        sender_name=sender_name or str(entity_id),
        sender_id=str(entity_id) if entity_id else "unknown",
        recent_messages=(state.text if state and hasattr(state, "text") and state.text else ""),
        known_facts=_format_facts(known_facts),
    )

    # Call model for reflection
    use_model = getattr(runtime, "use_model", None)
    if not callable(use_model):
        return EvaluatorResult.pass_result(
            score=50, reason="Model API not available for reflection"
        )

    try:
        reflection = await use_model("OBJECT_SMALL", prompt=prompt)
    except Exception:
        return EvaluatorResult.pass_result(score=50, reason="Reflection model call failed")

    if not reflection or not isinstance(reflection, dict):
        return EvaluatorResult.pass_result(
            score=50, reason="Reflection returned empty or invalid response"
        )

    facts = reflection.get("facts", [])
    relationships = reflection.get("relationships", [])

    if not isinstance(facts, list) or not isinstance(relationships, list):
        return EvaluatorResult.pass_result(score=50, reason="Reflection returned invalid structure")

    # Store new facts
    new_facts = [
        f
        for f in facts
        if isinstance(f, dict)
        and not f.get("already_known")
        and not f.get("in_bio")
        and isinstance(f.get("claim"), str)
        and f["claim"].strip()
    ]

    add_embedding = getattr(runtime, "add_embedding_to_memory", None)
    create_memory = getattr(runtime, "create_memory", None)

    if callable(add_embedding) and callable(create_memory):
        for fact in new_facts:
            try:
                fact_memory = await add_embedding(
                    {
                        "entity_id": agent_id,
                        "agent_id": agent_id,
                        "content": {"text": fact["claim"]},
                        "room_id": room_id,
                    }
                )
                await create_memory(fact_memory, "facts", True)
            except Exception:
                pass

    # Process relationships
    update_relationship = getattr(runtime, "update_relationship", None)
    create_relationship = getattr(runtime, "create_relationship", None)

    if callable(create_relationship):
        for raw_rel in relationships:
            if not isinstance(raw_rel, dict):
                continue
            source_id = raw_rel.get("sourceEntityId")
            target_id = raw_rel.get("targetEntityId")
            tags = raw_rel.get("tags", [])
            if (
                not isinstance(source_id, str)
                or not isinstance(target_id, str)
                or not isinstance(tags, list)
            ):
                continue

            tags = [t for t in tags if isinstance(t, str)]

            # Check if relationship already exists
            existing = None
            for rel in existing_relationships:
                rel_source = getattr(rel, "source_entity_id", None) or getattr(
                    rel, "sourceEntityId", None
                )
                rel_target = getattr(rel, "target_entity_id", None) or getattr(
                    rel, "targetEntityId", None
                )
                if str(rel_source) == source_id and str(rel_target) == target_id:
                    existing = rel
                    break

            if existing and callable(update_relationship):
                existing_meta = getattr(existing, "metadata", {}) or {}
                interactions = (existing_meta.get("interactions") or 0) + 1
                existing_tags = getattr(existing, "tags", []) or []
                merged_tags = list(set(list(existing_tags) + tags))
                try:
                    base = vars(existing) if hasattr(existing, "__dict__") else {}
                    update_data = {
                        **base,
                        "tags": merged_tags,
                        "metadata": {**existing_meta, "interactions": interactions},
                    }
                    await update_relationship(update_data)
                except Exception:
                    pass
            else:
                with contextlib.suppress(Exception):
                    await create_relationship(
                        {
                            "sourceEntityId": source_id,
                            "targetEntityId": target_id,
                            "tags": tags,
                            "metadata": {"interactions": 1},
                        }
                    )

    # Update cache with last processed message
    set_cache = getattr(runtime, "set_cache", None)
    if callable(set_cache) and message.id:
        with contextlib.suppress(Exception):
            await set_cache(
                f"{room_id}-reflection-last-processed",
                str(message.id),
            )

    thought = reflection.get("thought", "")
    return EvaluatorResult.pass_result(
        score=75,
        reason=f"Reflection complete: {len(new_facts)} new facts, "
        f"{len(relationships)} relationships processed. "
        f"Thought: {thought[:100] if thought else '(none)'}",
    )


reflection_evaluator = Evaluator(
    name="REFLECTION",
    description=(
        "Generate a self-reflective thought on the conversation, then "
        "extract facts and relationships between entities."
    ),
    handler=_handler,
    validate=_validate,
)
