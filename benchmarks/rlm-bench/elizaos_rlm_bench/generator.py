"""
Task generator for RLM benchmarks.

Generates benchmark tasks for S-NIAH, OOLONG, and other RLM-specific tests
following the paper's evaluation methodology.
"""

from __future__ import annotations

import random
import string
import uuid
from typing import Iterator

from .types import (
    HAYSTACK_PARAGRAPHS,
    S_NIAH_NEEDLE_TEMPLATES,
    S_NIAH_QUESTION_TEMPLATES,
    RLMBenchConfig,
    RLMBenchTask,
    RLMBenchType,
    RLMStrategy,
)


def generate_random_value(length: int = 8) -> str:
    """Generate a random alphanumeric value for needles."""
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=length))


def estimate_tokens(text: str) -> int:
    """Rough token estimate (4 characters per token)."""
    return len(text) // 4


class RLMBenchGenerator:
    """Generator for RLM benchmark tasks."""

    def __init__(self, config: RLMBenchConfig) -> None:
        """Initialize the generator with configuration."""
        self.config = config
        self._haystack_paragraphs = HAYSTACK_PARAGRAPHS.copy()

    def generate_haystack(self, target_tokens: int) -> str:
        """
        Generate a haystack context of approximately target_tokens length.

        Paper: Uses repeating document content to achieve long contexts.
        """
        paragraphs = []
        current_tokens = 0

        while current_tokens < target_tokens:
            # Cycle through paragraphs
            para = random.choice(self._haystack_paragraphs)
            paragraphs.append(para)
            current_tokens = estimate_tokens("\n\n".join(paragraphs))

        return "\n\n".join(paragraphs)

    def insert_needle(
        self,
        haystack: str,
        needle: str,
        position_pct: float,
    ) -> str:
        """
        Insert needle at the specified position in haystack.

        Args:
            haystack: The context text
            needle: The information to hide
            position_pct: Position as percentage (0.0 = start, 1.0 = end)

        Returns:
            Haystack with needle inserted
        """
        # Split into paragraphs
        paragraphs = haystack.split("\n\n")

        # Calculate insertion index
        insert_idx = int(len(paragraphs) * position_pct)
        insert_idx = max(0, min(insert_idx, len(paragraphs)))

        # Insert needle as a separate paragraph
        paragraphs.insert(insert_idx, needle)

        return "\n\n".join(paragraphs)

    def generate_s_niah_task(
        self,
        context_length: int,
        position_pct: float,
        num_needles: int = 1,
    ) -> RLMBenchTask:
        """
        Generate a Streaming NIAH task (Paper Table 1).

        Args:
            context_length: Target context length in tokens
            position_pct: Needle position (0.0 = start, 1.0 = end)
            num_needles: Number of needles to insert

        Returns:
            RLMBenchTask configured for S-NIAH
        """
        # Generate haystack
        haystack = self.generate_haystack(context_length)

        # Generate needle(s)
        template_idx = random.randint(0, len(S_NIAH_NEEDLE_TEMPLATES) - 1)
        value = generate_random_value()
        needle = S_NIAH_NEEDLE_TEMPLATES[template_idx].format(value=value)
        question = S_NIAH_QUESTION_TEMPLATES[template_idx]
        expected_answer = value

        # Insert needle
        context = self.insert_needle(haystack, needle, position_pct)

        # Handle multiple needles
        all_values = [value]
        if num_needles > 1:
            for i in range(1, num_needles):
                extra_value = generate_random_value()
                extra_template_idx = (template_idx + i) % len(S_NIAH_NEEDLE_TEMPLATES)
                extra_needle = S_NIAH_NEEDLE_TEMPLATES[extra_template_idx].format(
                    value=extra_value
                )
                extra_position = (position_pct + i * 0.1) % 1.0
                context = self.insert_needle(context, extra_needle, extra_position)
                all_values.append(extra_value)

            # Update question for multi-needle
            question = "List all the secret codes and identifiers found in the text."
            expected_answer = ", ".join(all_values)

        return RLMBenchTask(
            id=f"s_niah_{uuid.uuid4().hex[:8]}",
            bench_type=RLMBenchType.S_NIAH if num_needles == 1 else RLMBenchType.S_NIAH_MULTI,
            context=context,
            context_length_tokens=estimate_tokens(context),
            context_length_chars=len(context),
            question=question,
            expected_answer=expected_answer,
            needle=needle,
            needle_position_pct=position_pct,
            num_needles=num_needles,
            expected_strategies=[RLMStrategy.PEEK, RLMStrategy.GREP],
            metadata={
                "target_length": context_length,
                "actual_length": estimate_tokens(context),
                "position": position_pct,
            },
        )

    def generate_oolong_task(
        self,
        context_length: int,
    ) -> RLMBenchTask:
        """
        Generate an OOLONG task (Paper Table 2).

        OOLONG tests long document retrieval and reasoning.
        """
        # Generate a document with structured information
        doc_id = uuid.uuid4().hex[:8]
        sections = []

        # Create multiple sections with different topics
        topics = [
            ("Introduction", "general overview"),
            ("Methodology", "technical approach"),
            ("Results", "findings and data"),
            ("Discussion", "analysis and implications"),
            ("Conclusion", "summary and future work"),
        ]

        # Hidden answer in one section
        answer_section = random.randint(0, len(topics) - 1)
        answer_value = generate_random_value()

        for i, (title, description) in enumerate(topics):
            section_content = self.generate_haystack(context_length // len(topics))

            if i == answer_section:
                # Insert the key information
                key_fact = f"The critical finding reference number is {answer_value}."
                section_content = self.insert_needle(section_content, key_fact, 0.5)

            sections.append(f"## {title}\n\n{section_content}")

        context = f"# Document {doc_id}\n\n" + "\n\n".join(sections)

        return RLMBenchTask(
            id=f"oolong_{uuid.uuid4().hex[:8]}",
            bench_type=RLMBenchType.OOLONG,
            context=context,
            context_length_tokens=estimate_tokens(context),
            context_length_chars=len(context),
            question="What is the critical finding reference number mentioned in the document?",
            expected_answer=answer_value,
            document_ids=[doc_id],
            expected_strategies=[RLMStrategy.CHUNK, RLMStrategy.GREP, RLMStrategy.STITCH],
            difficulty="hard",
            metadata={
                "target_length": context_length,
                "answer_section": topics[answer_section][0],
            },
        )

    def generate_oolong_pairs_task(
        self,
        context_length: int,
    ) -> RLMBenchTask:
        """
        Generate an OOLONG-Pairs task (Paper Table 2).

        Tests comparison between two documents.
        """
        # Generate two documents with some shared and different information
        doc1_id = uuid.uuid4().hex[:8]
        doc2_id = uuid.uuid4().hex[:8]

        half_length = context_length // 2

        # Shared value that appears in both
        shared_value = generate_random_value()
        # Unique values for each document
        doc1_unique = generate_random_value()
        doc2_unique = generate_random_value()

        # Generate document 1
        doc1_content = self.generate_haystack(half_length)
        doc1_content = self.insert_needle(
            doc1_content,
            f"The shared protocol version is {shared_value}. The document A identifier is {doc1_unique}.",
            0.3,
        )

        # Generate document 2
        doc2_content = self.generate_haystack(half_length)
        doc2_content = self.insert_needle(
            doc2_content,
            f"The shared protocol version is {shared_value}. The document B identifier is {doc2_unique}.",
            0.7,
        )

        context = f"=== Document A ({doc1_id}) ===\n\n{doc1_content}\n\n=== Document B ({doc2_id}) ===\n\n{doc2_content}"

        return RLMBenchTask(
            id=f"oolong_pairs_{uuid.uuid4().hex[:8]}",
            bench_type=RLMBenchType.OOLONG_PAIRS,
            context=context,
            context_length_tokens=estimate_tokens(context),
            context_length_chars=len(context),
            question="What is the shared protocol version between Document A and Document B, and what are their unique identifiers?",
            expected_answer=f"Shared: {shared_value}, A: {doc1_unique}, B: {doc2_unique}",
            document_ids=[doc1_id, doc2_id],
            requires_comparison=True,
            expected_strategies=[
                RLMStrategy.CHUNK,
                RLMStrategy.PEEK,
                RLMStrategy.SUBCALL,
                RLMStrategy.STITCH,
            ],
            difficulty="hard",
            metadata={
                "target_length": context_length,
                "shared_value": shared_value,
                "doc1_unique": doc1_unique,
                "doc2_unique": doc2_unique,
            },
        )

    def generate_all_tasks(self) -> list[RLMBenchTask]:
        """Generate all benchmark tasks based on configuration."""
        tasks: list[RLMBenchTask] = []

        for context_length in self.config.context_lengths:
            # S-NIAH tasks
            if self.config.run_s_niah:
                for position in self.config.s_niah_positions:
                    for _ in range(self.config.tasks_per_config):
                        tasks.append(
                            self.generate_s_niah_task(context_length, position)
                        )

            # S-NIAH Multi tasks
            if self.config.run_s_niah_multi:
                for num_needles in self.config.s_niah_num_needles:
                    if num_needles > 1:
                        for _ in range(self.config.tasks_per_config):
                            tasks.append(
                                self.generate_s_niah_task(
                                    context_length, 0.5, num_needles
                                )
                            )

            # OOLONG tasks
            if self.config.run_oolong:
                for _ in range(self.config.tasks_per_config):
                    tasks.append(self.generate_oolong_task(context_length))

            # OOLONG-Pairs tasks
            if self.config.run_oolong_pairs:
                for _ in range(self.config.tasks_per_config):
                    tasks.append(self.generate_oolong_pairs_task(context_length))

        return tasks

    def iter_tasks(self) -> Iterator[RLMBenchTask]:
        """Yield tasks one at a time for memory efficiency."""
        yield from self.generate_all_tasks()
