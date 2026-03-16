from dataclasses import dataclass, field

from elizaos_plugin_linear.actions import (
    clear_activity_action,
    create_comment_action,
    create_issue_action,
    delete_issue_action,
    get_activity_action,
    get_issue_action,
    list_projects_action,
    list_teams_action,
    search_issues_action,
    update_issue_action,
)
from elizaos_plugin_linear.actions.base import Action
from elizaos_plugin_linear.providers import (
    linear_activity_provider,
    linear_issues_provider,
    linear_projects_provider,
    linear_teams_provider,
)
from elizaos_plugin_linear.providers.base import Provider
from elizaos_plugin_linear.services.linear import LinearService


@dataclass
class Plugin:
    name: str
    description: str
    services: list[type[object]]
    actions: list[Action]
    providers: list[Provider] = field(default_factory=list)


linear_plugin = Plugin(
    name="@elizaos/plugin-linear-py",
    description="Plugin for integrating with Linear issue tracking system",
    services=[LinearService],
    actions=[
        create_issue_action,
        get_issue_action,
        update_issue_action,
        delete_issue_action,
        search_issues_action,
        create_comment_action,
        list_teams_action,
        list_projects_action,
        get_activity_action,
        clear_activity_action,
    ],
    providers=[
        linear_issues_provider,
        linear_teams_provider,
        linear_projects_provider,
        linear_activity_provider,
    ],
)
