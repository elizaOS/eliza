"""Plugin definition for the memory plugin."""

from dataclasses import dataclass, field

from elizaos_plugin_memory.actions import (
    forget_action,
    recall_action,
    remember_action,
)
from elizaos_plugin_memory.actions.base import Action
from elizaos_plugin_memory.providers import memory_context_provider
from elizaos_plugin_memory.providers.base import Provider


@dataclass
class Plugin:
    name: str
    description: str
    actions: list[Action]
    providers: list[Provider] = field(default_factory=list)


memory_plugin = Plugin(
    name="@elizaos/plugin-memory-py",
    description="Plugin for long-term memory management with remember, recall, and forget capabilities",
    actions=[
        remember_action,
        recall_action,
        forget_action,
    ],
    providers=[
        memory_context_provider,
    ],
)
