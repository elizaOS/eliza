from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol
from uuid import UUID

from elizaos_plugin_memory.types import SummaryResult

if TYPE_CHECKING:
    from elizaos_plugin_memory.services.memory_service import MemoryService

logger = logging.getLogger(__name__)


INITIAL_SUMMARIZATION_TEMPLATE = """# Task: Summarize Conversation

You are analyzing a conversation to create a concise summary that captures the key points, topics, and important details.

# Recent Messages
{recent_messages}

# Instructions
Generate a summary that:
1. Captures the main topics discussed
2. Highlights key information shared
3. Notes any decisions made or questions asked
4. Maintains context for future reference
5. Is concise but comprehensive

**IMPORTANT**: Keep the summary under 2500 tokens. Be comprehensive but concise.

Also extract:
- **Topics**: List of main topics discussed (comma-separated)
- **Key Points**: Important facts or decisions (bullet points)

Respond in this XML format:
<summary>
  <text>Your comprehensive summary here</text>
  <topics>topic1, topic2, topic3</topics>
  <keyPoints>
    <point>First key point</point>
    <point>Second key point</point>
  </keyPoints>
</summary>"""

UPDATE_SUMMARIZATION_TEMPLATE = """# Task: Update and Condense Conversation Summary

You are updating an existing conversation summary with new messages, while keeping the total summary concise.

# Existing Summary
{existing_summary}

# Existing Topics
{existing_topics}

# New Messages Since Last Summary
{new_messages}

# Instructions
Update the summary by:
1. Merging the existing summary with insights from the new messages
2. Removing redundant or less important details to stay under the token limit
3. Keeping the most important context and decisions
4. Adding new topics if they emerge
5. **CRITICAL**: Keep the ENTIRE updated summary under 2500 tokens

Respond in this XML format:
<summary>
  <text>Your updated and condensed summary here</text>
  <topics>topic1, topic2, topic3</topics>
  <keyPoints>
    <point>First key point</point>
    <point>Second key point</point>
  </keyPoints>
</summary>"""


def parse_summary_xml(xml: str) -> SummaryResult:
    summary_match = re.search(r"<text>([\s\S]*?)</text>", xml)
    topics_match = re.search(r"<topics>([\s\S]*?)</topics>", xml)
    key_points_matches = re.findall(r"<point>([\s\S]*?)</point>", xml)

    summary = summary_match.group(1).strip() if summary_match else "Summary not available"
    topics = (
        [t.strip() for t in topics_match.group(1).split(",") if t.strip()] if topics_match else []
    )
    key_points = [p.strip() for p in key_points_matches]

    return SummaryResult(summary=summary, topics=topics, key_points=key_points)


class ModelHandler(Protocol):
    async def generate(self, prompt: str, max_tokens: int = 2500) -> str: ...


@dataclass
class Message:
    entity_id: UUID
    content_text: str
    content_type: str | None = None
    metadata_type: str | None = None
    created_at: int = 0


class SummarizationEvaluator:
    name: str = "MEMORY_SUMMARIZATION"
    description: str = "Automatically summarizes conversations to optimize context usage"
    similes: list[str] = ["CONVERSATION_SUMMARY", "CONTEXT_COMPRESSION", "MEMORY_OPTIMIZATION"]
    always_run: bool = True

    def __init__(
        self,
        memory_service: MemoryService,
        model_handler: ModelHandler,
        agent_id: UUID,
        agent_name: str = "Agent",
    ) -> None:
        self._memory_service = memory_service
        self._model_handler = model_handler
        self._agent_id = agent_id
        self._agent_name = agent_name

    async def validate(
        self,
        room_id: UUID,
        message_text: str | None,
        dialogue_messages: list[Message],
    ) -> bool:
        if not message_text:
            return False

        config = self._memory_service.get_config()
        current_dialogue_count = len(dialogue_messages)
        existing_summary = await self._memory_service.get_current_session_summary(room_id)

        if not existing_summary:
            return current_dialogue_count >= config.short_term_summarization_threshold
        else:
            new_dialogue_count = current_dialogue_count - existing_summary.last_message_offset
            return new_dialogue_count >= config.short_term_summarization_interval

    async def handle(
        self,
        room_id: UUID,
        entity_id: UUID,
        dialogue_messages: list[Message],
    ) -> None:
        config = self._memory_service.get_config()

        try:
            logger.info("Starting summarization for room %s", room_id)

            existing_summary = await self._memory_service.get_current_session_summary(room_id)
            last_offset = existing_summary.last_message_offset if existing_summary else 0

            filtered_messages = [
                msg
                for msg in dialogue_messages
                if not (
                    msg.content_type == "action_result" and msg.metadata_type == "action_result"
                )
                and msg.metadata_type in ("agent_response_message", "user_message")
            ]

            total_dialogue_count = len(filtered_messages)
            new_dialogue_count = total_dialogue_count - last_offset

            if new_dialogue_count == 0:
                logger.debug("No new dialogue messages to summarize")
                return

            max_new_messages = config.summary_max_new_messages
            messages_to_process = min(new_dialogue_count, max_new_messages)

            if new_dialogue_count > max_new_messages:
                logger.warning(
                    "Capping new dialogue messages at %d (%d available)",
                    max_new_messages,
                    new_dialogue_count,
                )

            sorted_messages = sorted(filtered_messages, key=lambda m: m.created_at)
            new_messages = sorted_messages[last_offset : last_offset + messages_to_process]

            if not new_messages:
                logger.debug("No new dialogue messages retrieved after filtering")
                return

            formatted_messages = "\n".join(
                f"{self._agent_name if msg.entity_id == self._agent_id else 'User'}: "
                f"{msg.content_text or '[non-text message]'}"
                for msg in new_messages
            )

            if existing_summary:
                prompt = UPDATE_SUMMARIZATION_TEMPLATE.format(
                    existing_summary=existing_summary.summary,
                    existing_topics=", ".join(existing_summary.topics)
                    if existing_summary.topics
                    else "None",
                    new_messages=formatted_messages,
                )
            else:
                initial_messages = "\n".join(
                    f"{self._agent_name if msg.entity_id == self._agent_id else 'User'}: "
                    f"{msg.content_text or '[non-text message]'}"
                    for msg in sorted_messages
                )
                prompt = INITIAL_SUMMARIZATION_TEMPLATE.format(recent_messages=initial_messages)

            response = await self._model_handler.generate(prompt, config.summary_max_tokens)

            summary_result = parse_summary_xml(response)

            logger.info(
                "%s summary: %s...",
                "Updated" if existing_summary else "Generated",
                summary_result.summary[:100],
            )

            new_offset = last_offset + len(new_messages)
            first_message = new_messages[0]
            last_message = new_messages[-1]

            from datetime import datetime

            start_time = (
                existing_summary.start_time
                if existing_summary
                else (
                    datetime.fromtimestamp(first_message.created_at / 1000)
                    if first_message.created_at > 0
                    else datetime.now()
                )
            )
            end_time = (
                datetime.fromtimestamp(last_message.created_at / 1000)
                if last_message.created_at > 0
                else datetime.now()
            )

            if existing_summary:
                await self._memory_service.update_session_summary(
                    existing_summary.id,
                    room_id,
                    summary=summary_result.summary,
                    message_count=existing_summary.message_count + len(new_messages),
                    last_message_offset=new_offset,
                    end_time=end_time,
                    topics=summary_result.topics,
                    metadata={"keyPoints": summary_result.key_points},
                )
                logger.info(
                    "Updated summary for room %s: %d new dialogue messages processed",
                    room_id,
                    len(new_messages),
                )
            else:
                await self._memory_service.store_session_summary(
                    agent_id=self._agent_id,
                    room_id=room_id,
                    entity_id=entity_id if entity_id != self._agent_id else None,
                    summary=summary_result.summary,
                    message_count=total_dialogue_count,
                    last_message_offset=total_dialogue_count,
                    start_time=start_time,
                    end_time=end_time,
                    topics=summary_result.topics,
                    metadata={"keyPoints": summary_result.key_points},
                )
                logger.info(
                    "Created new summary for room %s: %d dialogue messages summarized",
                    room_id,
                    total_dialogue_count,
                )

        except Exception as e:
            logger.error("Error during summarization: %s", e)
