"""Tests for context generator."""


from elizaos_context_bench.generator import (
    ContextGenerator,
    create_benchmark_suite,
)
from elizaos_context_bench.types import (
    ContextBenchType,
    NeedlePosition,
    NeedleType,
)


class TestContextGenerator:
    """Tests for ContextGenerator class."""

    def test_generator_initialization(self) -> None:
        """Test generator initialization."""
        gen = ContextGenerator(seed=42)
        assert gen is not None
        assert len(gen.haystack_sources) > 0

    def test_simple_tokenize(self) -> None:
        """Test simple tokenization."""
        gen = ContextGenerator()
        tokens = gen.tokenizer("Hello world, this is a test.")
        assert len(tokens) == 6

    def test_count_tokens(self) -> None:
        """Test token counting."""
        gen = ContextGenerator()
        count = gen.count_tokens("One two three four five")
        assert count == 5

    def test_generate_haystack(self) -> None:
        """Test haystack generation."""
        gen = ContextGenerator(seed=42)
        haystack = gen.generate_haystack(target_length=100)
        assert len(haystack) > 0
        token_count = gen.count_tokens(haystack)
        # Should be close to target length
        assert token_count >= 90
        assert token_count <= 150

    def test_generate_needle_value_fact(self) -> None:
        """Test generating fact needle value."""
        gen = ContextGenerator(seed=42)
        value = gen.generate_needle_value(NeedleType.FACT)
        assert len(value) == 8  # 8 character code
        assert value.isupper() or value.isalnum()

    def test_generate_needle_value_number(self) -> None:
        """Test generating number needle value."""
        gen = ContextGenerator(seed=42)
        value = gen.generate_needle_value(NeedleType.NUMBER)
        assert value.isdigit()
        assert 100 <= int(value) <= 999999

    def test_generate_needle_value_date(self) -> None:
        """Test generating date needle value."""
        gen = ContextGenerator(seed=42)
        value = gen.generate_needle_value(NeedleType.DATE)
        # Should contain a month name
        months = [
            "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"
        ]
        assert any(month in value for month in months)

    def test_generate_needle_value_name(self) -> None:
        """Test generating name needle value."""
        gen = ContextGenerator(seed=42)
        value = gen.generate_needle_value(NeedleType.NAME)
        # Should have first and last name
        parts = value.split()
        assert len(parts) == 2
        assert parts[0][0].isupper()
        assert parts[1][0].isupper()

    def test_embed_needle_start(self) -> None:
        """Test embedding needle at start."""
        gen = ContextGenerator(seed=42)
        haystack = "First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence. Sixth sentence. Seventh sentence. Eighth sentence. Ninth sentence. Tenth sentence. Eleventh sentence. Twelfth sentence."
        needle = "The secret is hidden."

        combined, position = gen.embed_needle(haystack, needle, NeedlePosition.START)

        assert needle in combined
        # Position should be near the start (< 30%)
        assert position < 30

    def test_embed_needle_middle(self) -> None:
        """Test embedding needle in middle."""
        gen = ContextGenerator(seed=42)
        haystack = "First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence. Sixth sentence. Seventh sentence. Eighth sentence. Ninth sentence. Tenth sentence."
        needle = "The secret is hidden."

        combined, position = gen.embed_needle(haystack, needle, NeedlePosition.MIDDLE)

        assert needle in combined
        # Position should be near the middle (30-70%)
        assert 30 < position < 70

    def test_embed_needle_end(self) -> None:
        """Test embedding needle at end."""
        gen = ContextGenerator(seed=42)
        haystack = "First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence. Sixth sentence. Seventh sentence. Eighth sentence. Ninth sentence. Tenth sentence."
        needle = "The secret is hidden."

        combined, position = gen.embed_needle(haystack, needle, NeedlePosition.END)

        assert needle in combined
        # Position should be near the end (> 75%)
        assert position > 75

    def test_generate_niah_task(self) -> None:
        """Test generating a NIAH task."""
        gen = ContextGenerator(seed=42)
        task = gen.generate_niah_task(
            task_id="test_task_1",
            context_length=500,
            position=NeedlePosition.MIDDLE,
            needle_type=NeedleType.FACT,
        )

        assert task.id == "test_task_1"
        assert task.bench_type == ContextBenchType.NIAH_BASIC
        assert task.needle_position == NeedlePosition.MIDDLE
        assert task.needle_type == NeedleType.FACT
        assert len(task.context) > 0
        assert len(task.question) > 0
        assert len(task.expected_answer) > 0
        # Needle should be in context
        assert task.needle in task.context

    def test_generate_semantic_niah_task(self) -> None:
        """Test generating a semantic NIAH task."""
        gen = ContextGenerator(seed=42)
        task = gen.generate_semantic_niah_task(
            task_id="semantic_test_1",
            context_length=500,
            position=NeedlePosition.MIDDLE,
        )

        assert task.id == "semantic_test_1"
        assert task.bench_type == ContextBenchType.NIAH_SEMANTIC
        assert task.requires_reasoning is True

    def test_generate_multi_hop_task(self) -> None:
        """Test generating a multi-hop task."""
        gen = ContextGenerator(seed=42)
        task = gen.generate_multi_hop_task(
            task_id="multihop_test_1",
            context_length=1000,
            num_hops=2,
        )

        assert task.id == "multihop_test_1"
        assert task.bench_type == ContextBenchType.MULTI_HOP
        assert task.requires_reasoning is True
        assert task.num_hops >= 2


class TestCreateBenchmarkSuite:
    """Tests for create_benchmark_suite function."""

    def test_create_suite_default(self) -> None:
        """Test creating benchmark suite with defaults."""
        tasks = create_benchmark_suite(
            context_lengths=[1024],
            positions=[NeedlePosition.MIDDLE],
            tasks_per_combo=1,
            include_semantic=False,
            include_multi_hop=False,
        )

        assert len(tasks) > 0
        assert all(t.bench_type == ContextBenchType.NIAH_BASIC for t in tasks)

    def test_create_suite_with_semantic(self) -> None:
        """Test creating suite with semantic tasks."""
        tasks = create_benchmark_suite(
            context_lengths=[1024],
            positions=[NeedlePosition.MIDDLE],
            tasks_per_combo=1,
            include_semantic=True,
            include_multi_hop=False,
        )

        semantic_tasks = [t for t in tasks if t.bench_type == ContextBenchType.NIAH_SEMANTIC]
        assert len(semantic_tasks) > 0

    def test_create_suite_with_multi_hop(self) -> None:
        """Test creating suite with multi-hop tasks."""
        tasks = create_benchmark_suite(
            context_lengths=[1024],
            positions=[NeedlePosition.MIDDLE],
            tasks_per_combo=1,
            include_semantic=False,
            include_multi_hop=True,
        )

        multi_hop_tasks = [t for t in tasks if t.bench_type == ContextBenchType.MULTI_HOP]
        assert len(multi_hop_tasks) > 0

    def test_create_suite_seed_reproducibility(self) -> None:
        """Test that seed produces reproducible results."""
        tasks1 = create_benchmark_suite(
            context_lengths=[1024],
            positions=[NeedlePosition.MIDDLE],
            tasks_per_combo=2,
            seed=42,
        )

        tasks2 = create_benchmark_suite(
            context_lengths=[1024],
            positions=[NeedlePosition.MIDDLE],
            tasks_per_combo=2,
            seed=42,
        )

        # Same seed should produce same expected answers
        assert len(tasks1) == len(tasks2)
        for t1, t2 in zip(tasks1, tasks2):
            if t1.bench_type == t2.bench_type:
                # Tasks with same type and seed should be identical
                assert t1.expected_answer == t2.expected_answer
