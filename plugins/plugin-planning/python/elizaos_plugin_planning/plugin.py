"""Plugin definition for the planning plugin."""

from dataclasses import dataclass, field

from elizaos_plugin_planning.actions import (
    complete_task_action,
    create_plan_action,
    get_plan_action,
    update_plan_action,
)
from elizaos_plugin_planning.actions.base import Action
from elizaos_plugin_planning.providers import plan_status_provider
from elizaos_plugin_planning.providers.base import Provider


@dataclass
class Plugin:
    name: str
    description: str
    actions: list[Action]
    providers: list[Provider] = field(default_factory=list)


planning_plugin = Plugin(
    name="@elizaos/plugin-planning-py",
    description="Plugin for planning and task management with create, update, complete, and get capabilities",
    actions=[
        create_plan_action,
        update_plan_action,
        complete_task_action,
        get_plan_action,
    ],
    providers=[
        plan_status_provider,
    ],
)
