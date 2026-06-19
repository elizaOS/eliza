"""
Task generator for RLM benchmarks.

Generates benchmark tasks for S-NIAH, OOLONG, and other RLM-specific tests
following the paper's evaluation methodology.
"""

from __future__ import annotations

import random
import string
import uuid
from dataclasses import replace
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


EDGE_VARIANTS: tuple[dict[str, str], ...] = (
    {
        "id": "conflicting_decoy",
        "label": "Conflicting decoy fact",
        "context_prefix": (
            "Audit note: this document contains outdated decoy identifiers. "
            "Only answer from the exact sentence requested by the question.\n\n"
            "Deprecated authorization placeholder: ZXCVBN12. This value is not valid.\n\n"
        ),
        "question_suffix": "Ignore deprecated or decoy identifiers that are not part of the requested fact.",
    },
    {
        "id": "case_noise",
        "label": "Mixed case and punctuation noise",
        "context_prefix": (
            "Operator note: section headings and commentary may use inconsistent "
            "case, punctuation, and spacing. Generated alphanumeric values remain exact.\n\n"
        ),
        "question_suffix": "Return the exact alphanumeric value or values, preserving characters.",
    },
    {
        "id": "late_correction",
        "label": "Late correction policy",
        "context_suffix": (
            "\n\nPostscript policy: if an explicit critical finding, protocol, code, "
            "token, key, combination, or identifier appears earlier, do not invent a "
            "replacement from this postscript."
        ),
        "question_suffix": "Use only information stated in the context, not a fabricated correction.",
    },
    {
        "id": "strict_json",
        "label": "Strict JSON response",
        "question_suffix": (
            "If possible, answer as compact JSON with an 'answer' field while keeping "
            "the requested value text unchanged."
        ),
    },
    {
        "id": "citation_pressure",
        "label": "Citation pressure",
        "question_suffix": (
            "Include only the requested answer; do not quote surrounding paragraphs or add citations."
        ),
    },
    {
        "id": "multi_document_order",
        "label": "Document order stress",
        "context_prefix": (
            "Routing note: documents may appear in an arbitrary order, and repeated "
            "boilerplate should not be treated as an answer.\n\n"
        ),
        "question_suffix": "For paired documents, keep the roles A and B distinct.",
    },
    {
        "id": "abbreviation_noise",
        "label": "Abbreviation and alias noise",
        "context_prefix": (
            "Glossary: ref, reference, identifier, id, token, key, and code may appear "
            "near each other. Answer the specific item asked for.\n\n"
        ),
        "question_suffix": "Do not substitute a nearby alias for the requested value.",
    },
    {
        "id": "long_preface",
        "label": "Long preface before evidence",
        "context_prefix": (
            "Preface: The following archive was assembled from operational notes. "
            "Most paragraphs are unrelated background and should be searched rather "
            "than summarized.\n\n"
        ),
        "question_suffix": "Search the full context before answering.",
    },
    {
        "id": "answer_only",
        "label": "Answer-only formatting",
        "question_suffix": "Answer with the final value or values only, with no explanation.",
    },
    {
        "id": "audit_trail",
        "label": "Audit trail distractors",
        "context_suffix": (
            "\n\nAudit trail: previous review IDs REV00001 and REV00002 are workflow "
            "records, not answers to any benchmark question."
        ),
        "question_suffix": "Exclude audit trail IDs unless the main document says they are the requested answer.",
    },
)


def generate_random_value(length: int = 8) -> str:
    """Generate a random alphanumeric value for needles."""
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=length))


def estimate_tokens(text: str) -> int:
    """Rough token estimate (4 characters per token)."""
    return len(text) // 4


def _apply_edge_variant(task: RLMBenchTask, variant: dict[str, str]) -> RLMBenchTask:
    context = (
        f"{variant.get('context_prefix', '')}{task.context}{variant.get('context_suffix', '')}"
    )
    question = task.question
    question_suffix = variant.get("question_suffix", "").strip()
    if question_suffix:
        question = f"{question} {question_suffix}"

    metadata = dict(task.metadata)
    metadata.update(
        {
            "base_task_id": task.id,
            "scenario_id": variant["id"],
            "scenario_label": variant["label"],
        }
    )

    return replace(
        task,
        id=f"{task.id}__edge_{variant['id']}",
        context=context,
        context_length_tokens=estimate_tokens(context),
        context_length_chars=len(context),
        question=question,
        metadata=metadata,
    )


def expand_tasks(tasks: list[RLMBenchTask]) -> list[RLMBenchTask]:
    """Return each base task plus exactly ten answer-preserving edge variants."""
    expanded: list[RLMBenchTask] = []
    for task in tasks:
        expanded.append(task)
        expanded.extend(_apply_edge_variant(task, variant) for variant in EDGE_VARIANTS)
    return expanded


def count_tasks(tasks: list[RLMBenchTask], include_edge_scenarios: bool = False) -> dict[str, int]:
    base = len(tasks)
    edge = base * len(EDGE_VARIANTS) if include_edge_scenarios else 0
    return {
        "base": base,
        "edge": edge,
        "edge_multiplier": len(EDGE_VARIANTS),
        "total": base + edge,
    }


def validate_tasks(tasks: list[RLMBenchTask], include_edge_scenarios: bool = False) -> None:
    ids = [task.id for task in tasks]
    duplicates = {task_id for task_id in ids if ids.count(task_id) > 1}
    if duplicates:
        raise ValueError(f"Duplicate task ids: {sorted(duplicates)[:5]}")

    if include_edge_scenarios:
        expanded = expand_tasks(tasks)
        expanded_ids = [task.id for task in expanded]
        expanded_duplicates = {
            task_id for task_id in expanded_ids if expanded_ids.count(task_id) > 1
        }
        if expanded_duplicates:
            raise ValueError(f"Duplicate expanded task ids: {sorted(expanded_duplicates)[:5]}")

        for task in expanded:
            if "__edge_" in task.id:
                if "base_task_id" not in task.metadata or "scenario_id" not in task.metadata:
                    raise ValueError(f"Expanded task {task.id} is missing scenario metadata")
                if not task.expected_answer:
                    raise ValueError(f"Expanded task {task.id} has no expected answer")


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

        if self.config.include_edge_scenarios:
            return expand_tasks(tasks)

        return tasks

    def iter_tasks(self) -> Iterator[RLMBenchTask]:
        """Yield tasks one at a time for memory efficiency."""
        yield from self.generate_all_tasks()
