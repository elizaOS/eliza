"""Streaming context management for automatic streaming in use_model calls.

Follows the OpenTelemetry ContextManager pattern (matching TypeScript implementation):
- Interface for context management
- Uses contextvars for async-safe context propagation
- Automatic streaming in nested async calls

This provides parity with TypeScript's streaming-context.ts.
"""

from collections.abc import Callable
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, TypeVar

# Type for generic return values
T = TypeVar("T")


@dataclass
class StreamingContext:
    """Streaming context containing callbacks for streaming lifecycle.

    Attributes:
        on_stream_chunk: Called for each chunk of streamed content.
        on_stream_end: Called when a use_model streaming call completes.
        message_id: Optional message ID for tracking.
        abort_signal: Optional callable returning True if cancelled.
    """

    on_stream_chunk: Callable[[str, str | None], Any]
    """Called for each chunk of streamed content (chunk, message_id) -> None"""

    on_stream_end: Callable[[], None] | None = None
    """Called when a use_model streaming call completes (allows reset between calls)"""

    message_id: str | None = None
    """Optional message ID for tracking"""

    abort_signal: Callable[[], bool] | None = None
    """Optional abort signal - callable returning True if cancelled"""


# Context variable for async-safe streaming context propagation
_streaming_context: ContextVar[StreamingContext | None] = ContextVar(
    "streaming_context", default=None
)


def run_with_streaming_context(
    context: StreamingContext | None,
    fn: Callable[[], T],
) -> T:
    """Run a function with a streaming context.

    All use_model calls within this function will automatically use streaming
    if a context with on_stream_chunk is provided.

    Example:
        async def handle_request(message: Memory) -> None:
            async def on_chunk(chunk: str, msg_id: str | None) -> None:
                await send_sse(chunk)

            ctx = StreamingContext(on_stream_chunk=on_chunk)
            await run_with_streaming_context(
                ctx,
                lambda: runtime.process_message(message)
            )

    Args:
        context: The streaming context with on_stream_chunk callback.
        fn: The function to run with streaming context.

    Returns:
        The result of the function.
    """
    token = _streaming_context.set(context)
    try:
        return fn()
    finally:
        _streaming_context.reset(token)


async def run_with_streaming_context_async(
    context: StreamingContext | None,
    fn: Callable[[], Any],
) -> Any:
    """Run an async function with a streaming context.

    Same as run_with_streaming_context but for async functions.

    Example:
        async def handle_request(message: Memory) -> None:
            async def on_chunk(chunk: str, msg_id: str | None) -> None:
                await send_sse(chunk)

            ctx = StreamingContext(on_stream_chunk=on_chunk)
            await run_with_streaming_context_async(
                ctx,
                lambda: runtime.process_message(message)
            )

    Args:
        context: The streaming context with on_stream_chunk callback.
        fn: The async function to run with streaming context.

    Returns:
        The result of the async function.
    """
    token = _streaming_context.set(context)
    try:
        result = fn()
        # Handle both sync and async functions
        if hasattr(result, "__await__"):
            return await result
        return result
    finally:
        _streaming_context.reset(token)


def get_streaming_context() -> StreamingContext | None:
    """Get the currently active streaming context.

    Called by use_model to check if automatic streaming should be enabled.

    Returns:
        The current streaming context or None.
    """
    return _streaming_context.get()


def set_streaming_context(context: StreamingContext | None) -> None:
    """Set the streaming context directly.

    This is useful for frameworks that manage their own context lifecycle.
    Prefer using run_with_streaming_context when possible.

    Args:
        context: The streaming context to set, or None to clear.
    """
    _streaming_context.set(context)


def clear_streaming_context() -> None:
    """Clear the streaming context.

    This is useful for cleanup after streaming operations.
    """
    _streaming_context.set(None)


__all__ = [
    "StreamingContext",
    "run_with_streaming_context",
    "run_with_streaming_context_async",
    "get_streaming_context",
    "set_streaming_context",
    "clear_streaming_context",
]
