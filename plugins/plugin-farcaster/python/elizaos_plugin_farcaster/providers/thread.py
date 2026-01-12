"""Thread provider for Farcaster."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos_plugin_farcaster.service import FarcasterService


class ThreadProvider:
    """Provider for Farcaster thread context.

    Provides thread context for a Farcaster conversation.
    """

    NAME = "farcaster_thread"
    DESCRIPTION = "Provides thread context for a Farcaster conversation"

    def __init__(
        self,
        service: "FarcasterService",
    ) -> None:
        """Initialize the thread provider.

        Args:
            service: The Farcaster service
        """
        self._service = service

    @property
    def name(self) -> str:
        """Get the provider name."""
        return self.NAME

    @property
    def description(self) -> str:
        """Get the provider description."""
        return self.DESCRIPTION

    async def get(self, cast_hash: str, max_depth: int = 5) -> str:
        """Get the thread context as a formatted string.

        Args:
            cast_hash: The hash of the cast to get thread context for
            max_depth: Maximum depth to traverse up the thread

        Returns:
            Formatted thread context
        """
        try:
            thread: list[object] = []
            visited: set[str] = set()
            current_hash: str | None = cast_hash

            while current_hash:
                if len(thread) >= max_depth or current_hash in visited:
                    break

                visited.add(current_hash)

                try:
                    cast = await self._service.get_cast(current_hash)
                    thread.insert(0, cast)

                    if cast.in_reply_to:
                        current_hash = cast.in_reply_to.hash
                    else:
                        current_hash = None
                except Exception:
                    break

            if not thread:
                return "No thread context available."

            lines = ["Thread context:"]
            for i, cast in enumerate(thread):
                prefix = "└─" if i == len(thread) - 1 else "├─"
                text = cast.text[:80] + "..." if len(cast.text) > 80 else cast.text  # type: ignore[union-attr]
                lines.append(f"{prefix} @{cast.profile.username}: {text}")  # type: ignore[union-attr]

            return "\n".join(lines)

        except Exception as e:
            return f"Error fetching thread context: {e!s}"
