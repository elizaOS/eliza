"""File-based clipboard storage service.

Provides write, read, search, list, and delete operations on markdown files
stored in the clipboard directory.
"""

from __future__ import annotations

import builtins
import contextlib
import logging
import os
import re
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

from ..types import (
    ClipboardConfig,
    ClipboardEntry,
    ClipboardReadOptions,
    ClipboardSearchOptions,
    ClipboardSearchResult,
    ClipboardWriteOptions,
)

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime

logger = logging.getLogger(__name__)

DEFAULT_CLIPBOARD_CONFIG = ClipboardConfig(
    base_path=os.path.join(os.path.expanduser("~"), ".eliza", "clipboard"),
    max_file_size=1024 * 1024,
    allowed_extensions=[".md", ".txt"],
)


def _resolve_clipboard_config(
    config: ClipboardConfig | None = None,
    runtime: IAgentRuntime | None = None,
) -> ClipboardConfig:
    """Resolve config from runtime settings, env vars, and explicit config."""
    base = ClipboardConfig(
        base_path=DEFAULT_CLIPBOARD_CONFIG.base_path,
        max_file_size=DEFAULT_CLIPBOARD_CONFIG.max_file_size,
        allowed_extensions=list(DEFAULT_CLIPBOARD_CONFIG.allowed_extensions),
    )

    # Check runtime settings
    if runtime:
        bp = runtime.get_setting("CLIPBOARD_BASE_PATH") if hasattr(runtime, "get_setting") else None
        if isinstance(bp, str) and bp.strip():
            base.base_path = bp.strip()
        mfs = (
            runtime.get_setting("CLIPBOARD_MAX_FILE_SIZE")
            if hasattr(runtime, "get_setting")
            else None
        )
        if isinstance(mfs, (str, int, float)) and not isinstance(mfs, bool):
            with contextlib.suppress(ValueError, TypeError):
                base.max_file_size = int(mfs)

    # Check env vars
    env_bp = os.environ.get("CLIPBOARD_BASE_PATH")
    if env_bp and env_bp.strip():
        base.base_path = env_bp.strip()
    env_mfs = os.environ.get("CLIPBOARD_MAX_FILE_SIZE")
    if env_mfs:
        with contextlib.suppress(ValueError, TypeError):
            base.max_file_size = int(env_mfs)

    # Override with explicit config
    if config:
        if config.base_path:
            base.base_path = config.base_path
        if config.max_file_size:
            base.max_file_size = config.max_file_size
        if config.allowed_extensions:
            base.allowed_extensions = config.allowed_extensions

    return base


class ClipboardService:
    """Service for managing file-based clipboard memories."""

    def __init__(
        self,
        runtime: IAgentRuntime,
        config: ClipboardConfig | None = None,
    ) -> None:
        self._config = _resolve_clipboard_config(config, runtime)

    async def _ensure_directory(self) -> None:
        Path(self._config.base_path).mkdir(parents=True, exist_ok=True)

    def _sanitize_filename(self, title: str) -> str:
        return re.sub(r"[^a-z0-9\s-]", "", title.lower()).replace(" ", "-").strip("-")[:100]

    def _get_file_path(self, entry_id: str) -> str:
        filename = entry_id if entry_id.endswith(".md") else f"{entry_id}.md"
        return os.path.join(self._config.base_path, filename)

    def _get_entry_id(self, filename: str) -> str:
        return os.path.splitext(os.path.basename(filename))[0]

    async def write(
        self,
        title: str,
        content: str,
        options: ClipboardWriteOptions | None = None,
    ) -> ClipboardEntry:
        """Write or append content to a clipboard entry."""
        await self._ensure_directory()
        options = options or ClipboardWriteOptions()

        entry_id = self._sanitize_filename(title)
        file_path = self._get_file_path(entry_id)
        now = datetime.now()

        created_at = now
        if os.path.exists(file_path) and options.append:
            existing = await self.read(entry_id)
            final_content = f"{existing.content}\n\n---\n\n{content}"
            created_at = existing.created_at
        else:
            tags_line = f"tags: [{', '.join(options.tags)}]" if options.tags else ""
            frontmatter_parts = [
                "---",
                f'title: "{title}"',
                f"created: {now.isoformat()}",
                f"modified: {now.isoformat()}",
            ]
            if tags_line:
                frontmatter_parts.append(tags_line)
            frontmatter_parts.extend(["---", ""])
            frontmatter = "\n".join(frontmatter_parts)
            final_content = f"{frontmatter}\n{content}"

        # Check file size
        if len(final_content.encode("utf-8")) > self._config.max_file_size:
            raise ValueError(
                f"Content exceeds maximum file size of {self._config.max_file_size} bytes"
            )

        with open(file_path, "w", encoding="utf-8") as f:
            f.write(final_content)

        logger.info("[ClipboardService] Wrote entry: %s", entry_id)

        return ClipboardEntry(
            id=entry_id,
            path=file_path,
            title=title,
            content=final_content,
            created_at=created_at,
            modified_at=now,
            tags=options.tags,
        )

    async def read(
        self,
        entry_id: str,
        options: ClipboardReadOptions | None = None,
    ) -> ClipboardEntry:
        """Read a clipboard entry by ID."""
        options = options or ClipboardReadOptions()
        file_path = self._get_file_path(entry_id)

        if not os.path.exists(file_path):
            raise FileNotFoundError(f"Clipboard entry not found: {entry_id}")

        stat = os.stat(file_path)
        with open(file_path, encoding="utf-8") as f:
            content = f.read()

        # Handle line range
        if options.from_line is not None or options.lines is not None:
            lines = content.split("\n")
            from_idx = max(0, (options.from_line or 1) - 1)
            num_lines = options.lines or (len(lines) - from_idx)
            content = "\n".join(lines[from_idx : from_idx + num_lines])

        # Parse frontmatter
        title = entry_id
        tags: list[str] = []
        created_at = datetime.fromtimestamp(stat.st_ctime)

        fm_match = re.match(r"^---\n([\s\S]*?)\n---", content)
        if fm_match:
            fm = fm_match.group(1)
            title_match = re.search(r'title:\s*"?([^"\n]+)"?', fm)
            tags_match = re.search(r"tags:\s*\[([^\]]+)\]", fm)
            created_match = re.search(r"created:\s*(.+)", fm)
            if title_match:
                title = title_match.group(1)
            if tags_match:
                tags = [t.strip() for t in tags_match.group(1).split(",")]
            if created_match:
                with contextlib.suppress(ValueError):
                    created_at = datetime.fromisoformat(created_match.group(1).strip())

        return ClipboardEntry(
            id=entry_id,
            path=file_path,
            title=title,
            content=content,
            created_at=created_at,
            modified_at=datetime.fromtimestamp(stat.st_mtime),
            tags=tags if tags else None,
        )

    async def exists(self, entry_id: str) -> bool:
        return os.path.exists(self._get_file_path(entry_id))

    async def list(self) -> list[ClipboardEntry]:
        """List all clipboard entries sorted by modification date."""
        await self._ensure_directory()
        entries: list[ClipboardEntry] = []

        try:
            for filename in os.listdir(self._config.base_path):
                ext = os.path.splitext(filename)[1]
                if ext not in self._config.allowed_extensions:
                    continue
                try:
                    entry_id = self._get_entry_id(filename)
                    entry = await self.read(entry_id)
                    entries.append(entry)
                except Exception as e:
                    logger.warning(
                        "[ClipboardService] Failed to read entry %s: %s",
                        filename,
                        e,
                    )
        except Exception as e:
            logger.error("[ClipboardService] Failed to list entries: %s", e)

        return sorted(entries, key=lambda e: e.modified_at, reverse=True)

    async def search(
        self,
        query: str,
        options: ClipboardSearchOptions | None = None,
    ) -> builtins.list[ClipboardSearchResult]:
        """Search clipboard entries using text matching."""
        options = options or ClipboardSearchOptions()
        entries = await self.list()
        results: list[ClipboardSearchResult] = []

        query_terms = [t for t in query.lower().split() if len(t) > 2]
        if not query_terms:
            return results

        for entry in entries:
            lines = entry.content.split("\n")
            content_lower = entry.content.lower()

            match_count = 0
            for term in query_terms:
                match_count += content_lower.count(term)

            if match_count == 0:
                continue

            score = min(1.0, match_count / (len(query_terms) * 3))
            if score < options.min_score:
                continue

            # Find best snippet
            best_start = 0
            best_end = min(len(lines), 5)
            for i, line in enumerate(lines):
                line_lower = line.lower()
                if any(term in line_lower for term in query_terms):
                    best_start = max(0, i - 2)
                    best_end = min(len(lines), i + 3)
                    break

            snippet = "\n".join(lines[best_start:best_end])

            results.append(
                ClipboardSearchResult(
                    path=entry.path,
                    start_line=best_start + 1,
                    end_line=best_end,
                    score=score,
                    snippet=snippet,
                    entry_id=entry.id,
                )
            )

        results.sort(key=lambda r: r.score, reverse=True)
        return results[: options.max_results]

    async def delete(self, entry_id: str) -> bool:
        """Delete a clipboard entry."""
        file_path = self._get_file_path(entry_id)
        try:
            os.unlink(file_path)
            logger.info("[ClipboardService] Deleted entry: %s", entry_id)
            return True
        except FileNotFoundError:
            return False

    async def get_summary(self) -> str:
        """Get a summary of all clipboard content."""
        entries = await self.list()
        if not entries:
            return "No clipboard entries found."

        parts = [f"**Clipboard Summary** ({len(entries)} entries)", ""]
        for entry in entries[:10]:
            preview = (
                re.sub(r"^---[\s\S]*?---\n*", "", entry.content, count=1)[:100]
                .replace("\n", " ")
                .strip()
            )
            parts.append(f"- **{entry.title}** ({entry.id})")
            parts.append(f"  {preview}{'...' if len(preview) >= 100 else ''}")
            parts.append(f"  _Modified: {entry.modified_at.strftime('%Y-%m-%d')}_")

        if len(entries) > 10:
            parts.append(f"\n_...and {len(entries) - 10} more entries_")

        return "\n".join(parts)

    def get_base_path(self) -> str:
        return self._config.base_path


def create_clipboard_service(
    runtime: IAgentRuntime,
    config: ClipboardConfig | None = None,
) -> ClipboardService:
    return ClipboardService(runtime, config)
