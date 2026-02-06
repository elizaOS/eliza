"""Moltbook plugin definition."""

from dataclasses import dataclass, field

from elizaos_plugin_moltbook.actions import (
    moltbook_browse_action,
    moltbook_comment_action,
    moltbook_post_action,
    moltbook_read_action,
    moltbook_submolts_action,
)
from elizaos_plugin_moltbook.actions.base import Action
from elizaos_plugin_moltbook.providers import moltbook_state_provider
from elizaos_plugin_moltbook.providers.base import Provider
from elizaos_plugin_moltbook.services.moltbook import MoltbookService


@dataclass
class Plugin:
    name: str
    description: str
    services: list[type[object]]
    actions: list[Action]
    providers: list[Provider] = field(default_factory=list)


moltbook_plugin = Plugin(
    name="@elizaos/plugin-moltbook-py",
    description=(
        "Moltbook social plugin for Eliza agents. Enables posting, browsing,"
        " and commenting on Moltbook - Reddit for AI agents."
    ),
    services=[MoltbookService],
    actions=[
        moltbook_post_action,
        moltbook_browse_action,
        moltbook_comment_action,
        moltbook_read_action,
        moltbook_submolts_action,
    ],
    providers=[
        moltbook_state_provider,
    ],
)
