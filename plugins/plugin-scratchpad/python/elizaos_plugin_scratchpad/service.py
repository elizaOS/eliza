"""ScratchpadService - File-based CRUD with markdown frontmatter and TF-IDF search."""

from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

from elizaos_plugin_scratchpad.config import ScratchpadConfig
from elizaos_plugin_scratchpad.error import FileSizeError, NotFoundError
from elizaos_plugin_scratchpad.types import (
    ScratchpadEntry,
    ScratchpadReadOptions,
    ScratchpadSearchOptions,
    ScratchpadSearchResult,
    ScratchpadWriteOptions,
)

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime

logger = logging.getLogger(__name__)


class ScratchpadService:
    """Service for managing file-based scratchpad memories.

    Provides write, read, search, list, and delete operations
    on markdown files stored in a configurable directory.
    """

    def __init__(
        self,
        runtime: IAgentRuntime | None = None,
        config: ScratchpadConfig | None = None,
    ) -> None:
        self._config = config or ScratchpadConfig()

    @property
    def config(self) -> ScratchpadConfig:
        """Return the current configuration."""
        return self._config

    def _ensure_directory(self) -> None:
        """Ensure the scratchpad directory exists."""
        try:
            os.makedirs(self._config.base_path, exist_ok=True)
        except OSError as exc:
            logger.error("[ScratchpadService] Failed to create directory: %s", exc)
            raise

    def _sanitize_filename(self, title: str) -> str:
        """Generate a safe filename from a title."""
        name = title.lower()
        name = re.sub(r"[^a-z0-9\s-]", "", name)
        name = re.sub(r"\s+", "-", name)
        name = re.sub(r"-+", "-", name)
        return name[:100]

    def _get_file_path(self, entry_id: str) -> str:
        """Get the full path for a scratchpad entry."""
        filename = entry_id if entry_id.endswith(".md") else f"{entry_id}.md"
        return os.path.join(self._config.base_path, filename)

    def _get_entry_id(self, filename: str) -> str:
        """Extract entry ID from a filename."""
        return Path(filename).stem

    async def write(
        self,
        title: str,
        content: str,
        options: ScratchpadWriteOptions | None = None,
    ) -> ScratchpadEntry:
        """Write or append content to a scratchpad entry.

        Args:
            title: The title for the entry.
            content: The content to write.
            options: Optional write options (tags, append).

        Returns:
            The written ScratchpadEntry.

        Raises:
            FileSizeError: If content exceeds max_file_size.
        """
        opts = options or ScratchpadWriteOptions()
        self._ensure_directory()

        entry_id = self._sanitize_filename(title)
        file_path = self._get_file_path(entry_id)
        now = datetime.now(tz=timezone.utc)

        created_at = now

        entry_exists = await self.exists(entry_id)
        if entry_exists and opts.append:
            existing = await self.read(entry_id)
            final_content = f"{existing.content}\n\n---\n\n{content}"
            created_at = existing.created_at
        else:
            # Build frontmatter
            lines = [
                "---",
                f'title: "{title}"',
                f"created: {now.isoformat()}",
                f"modified: {now.isoformat()}",
            ]
            if opts.tags:
                lines.append(f"tags: [{', '.join(opts.tags)}]")
            lines.append("---")
            lines.append("")
            frontmatter = "\n".join(lines)
            final_content = f"{frontmatter}\n{content}"

        # Check file size
        byte_size = len(final_content.encode("utf-8"))
        if byte_size > self._config.max_file_size:
            raise FileSizeError(
                f"Content exceeds maximum file size of {self._config.max_file_size} bytes"
            )

        with open(file_path, "w", encoding="utf-8") as f:
            f.write(final_content)

        logger.info("[ScratchpadService] Wrote entry: %s", entry_id)

        return ScratchpadEntry(
            id=entry_id,
            path=file_path,
            title=title,
            content=final_content,
            created_at=created_at,
            modified_at=now,
            tags=opts.tags or [],
        )

    async def read(
        self,
        entry_id: str,
        options: ScratchpadReadOptions | None = None,
    ) -> ScratchpadEntry:
        """Read a scratchpad entry by ID.

        Args:
            entry_id: The entry identifier.
            options: Optional read options (from_line, lines).

        Returns:
            The ScratchpadEntry.

        Raises:
            NotFoundError: If the entry does not exist.
        """
        opts = options or ScratchpadReadOptions()
        file_path = self._get_file_path(entry_id)

        try:
            stat = os.stat(file_path)
            with open(file_path, "r", encoding="utf-8") as f:
                content = f.read()
        except FileNotFoundError:
            raise NotFoundError(f"Scratchpad entry not found: {entry_id}")

        # Handle line range reading
        if opts.from_line is not None or opts.lines is not None:
            all_lines = content.split("\n")
            from_idx = max(1, opts.from_line or 1) - 1  # Convert to 0-indexed
            num_lines = opts.lines if opts.lines is not None else len(all_lines) - from_idx
            content = "\n".join(all_lines[from_idx : from_idx + num_lines])

        # Parse frontmatter for metadata
        title = entry_id
        tags: list[str] = []
        created_at = datetime.fromtimestamp(stat.st_ctime, tz=timezone.utc)

        fm_match = re.match(r"^---\n([\s\S]*?)\n---", content)
        if fm_match:
            frontmatter = fm_match.group(1)

            title_match = re.search(r'title:\s*"?([^"\n]+)"?', frontmatter)
            if title_match:
                title = title_match.group(1)

            tags_match = re.search(r"tags:\s*\[([^\]]+)\]", frontmatter)
            if tags_match:
                tags = [t.strip() for t in tags_match.group(1).split(",")]

            created_match = re.search(r"created:\s*(.+)", frontmatter)
            if created_match:
                try:
                    created_at = datetime.fromisoformat(created_match.group(1).strip())
                except ValueError:
                    pass

        modified_at = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)

        return ScratchpadEntry(
            id=entry_id,
            path=file_path,
            title=title,
            content=content,
            created_at=created_at,
            modified_at=modified_at,
            tags=tags,
        )

    async def exists(self, entry_id: str) -> bool:
        """Check if a scratchpad entry exists.

        Args:
            entry_id: The entry identifier.

        Returns:
            True if the entry exists, False otherwise.
        """
        file_path = self._get_file_path(entry_id)
        return os.path.isfile(file_path)

    async def list(self) -> list[ScratchpadEntry]:
        """List all scratchpad entries, sorted by modified date (most recent first).

        Returns:
            List of ScratchpadEntry objects.
        """
        self._ensure_directory()

        entries: list[ScratchpadEntry] = []
        try:
            for filename in os.listdir(self._config.base_path):
                ext = Path(filename).suffix
                if ext not in self._config.allowed_extensions:
                    continue
                try:
                    entry_id = self._get_entry_id(filename)
                    entry = await self.read(entry_id)
                    entries.append(entry)
                except Exception as exc:
                    logger.warning(
                        "[ScratchpadService] Failed to read entry %s: %s",
                        filename,
                        exc,
                    )
        except OSError as exc:
            logger.error("[ScratchpadService] Failed to list entries: %s", exc)
            return []

        # Sort by modified date, most recent first
        entries.sort(key=lambda e: e.modified_at, reverse=True)
        return entries

    async def search(
        self,
        query: str,
        options: ScratchpadSearchOptions | None = None,
    ) -> list[ScratchpadSearchResult]:
        """Search scratchpad entries using TF-based text matching.

        Tokenises the query, counts term occurrences in each entry,
        scores with ``min(1, match_count / (len(terms) * 3))``, and
        returns the best-matching snippets.

        Args:
            query: The search query string.
            options: Optional search options (max_results, min_score).

        Returns:
            List of ScratchpadSearchResult objects sorted by score descending.
        """
        opts = options or ScratchpadSearchOptions()
        entries = await self.list()
        results: list[ScratchpadSearchResult] = []

        max_results = opts.max_results
        min_score = opts.min_score

        # Tokenize and lowercase the query (filter terms <= 2 chars)
        query_terms = [t for t in query.lower().split() if len(t) > 2]
        if not query_terms:
            return []

        for entry in entries:
            all_lines = entry.content.split("\n")
            content_lower = entry.content.lower()

            # Calculate relevance score based on term frequency
            match_count = 0
            for term in query_terms:
                matches = re.findall(re.escape(term), content_lower, re.IGNORECASE)
                match_count += len(matches)

            if match_count == 0:
                continue

            # Simple TF-based scoring
            score = min(1.0, match_count / (len(query_terms) * 3))
            if score < min_score:
                continue

            # Find the best matching snippet
            best_start = 0
            best_end = min(len(all_lines), 5)

            for i, line in enumerate(all_lines):
                line_lower = line.lower()
                for term in query_terms:
                    if term in line_lower:
                        best_start = max(0, i - 2)
                        best_end = min(len(all_lines), i + 3)
                        break

            snippet = "\n".join(all_lines[best_start:best_end])

            results.append(
                ScratchpadSearchResult(
                    path=entry.path,
                    start_line=best_start + 1,
                    end_line=best_end,
                    score=score,
                    snippet=snippet,
                    entry_id=entry.id,
                )
            )

        # Sort by score descending and limit results
        results.sort(key=lambda r: r.score, reverse=True)
        return results[:max_results]

    async def delete(self, entry_id: str) -> bool:
        """Delete a scratchpad entry.

        Args:
            entry_id: The entry identifier.

        Returns:
            True if deleted, False if not found.
        """
        file_path = self._get_file_path(entry_id)
        try:
            os.unlink(file_path)
            logger.info("[ScratchpadService] Deleted entry: %s", entry_id)
            return True
        except FileNotFoundError:
            return False

    async def get_summary(self) -> str:
        """Get a summary of all scratchpad content.

        Returns:
            Formatted summary string.
        """
        entries = await self.list()

        if not entries:
            return "No scratchpad entries found."

        parts: list[str] = [f"**Scratchpad Summary** ({len(entries)} entries)", ""]

        for entry in entries[:10]:
            # Strip frontmatter from preview
            preview = re.sub(r"^---[\s\S]*?---\n*", "", entry.content, count=1).strip()
            preview = preview[:100].replace("\n", " ")

            parts.append(f"- **{entry.title}** ({entry.id})")
            parts.append(f"  {preview}{'...' if len(preview) >= 100 else ''}")
            parts.append(f"  _Modified: {entry.modified_at.strftime('%Y-%m-%d')}_")

        if len(entries) > 10:
            parts.append(f"\n_...and {len(entries) - 10} more entries_")

        return "\n".join(parts)

    def get_base_path(self) -> str:
        """Get the base path for scratchpad files.

        Returns:
            The configured base path string.
        """
        return self._config.base_path


def create_scratchpad_service(
    runtime: IAgentRuntime | None = None,
    config: ScratchpadConfig | None = None,
) -> ScratchpadService:
    """Factory function to create a ScratchpadService instance.

    Args:
        runtime: Optional agent runtime.
        config: Optional configuration override.

    Returns:
        A new ScratchpadService instance.
    """
    return ScratchpadService(runtime=runtime, config=config)
