"""Task clipboard service -- bounded working memory.

A JSON-backed clipboard limited to TASK_CLIPBOARD_MAX_ITEMS entries,
with optional per-entity scoping.
"""

from __future__ import annotations

import json
import logging
import os
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

from ..types import (
    TASK_CLIPBOARD_MAX_ITEMS,
    AddTaskClipboardItemInput,
    TaskClipboardItem,
    TaskClipboardSnapshot,
)

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime

    from ..types import ClipboardConfig

logger = logging.getLogger(__name__)

TASK_CLIPBOARD_FILE = "clipboard.json"
CLIPBOARD_DIR = "clipboard"


def _sanitize_title(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()[:120]


def _default_title(inp: AddTaskClipboardItemInput) -> str:
    if inp.title and inp.title.strip():
        return _sanitize_title(inp.title)
    if inp.source_type == "command":
        return _sanitize_title(inp.source_label or inp.source_id or "Command")
    if inp.source_type in ("attachment", "image_attachment"):
        return _sanitize_title(inp.source_label or inp.source_id or "Attachment")
    if inp.source_type == "file":
        return _sanitize_title(inp.source_label or inp.source_id or "File")
    return "Clipboard Item"


def _normalize_content(content: str) -> str:
    return content.replace("\r\n", "\n").strip()


class TaskClipboardService:
    """Bounded task clipboard backed by JSON files."""

    def __init__(
        self,
        runtime: IAgentRuntime,
        config: ClipboardConfig | None = None,
    ) -> None:
        from .clipboard_service import _resolve_clipboard_config

        self._config = _resolve_clipboard_config(config, runtime)

    def _ensure_directory(self, subdir: str | None = None) -> None:
        d = os.path.join(self._config.base_path, subdir) if subdir else self._config.base_path
        Path(d).mkdir(parents=True, exist_ok=True)

    def _get_store_path(self, entity_id: str | None = None) -> str:
        if entity_id:
            safe_id = re.sub(r"[^a-zA-Z0-9_-]", "_", entity_id)
            return os.path.join(self._config.base_path, CLIPBOARD_DIR, f"{safe_id}.json")
        return os.path.join(self._config.base_path, TASK_CLIPBOARD_FILE)

    def _read_store(self, entity_id: str | None = None) -> dict:
        store_path = self._get_store_path(entity_id)
        parent = os.path.dirname(store_path)
        rel = (
            os.path.relpath(parent, self._config.base_path)
            if parent != self._config.base_path
            else None
        )
        self._ensure_directory(rel)

        try:
            with open(store_path, encoding="utf-8") as f:
                parsed = json.load(f)
            if not isinstance(parsed, dict) or not isinstance(parsed.get("items"), list):
                return {"version": 1, "maxItems": TASK_CLIPBOARD_MAX_ITEMS, "items": []}

            items = [
                item
                for item in parsed["items"]
                if (
                    isinstance(item, dict)
                    and isinstance(item.get("id"), str)
                    and isinstance(item.get("title"), str)
                    and isinstance(item.get("content"), str)
                    and isinstance(item.get("sourceType"), str)
                    and isinstance(item.get("createdAt"), str)
                    and isinstance(item.get("updatedAt"), str)
                )
            ]
            items.sort(key=lambda x: x.get("updatedAt", ""), reverse=True)
            max_items = parsed.get("maxItems", TASK_CLIPBOARD_MAX_ITEMS)
            if not isinstance(max_items, int) or max_items <= 0:
                max_items = TASK_CLIPBOARD_MAX_ITEMS
            return {"version": 1, "maxItems": max_items, "items": items}
        except FileNotFoundError:
            return {"version": 1, "maxItems": TASK_CLIPBOARD_MAX_ITEMS, "items": []}
        except Exception as e:
            logger.warning("[TaskClipboardService] Failed to read store: %s", e)
            return {"version": 1, "maxItems": TASK_CLIPBOARD_MAX_ITEMS, "items": []}

    def _write_store(self, store: dict, entity_id: str | None = None) -> None:
        store_path = self._get_store_path(entity_id)
        parent = os.path.dirname(store_path)
        rel = (
            os.path.relpath(parent, self._config.base_path)
            if parent != self._config.base_path
            else None
        )
        self._ensure_directory(rel)

        tmp_path = f"{store_path}.tmp-{uuid.uuid4().hex[:8]}"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(store, f, indent=2)
        os.replace(tmp_path, store_path)

    def _item_from_dict(self, d: dict) -> TaskClipboardItem:
        return TaskClipboardItem(
            id=d["id"],
            title=d["title"],
            content=d["content"],
            source_type=d["sourceType"],
            source_id=d.get("sourceId"),
            source_label=d.get("sourceLabel"),
            mime_type=d.get("mimeType"),
            created_at=d["createdAt"],
            updated_at=d["updatedAt"],
        )

    def _item_to_dict(self, item: TaskClipboardItem) -> dict:
        d: dict = {
            "id": item.id,
            "title": item.title,
            "content": item.content,
            "sourceType": item.source_type,
            "createdAt": item.created_at,
            "updatedAt": item.updated_at,
        }
        if item.source_id:
            d["sourceId"] = item.source_id
        if item.source_label:
            d["sourceLabel"] = item.source_label
        if item.mime_type:
            d["mimeType"] = item.mime_type
        return d

    async def get_snapshot(self, entity_id: str | None = None) -> TaskClipboardSnapshot:
        store = self._read_store(entity_id)
        return TaskClipboardSnapshot(
            max_items=store["maxItems"],
            items=[self._item_from_dict(d) for d in store["items"]],
        )

    async def list_items(self, entity_id: str | None = None) -> list[TaskClipboardItem]:
        snapshot = await self.get_snapshot(entity_id)
        return snapshot.items

    async def get_item(
        self, item_id: str, entity_id: str | None = None
    ) -> TaskClipboardItem | None:
        items = await self.list_items(entity_id)
        for item in items:
            if item.id == item_id:
                return item
        return None

    async def add_item(
        self,
        inp: AddTaskClipboardItemInput,
        entity_id: str | None = None,
    ) -> tuple[TaskClipboardItem, bool, TaskClipboardSnapshot]:
        """Add or replace an item. Returns (item, replaced, snapshot)."""
        content = _normalize_content(inp.content)
        if not content:
            raise ValueError("Clipboard items require non-empty content.")

        store = self._read_store(entity_id)
        now = datetime.now().isoformat()

        # Check for replacement by source
        replacement_idx = -1
        if inp.source_type and inp.source_id:
            for i, existing in enumerate(store["items"]):
                if (
                    existing.get("sourceType") == inp.source_type
                    and existing.get("sourceId") == inp.source_id
                ):
                    replacement_idx = i
                    break

        if replacement_idx == -1 and len(store["items"]) >= store["maxItems"]:
            raise ValueError(
                f"Clipboard is full ({len(store['items'])}/{store['maxItems']}). "
                "Remove an unused item before adding another."
            )

        existing_item = store["items"][replacement_idx] if replacement_idx >= 0 else None

        item_dict: dict = {
            "id": existing_item["id"] if existing_item else f"cb-{uuid.uuid4().hex[:8]}",
            "title": _default_title(inp),
            "content": content,
            "sourceType": inp.source_type or "manual",
            "createdAt": existing_item["createdAt"] if existing_item else now,
            "updatedAt": now,
        }
        if inp.source_id:
            item_dict["sourceId"] = inp.source_id
        if inp.source_label:
            item_dict["sourceLabel"] = inp.source_label
        if inp.mime_type:
            item_dict["mimeType"] = inp.mime_type

        replaced = replacement_idx >= 0
        if replaced:
            store["items"][replacement_idx] = item_dict
        else:
            store["items"].insert(0, item_dict)

        store["items"].sort(key=lambda x: x.get("updatedAt", ""), reverse=True)
        self._write_store(store, entity_id)

        item = self._item_from_dict(item_dict)
        snapshot = TaskClipboardSnapshot(
            max_items=store["maxItems"],
            items=[self._item_from_dict(d) for d in store["items"]],
        )
        return item, replaced, snapshot

    async def remove_item(
        self,
        item_id: str,
        entity_id: str | None = None,
    ) -> tuple[bool, TaskClipboardSnapshot]:
        """Remove an item by ID. Returns (removed, snapshot)."""
        store = self._read_store(entity_id)
        next_items = [d for d in store["items"] if d.get("id") != item_id]
        removed = len(next_items) < len(store["items"])
        if removed:
            store["items"] = next_items
            self._write_store(store, entity_id)
        snapshot = TaskClipboardSnapshot(
            max_items=store["maxItems"],
            items=[self._item_from_dict(d) for d in store["items"]],
        )
        return removed, snapshot


def create_task_clipboard_service(
    runtime: IAgentRuntime,
    config: ClipboardConfig | None = None,
) -> TaskClipboardService:
    return TaskClipboardService(runtime, config)
