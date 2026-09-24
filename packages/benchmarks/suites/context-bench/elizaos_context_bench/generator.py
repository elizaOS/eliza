"""Context Generator for Context Benchmark.

Generates synthetic haystack contexts with embedded needles for testing
LLM context retrieval capabilities.
"""

import random
import string
from collections.abc import Callable
from dataclasses import dataclass

from elizaos_context_bench.types import (
    DEFAULT_HAYSTACK_PARAGRAPHS,
    NEEDLE_TEMPLATES,
    QUESTION_TEMPLATES,
    ContextBenchTask,
    ContextBenchType,
    HaystackDomain,
    NeedlePosition,
    NeedleType,
)


@dataclass
class MultiHopChain:
    """Strongly typed multi-hop reasoning chain."""

    hops: int
    needles: list[str]
    question: str
    answer: str


class ContextGenerator:
    """Generate synthetic contexts with embedded needles."""

    def __init__(
        self,
        tokenizer: Callable[[str], list[str]] | None = None,
        haystack_sources: list[str] | None = None,
        seed: int | None = None,
    ):
        """Initialize the context generator.

        Args:
            tokenizer: Optional tokenizer function. Defaults to simple whitespace split.
            haystack_sources: Custom haystack paragraphs. Defaults to built-in sources.
            seed: Random seed for reproducibility.

        """
        self.tokenizer = tokenizer or self._simple_tokenize
        self.haystack_sources = haystack_sources or DEFAULT_HAYSTACK_PARAGRAPHS
        if seed is not None:
            random.seed(seed)

    @staticmethod
    def _simple_tokenize(text: str) -> list[str]:
        """Tokenize text using whitespace splitting."""
        return text.split()

    def count_tokens(self, text: str) -> int:
        """Count tokens in text."""
        return len(self.tokenizer(text))

    def generate_haystack(
        self,
        target_length: int,
        domain: HaystackDomain = HaystackDomain.GENERAL,
    ) -> str:
        """Generate haystack text of specified token length.

        Args:
            target_length: Target number of tokens.
            domain: Domain for content selection (currently uses general).

        Returns:
            Haystack text approximately target_length tokens.

        """
        paragraphs = self.haystack_sources.copy()
        result: list[str] = []
        current_length = 0

        while current_length < target_length:
            random.shuffle(paragraphs)
            for para in paragraphs:
                result.append(para)
                current_length = self.count_tokens(" ".join(result))
                if current_length >= target_length:
                    break

        # Trim to approximately target length
        full_text = " ".join(result)
        tokens = self.tokenizer(full_text)
        if len(tokens) > target_length:
            tokens = tokens[:target_length]
            # Join back and ensure we don't cut mid-word
            full_text = " ".join(tokens)
            # Find last sentence end
            for end_char in [".", "!", "?"]:
                last_end = full_text.rfind(end_char)
                if last_end > len(full_text) * 0.9:  # Within last 10%
                    full_text = full_text[: last_end + 1]
                    break

        return full_text

    def generate_needle_value(self, needle_type: NeedleType) -> str:
        """Generate a random value for the needle based on type."""
        if needle_type == NeedleType.FACT:
            # Random code-like string
            return "".join(random.choices(string.ascii_uppercase + string.digits, k=8))
        elif needle_type == NeedleType.NUMBER:
            return str(random.randint(100, 999999))
        elif needle_type == NeedleType.DATE:
            month = random.choice(
                [
                    "January",
                    "February",
                    "March",
                    "April",
                    "May",
                    "June",
                    "July",
                    "August",
                    "September",
                    "October",
                    "November",
                    "December",
                ]
            )
            day = random.randint(1, 28)
            year = random.randint(2020, 2025)
            return f"{month} {day}, {year}"
        elif needle_type == NeedleType.NAME:
            first_names = [
                "Alexander",
                "Benjamin",
                "Catherine",
                "Diana",
                "Eleanor",
                "Frederick",
                "Gregory",
                "Helena",
                "Isabella",
                "Jonathan",
            ]
            last_names = [
                "Anderson",
                "Bradford",
                "Crawford",
                "Davidson",
                "Edwards",
                "Fletcher",
                "Garrison",
                "Harrison",
                "Irving",
                "Jackson",
            ]
            return f"{random.choice(first_names)} {random.choice(last_names)}"
        elif needle_type == NeedleType.CODE:
            prefixes = ["api/v2/", "https://", "config.", "cmd:", "func_"]
            suffixes = ["endpoint", "resource", "handler", "processor", "service"]
            return f"{random.choice(prefixes)}{random.choice(suffixes)}"
        else:
            return "".join(random.choices(string.ascii_uppercase + string.digits, k=8))

    def embed_needle(
        self,
        haystack: str,
        needle: str,
        position: NeedlePosition,
    ) -> tuple[str, float]:
        """Embed needle in haystack at specified position.

        Args:
            haystack: The haystack text.
            needle: The needle text to embed.
            position: Where to place the needle.

        Returns:
            Tuple of (combined text, actual position as percentage).

        """
        # Split haystack into sentences
        sentences = []
        current_sentence = ""
        for char in haystack:
            current_sentence += char
            if char in ".!?":
                sentences.append(current_sentence.strip())
                current_sentence = ""
        if current_sentence.strip():
            sentences.append(current_sentence.strip())

        num_sentences = len(sentences)
        if num_sentences == 0:
            return f"{needle} {haystack}", 0.0

        # Determine insertion point based on position
        if position == NeedlePosition.START:
            insert_idx = max(1, int(num_sentences * 0.05))
        elif position == NeedlePosition.EARLY:
            insert_idx = int(num_sentences * random.uniform(0.15, 0.25))
        elif position == NeedlePosition.MIDDLE:
            insert_idx = int(num_sentences * random.uniform(0.45, 0.55))
        elif position == NeedlePosition.LATE:
            insert_idx = int(num_sentences * random.uniform(0.75, 0.85))
        elif position == NeedlePosition.END:
            insert_idx = int(num_sentences * 0.95)
        elif position == NeedlePosition.RANDOM:
            insert_idx = random.randint(1, num_sentences - 1)
        else:
            insert_idx = num_sentences // 2

        insert_idx = max(0, min(insert_idx, num_sentences))

        # Insert needle
        sentences.insert(insert_idx, needle)
        actual_position_pct = insert_idx / (num_sentences + 1) * 100

        return " ".join(sentences), actual_position_pct

    def generate_niah_task(
        self,
        task_id: str,
        context_length: int,
        position: NeedlePosition = NeedlePosition.MIDDLE,
        needle_type: NeedleType = NeedleType.FACT,
        domain: HaystackDomain = HaystackDomain.GENERAL,
    ) -> ContextBenchTask:
        """Generate a complete NIAH task.

        Args:
            task_id: Unique task identifier.
            context_length: Target context length in tokens. Must be positive.
            position: Where to place the needle.
            needle_type: Type of needle content.
            domain: Domain for haystack content.

        Returns:
            Complete ContextBenchTask.

        Raises:
            ValueError: If task_id is empty or context_length <= 0.
            KeyError: If needle_type has no templates defined.

        """
        if not task_id:
            raise ValueError("task_id cannot be empty")
        if context_length <= 0:
            raise ValueError(f"context_length must be positive, got {context_length}")
        if needle_type not in NEEDLE_TEMPLATES:
            raise KeyError(f"No templates defined for needle_type: {needle_type}")

        # Generate haystack
        haystack = self.generate_haystack(context_length, domain)

        # Generate needle
        value = self.generate_needle_value(needle_type)
        template_idx = random.randint(0, len(NEEDLE_TEMPLATES[needle_type]) - 1)
        needle = NEEDLE_TEMPLATES[needle_type][template_idx].format(value=value)
        question = QUESTION_TEMPLATES[needle_type][template_idx]

        # Embed needle
        context, actual_position = self.embed_needle(haystack, needle, position)

        return ContextBenchTask(
            id=task_id,
            bench_type=ContextBenchType.NIAH_BASIC,
            context=context,
            context_length=self.count_tokens(context),
            question=question,
            needle=needle,
            needle_position=position,
            expected_answer=value,
            actual_position_pct=actual_position,
            requires_reasoning=False,
            num_hops=1,
            needle_type=needle_type,
            haystack_domain=domain,
            metadata={
                "template_idx": template_idx,
                "target_length": context_length,
            },
        )

    def generate_semantic_niah_task(
        self,
        task_id: str,
        context_length: int,
        position: NeedlePosition = NeedlePosition.MIDDLE,
    ) -> ContextBenchTask:
        """Generate a semantic NIAH task with minimal lexical overlap.

        The question uses different words than the needle to test
        semantic understanding rather than keyword matching.
        """
        # Semantic pairs: (needle statement, rephrased question, answer)
        semantic_pairs = [
            (
                "The annual revenue for the flagship product reached $47 million.",
                "How much money did the main product bring in this year?",
                "$47 million",
            ),
            (
                "The experimental medication showed a 73% success rate in clinical trials.",
                "What percentage of patients improved with the new treatment?",
                "73%",
            ),
            (
                "The construction of the new data center is scheduled to complete in Q4 2025.",
                "When will the computing facility be finished?",
                "Q4 2025",
            ),
            (
                "Dr. Sarah Mitchell was appointed as the new Chief Technology Officer.",
                "Who recently became the head of technology?",
                "Dr. Sarah Mitchell",
            ),
            (
                "The spacecraft's maximum velocity reached 28,000 kilometers per hour.",
                "How fast can the rocket travel at its highest speed?",
                "28,000 kilometers per hour",
            ),
        ]

        needle_text, question, answer = random.choice(semantic_pairs)

        haystack = self.generate_haystack(context_length)
        context, actual_position = self.embed_needle(haystack, needle_text, position)

        return ContextBenchTask(
            id=task_id,
            bench_type=ContextBenchType.NIAH_SEMANTIC,
            context=context,
            context_length=self.count_tokens(context),
            question=question,
            needle=needle_text,
            needle_position=position,
            expected_answer=answer,
            actual_position_pct=actual_position,
            requires_reasoning=True,
            num_hops=1,
            metadata={"semantic_pair": True},
        )

    def generate_multi_hop_task(
        self,
        task_id: str,
        context_length: int,
        num_hops: int = 2,
    ) -> ContextBenchTask:
        """Generate a multi-hop reasoning task.

        Creates multiple related facts that must be connected to answer the question.

        Args:
            task_id: Unique task identifier.
            context_length: Target context length in tokens. Must be positive.
            num_hops: Number of reasoning hops (2 or 3 supported).

        Returns:
            Complete ContextBenchTask.

        Raises:
            ValueError: If context_length <= 0 or num_hops < 1.

        """
        if context_length <= 0:
            raise ValueError(f"context_length must be positive, got {context_length}")
        if num_hops < 1:
            raise ValueError(f"num_hops must be >= 1, got {num_hops}")

        # Multi-hop reasoning chains with strongly typed structure
        hop_chains: list[MultiHopChain] = [
            # 2-hop: A -> B -> answer
            MultiHopChain(
                hops=2,
                needles=[
                    "Project Phoenix is led by the Quantum Division.",
                    "The Quantum Division's headquarters is located in Building 7.",
                ],
                question="Where is Project Phoenix headquartered?",
                answer="Building 7",
            ),
            MultiHopChain(
                hops=2,
                needles=[
                    "The encryption key is stored in vault Alpha.",
                    "Vault Alpha's access code is 7749.",
                ],
                question="What code is needed to access the encryption key?",
                answer="7749",
            ),
            # 3-hop: A -> B -> C -> answer
            MultiHopChain(
                hops=3,
                needles=[
                    "Dr. Chen leads the Biosynthesis team.",
                    "The Biosynthesis team operates under the Life Sciences division.",
                    "The Life Sciences division budget is $12 million.",
                ],
                question="What is the budget for the division where Dr. Chen's team operates?",
                answer="$12 million",
            ),
            MultiHopChain(
                hops=3,
                needles=[
                    "Server cluster X runs application Y.",
                    "Application Y stores data in database Z.",
                    "Database Z is backed up to facility W.",
                ],
                question="Where is the data from server cluster X ultimately backed up?",
                answer="facility W",
            ),
        ]

        # Filter to requested hop count
        valid_chains = [c for c in hop_chains if c.hops == num_hops]
        if not valid_chains:
            valid_chains = hop_chains  # Fallback to any

        chain = random.choice(valid_chains)

        # Generate haystack
        haystack = self.generate_haystack(context_length)

        # Distribute needles throughout the haystack
        positions = [NeedlePosition.EARLY, NeedlePosition.MIDDLE, NeedlePosition.LATE]
        context = haystack
        needle_texts: list[str] = []

        for i, needle in enumerate(chain.needles):
            pos = positions[i % len(positions)]
            context, _ = self.embed_needle(context, needle, pos)
            needle_texts.append(needle)

        return ContextBenchTask(
            id=task_id,
            bench_type=ContextBenchType.MULTI_HOP,
            context=context,
            context_length=self.count_tokens(context),
            question=chain.question,
            needle=" | ".join(needle_texts),
            needle_position=NeedlePosition.RANDOM,  # Multiple positions
            expected_answer=chain.answer,
            actual_position_pct=50.0,  # Multiple positions
            requires_reasoning=True,
            num_hops=chain.hops,
            metadata={"chain_id": task_id, "needle_count": len(needle_texts)},
        )


def create_benchmark_suite(
    context_lengths: list[int] | None = None,
    positions: list[NeedlePosition] | None = None,
    tasks_per_combo: int = 3,
    include_semantic: bool = True,
    include_multi_hop: bool = True,
    seed: int | None = 42,
) -> list[ContextBenchTask]:
    """Create a complete benchmark suite with various task types.

    Args:
        context_lengths: List of context lengths to test.
        positions: List of positions to test.
        tasks_per_combo: Number of tasks per length-position combination.
        include_semantic: Include semantic NIAH tasks.
        include_multi_hop: Include multi-hop reasoning tasks.
        seed: Random seed for reproducibility.

    Returns:
        List of ContextBenchTask instances.

    """
    if context_lengths is None:
        context_lengths = [1024, 2048, 4096, 8192, 16384]

    if positions is None:
        positions = [
            NeedlePosition.START,
            NeedlePosition.EARLY,
            NeedlePosition.MIDDLE,
            NeedlePosition.LATE,
            NeedlePosition.END,
        ]

    generator = ContextGenerator(seed=seed)
    tasks: list[ContextBenchTask] = []
    task_counter = 0

    # Generate basic NIAH tasks
    valid_needle_types = [
        NeedleType.FACT,
        NeedleType.NUMBER,
        NeedleType.DATE,
        NeedleType.NAME,
        NeedleType.CODE,
    ]
    for length in context_lengths:
        for position in positions:
            for _ in range(tasks_per_combo):
                task_counter += 1
                needle_type = random.choice(valid_needle_types)
                task = generator.generate_niah_task(
                    task_id=f"niah_basic_{task_counter}",
                    context_length=length,
                    position=position,
                    needle_type=needle_type,
                )
                tasks.append(task)

    # Generate semantic NIAH tasks
    if include_semantic:
        for length in context_lengths:
            for position in positions:
                task_counter += 1
                task = generator.generate_semantic_niah_task(
                    task_id=f"niah_semantic_{task_counter}",
                    context_length=length,
                    position=position,
                )
                tasks.append(task)

    # Generate multi-hop tasks
    if include_multi_hop:
        for length in context_lengths:
            for num_hops in [2, 3]:
                for _ in range(tasks_per_combo):
                    task_counter += 1
                    task = generator.generate_multi_hop_task(
                        task_id=f"multi_hop_{num_hops}_{task_counter}",
                        context_length=length,
                        num_hops=num_hops,
                    )
                    tasks.append(task)

    return tasks
