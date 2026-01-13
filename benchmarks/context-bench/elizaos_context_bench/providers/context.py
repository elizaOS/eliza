"""Long Context Provider for ElizaOS.

Provides long context data to the agent for context benchmark evaluation.
"""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos.types.components import ProviderResult
    from elizaos.types.memory import Memory
    from elizaos.types.runtime import IAgentRuntime
    from elizaos.types.state import State


class LongContextProvider:
    """Provider that supplies long context to agent for benchmark testing."""

    name: str = "long_context"
    description: str = "Provides long context for context retrieval benchmarks"
    position: int = 1
    private: bool = False

    def __init__(
        self,
        context: str,
        chunk_strategy: str = "full",
        chunk_size: int = 2048,
    ):
        """Initialize the long context provider.

        Args:
            context: The full context text.
            chunk_strategy: How to provide context ("full" or "chunked").
            chunk_size: Size of chunks if using chunked strategy.

        """
        self.context = context
        self.chunk_strategy = chunk_strategy
        self.chunk_size = chunk_size
        self._chunks: list[str] | None = None

    def _create_chunks(self) -> list[str]:
        """Split context into chunks."""
        if self._chunks is not None:
            return self._chunks

        words = self.context.split()
        chunks: list[str] = []
        current_chunk: list[str] = []
        current_size = 0

        for word in words:
            current_chunk.append(word)
            current_size += 1

            if current_size >= self.chunk_size:
                chunks.append(" ".join(current_chunk))
                current_chunk = []
                current_size = 0

        if current_chunk:
            chunks.append(" ".join(current_chunk))

        self._chunks = chunks
        return chunks

    async def get(
        self,
        runtime: "IAgentRuntime",
        message: "Memory",
        state: "State",
    ) -> "ProviderResult":
        """Provide context based on strategy.

        Args:
            runtime: The agent runtime.
            message: The current message.
            state: The current state.

        Returns:
            ProviderResult with context text.

        """
        # Import here to avoid circular imports
        from elizaos.types.components import ProviderResult

        if self.chunk_strategy == "full":
            return ProviderResult(
                text=f"<context>\n{self.context}\n</context>",
                data={"context_length": len(self.context.split())},
            )
        elif self.chunk_strategy == "chunked":
            # For chunked strategy, could implement relevance-based selection
            # For now, return all chunks
            chunks = self._create_chunks()
            text = "\n\n".join(
                f"<chunk index=\"{i}\">\n{chunk}\n</chunk>"
                for i, chunk in enumerate(chunks)
            )
            return ProviderResult(
                text=text,
                data={
                    "num_chunks": len(chunks),
                    "chunk_size": self.chunk_size,
                },
            )
        else:
            return ProviderResult(text=self.context)

    def update_context(self, context: str) -> None:
        """Update the context text."""
        self.context = context
        self._chunks = None  # Reset cached chunks


class BenchmarkContextProvider:
    """Provider specifically for running context benchmarks.

    Sets up the context for a specific benchmark task.
    """

    name: str = "benchmark_context"
    description: str = "Provides context for the current benchmark task"
    position: int = 0
    private: bool = False

    def __init__(self) -> None:
        self._current_context: str = ""
        self._current_question: str = ""
        self._task_metadata: dict[str, str | int | float | bool] = {}

    def set_task(
        self,
        context: str,
        question: str,
        metadata: dict[str, str | int | float | bool] | None = None,
    ) -> None:
        """Set the current benchmark task.

        Args:
            context: The context for the task.
            question: The question to answer.
            metadata: Optional task metadata.

        """
        self._current_context = context
        self._current_question = question
        self._task_metadata = metadata or {}

    async def get(
        self,
        runtime: "IAgentRuntime",
        message: "Memory",
        state: "State",
    ) -> "ProviderResult":
        """Provide the current task context.

        Args:
            runtime: The agent runtime.
            message: The current message.
            state: The current state.

        Returns:
            ProviderResult with context and question.

        """
        from elizaos.types.components import ProviderResult

        text = f"""<benchmark_context>
{self._current_context}
</benchmark_context>

<question>
{self._current_question}
</question>

Please answer the question based only on the information provided in the context above.
Provide a brief, precise answer."""

        return ProviderResult(
            text=text,
            data={
                "context_length": len(self._current_context.split()),
                "question": self._current_question,
                **self._task_metadata,
            },
        )
