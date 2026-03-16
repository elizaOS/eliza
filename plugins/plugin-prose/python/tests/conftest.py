"""Shared fixtures for plugin-prose tests."""

from __future__ import annotations

from typing import Any

import pytest

import elizaos_plugin_prose.services.prose_service as _prose_svc_mod
from elizaos_plugin_prose.services.prose_service import ProseService
from elizaos_plugin_prose.types import ProseConfig, ProseStateMode


# ---------------------------------------------------------------------------
# Message helpers
# ---------------------------------------------------------------------------


def make_message(text: str) -> dict[str, Any]:
    """Build a minimal message dict matching the shape actions/providers expect."""
    return {
        "id": "test-message-id",
        "content": {"text": text},
        "userId": "test-user",
        "roomId": "test-room",
    }


def make_state(**kwargs: Any) -> dict[str, Any]:
    """Build a minimal state dict."""
    return kwargs


# ---------------------------------------------------------------------------
# Service fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def prose_service() -> ProseService:
    """Return a default ProseService (no skill files loaded)."""
    return ProseService()


@pytest.fixture()
def prose_service_with_config() -> ProseService:
    """Return a ProseService with a custom config."""
    config = ProseConfig(
        workspace_dir="custom/.prose",
        default_state_mode=ProseStateMode.SQLITE,
    )
    return ProseService(config=config)


@pytest.fixture(autouse=True)
def _clear_skill_cache() -> None:
    """Ensure the module-level skill cache is empty before each test."""
    _prose_svc_mod._skill_content.clear()


@pytest.fixture()
def populated_skill_cache() -> dict[str, str]:
    """Populate the module-level skill cache with stub content and return it."""
    stubs = {
        "prose.md": "# VM Specification\nOpenProse VM spec stub.",
        "SKILL.md": "# SKILL\nSkill description stub.",
        "help.md": "# Help\nHelp documentation stub.",
        "compiler.md": "# Compiler\nCompiler spec stub.",
        "state/filesystem.md": "# Filesystem state\nFilesystem state spec stub.",
        "state/in-context.md": "# In-context state\nIn-context state spec stub.",
        "state/sqlite.md": "# SQLite state\nSQLite state spec stub.",
        "state/postgres.md": "# Postgres state\nPostgres state spec stub.",
        "guidance/patterns.md": "# Patterns\nAuthoring patterns stub.",
        "guidance/antipatterns.md": "# Antipatterns\nAntipatterns stub.",
    }
    _prose_svc_mod._skill_content.update(stubs)
    return stubs
