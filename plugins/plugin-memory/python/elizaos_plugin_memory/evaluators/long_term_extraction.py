from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol
from uuid import UUID

from elizaos_plugin_memory.types import LongTermMemoryCategory, MemoryExtraction

if TYPE_CHECKING:
    from elizaos_plugin_memory.services.memory_service import MemoryService

logger = logging.getLogger(__name__)


EXTRACTION_TEMPLATE = """# Task: Extract Long-Term Memory (Strict Criteria)

You are analyzing a conversation to extract ONLY the most critical, persistent information about the user using cognitive science memory categories.

# Recent Messages
{recent_messages}

# Current Long-Term Memories
{existing_memories}

# Memory Categories (Based on Cognitive Science)

## 1. EPISODIC Memory
Personal experiences and specific events with temporal/spatial context.
**Requirements:**
- Must include WHO did WHAT, WHEN/WHERE
- Must be a specific, concrete event (not a pattern)
- Must have significant impact or relevance to future work

## 2. SEMANTIC Memory
General facts, concepts, knowledge, and established truths about the user.
**Requirements:**
- Must be factual, timeless information
- Must be explicitly stated or demonstrated conclusively
- Core identity, expertise, or knowledge only

## 3. PROCEDURAL Memory
Skills, workflows, methodologies, and how-to knowledge.
**Requirements:**
- Must describe HOW user does something
- Must be a repeated, consistent pattern
- Must be a workflow, methodology, or skill application

# Quality Gates (ALL Must Pass)
1. **Significance Test**: Will this matter in 3+ months?
2. **Specificity Test**: Is this concrete and actionable?
3. **Evidence Test**: Is there strong evidence?
4. **Uniqueness Test**: Is this specific to THIS user?
5. **Confidence Test**: Confidence must be >= 0.85

**If there are no qualifying facts, respond with <memories></memories>**

# Response Format

<memories>
  <memory>
    <category>semantic</category>
    <content>User is a senior TypeScript developer with 8 years of backend experience</content>
    <confidence>0.95</confidence>
  </memory>
</memories>"""


def parse_memory_extraction_xml(xml: str) -> list[MemoryExtraction]:
    pattern = (
        r"<memory>[\s\S]*?"
        r"<category>(.*?)</category>[\s\S]*?"
        r"<content>(.*?)</content>[\s\S]*?"
        r"<confidence>(.*?)</confidence>[\s\S]*?"
        r"</memory>"
    )

    extractions: list[MemoryExtraction] = []

    for match in re.finditer(pattern, xml):
        category_str = match.group(1).strip()
        content = match.group(2).strip()
        confidence_str = match.group(3).strip()

        try:
            category = LongTermMemoryCategory(category_str)
        except ValueError:
            logger.warning("Invalid memory category: %s", category_str)
            continue

        try:
            confidence = float(confidence_str)
        except ValueError:
            logger.warning("Invalid confidence value: %s", confidence_str)
            continue

        if content:
            extractions.append(
                MemoryExtraction(
                    category=category,
                    content=content,
                    confidence=confidence,
                )
            )

    return extractions


class ModelHandler(Protocol):
    async def generate(self, prompt: str, max_tokens: int = 2000) -> str: ...


class MemoryCounter(Protocol):
    async def count_memories(self, room_id: UUID) -> int: ...


@dataclass
class Message:
    entity_id: UUID
    content_text: str
    created_at: int = 0


class LongTermExtractionEvaluator:
    name: str = "LONG_TERM_MEMORY_EXTRACTION"
    description: str = "Extracts long-term facts about users from conversations"
    similes: list[str] = ["MEMORY_EXTRACTION", "FACT_LEARNING", "USER_PROFILING"]
    always_run: bool = True

    def __init__(
        self,
        memory_service: MemoryService,
        model_handler: ModelHandler,
        memory_counter: MemoryCounter,
        agent_id: UUID,
        agent_name: str = "Agent",
    ) -> None:
        self._memory_service = memory_service
        self._model_handler = model_handler
        self._memory_counter = memory_counter
        self._agent_id = agent_id
        self._agent_name = agent_name

    async def validate(
        self,
        entity_id: UUID,
        room_id: UUID,
        message_text: str | None,
    ) -> bool:
        if entity_id == self._agent_id:
            return False

        if not message_text:
            return False

        config = self._memory_service.get_config()
        if not config.long_term_extraction_enabled:
            logger.debug("Long-term memory extraction is disabled")
            return False

        current_message_count = await self._memory_counter.count_memories(room_id)

        return await self._memory_service.should_run_extraction(
            entity_id, room_id, current_message_count
        )

    async def handle(
        self,
        entity_id: UUID,
        room_id: UUID,
        recent_messages: list[Message],
    ) -> None:
        config = self._memory_service.get_config()

        try:
            logger.info("Extracting long-term memories for entity %s", entity_id)

            sorted_messages = sorted(recent_messages, key=lambda m: m.created_at)
            formatted_messages = "\n".join(
                f"{self._agent_name if msg.entity_id == self._agent_id else 'User'}: "
                f"{msg.content_text or '[non-text message]'}"
                for msg in sorted_messages
            )

            existing_memories = await self._memory_service.get_long_term_memories(
                entity_id, None, 30
            )
            formatted_existing = (
                "\n".join(
                    f"[{m.category.value}] {m.content} (confidence: {m.confidence})"
                    for m in existing_memories
                )
                if existing_memories
                else "None yet"
            )

            prompt = EXTRACTION_TEMPLATE.format(
                recent_messages=formatted_messages,
                existing_memories=formatted_existing,
            )

            response = await self._model_handler.generate(prompt)

            extractions = parse_memory_extraction_xml(response)

            logger.info("Extracted %d long-term memories", len(extractions))

            for extraction in extractions:
                threshold = max(config.long_term_confidence_threshold, 0.85)
                if extraction.confidence >= threshold:
                    await self._memory_service.store_long_term_memory(
                        agent_id=self._agent_id,
                        entity_id=entity_id,
                        category=extraction.category,
                        content=extraction.content,
                        confidence=extraction.confidence,
                        source="conversation",
                        metadata={
                            "roomId": str(room_id),
                            "extractedAt": __import__("datetime").datetime.now().isoformat(),
                        },
                    )

                    logger.info(
                        "Stored long-term memory: [%s] %s...",
                        extraction.category.value,
                        extraction.content[:50],
                    )
                else:
                    logger.debug(
                        "Skipped low-confidence memory: %s (confidence: %f)",
                        extraction.content,
                        extraction.confidence,
                    )

            current_message_count = await self._memory_counter.count_memories(room_id)
            await self._memory_service.set_last_extraction_checkpoint(
                entity_id, room_id, current_message_count
            )
            logger.debug(
                "Updated extraction checkpoint to %d for entity %s",
                current_message_count,
                entity_id,
            )

        except Exception as e:
            logger.error("Error during long-term memory extraction: %s", e)
