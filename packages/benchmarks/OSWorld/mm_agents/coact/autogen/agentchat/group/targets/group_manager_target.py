# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from typing import TYPE_CHECKING, Any, Optional, Type, Union

from pydantic import BaseModel, field_validator

from ....doc_utils import export_module
from ..context_str import ContextStr
from ..group_tool_executor import GroupToolExecutor
from ..speaker_selection_result import SpeakerSelectionResult
from .transition_target import TransitionTarget
from .transition_utils import __AGENT_WRAPPER_PREFIX__

if TYPE_CHECKING:
    # Avoid circular import
    from ...conversable_agent import ConversableAgent
    from ...groupchat import GroupChat

__all__ = ["GroupManagerTarget"]


def prepare_groupchat_auto_speaker(
    groupchat: "GroupChat",
    last_group_agent: "ConversableAgent",
    group_chat_manager_selection_msg: Optional[Any],
) -> None:
    """Prepare the group chat for auto speaker selection, includes updating or restore the groupchat speaker selection message.

    Tool Executor and wrapped agents will be removed from the available agents list.

    Args:
        groupchat (GroupChat): GroupChat instance.
        last_group_agent ("ConversableAgent"): The last group agent for which the LLM config is used
        group_chat_manager_selection_msg (GroupManagerSelectionMessage): Optional message to use for the agent selection (in internal group chat).
    """
    from ...groupchat import SELECT_SPEAKER_PROMPT_TEMPLATE

    def substitute_agentlist(template: str) -> str:
        # Run through group chat's string substitution first for {agentlist}
        # We need to do this so that the next substitution doesn't fail with agentlist
        # and we can remove the tool executor and wrapped chats from the available agents list
        agent_list = [
            agent
            for agent in groupchat.agents
            if not isinstance(agent, GroupToolExecutor) and not agent.name.startswith(__AGENT_WRAPPER_PREFIX__)
        ]

        groupchat.select_speaker_prompt_template = template
        return groupchat.select_speaker_prompt(agent_list)

    # Use the default speaker selection prompt if one is not specified, otherwise use the specified one
    groupchat.select_speaker_prompt_template = substitute_agentlist(
        SELECT_SPEAKER_PROMPT_TEMPLATE
        if group_chat_manager_selection_msg is None
        else group_chat_manager_selection_msg.get_message(last_group_agent)
    )


# GroupManagerSelectionMessage protocol and implementations
@export_module("autogen.agentchat.group")
class GroupManagerSelectionMessage(BaseModel):
    """Base class for all GroupManager selection message types."""

    def get_message(self, agent: "ConversableAgent") -> str:
        """Get the formatted message."""
        raise NotImplementedError("Requires subclasses to implement.")


@export_module("autogen.agentchat.group")
class GroupManagerSelectionMessageString(GroupManagerSelectionMessage):
    """Selection message that uses a plain string template."""

    message: str

    def get_message(self, agent: "ConversableAgent") -> str:
        """Get the message string."""
        return self.message


@export_module("autogen.agentchat.group")
class GroupManagerSelectionMessageContextStr(GroupManagerSelectionMessage):
    """Selection message that uses a ContextStr template."""

    context_str_template: str

    # We will replace {agentlist} with another term and return it later for use with the internal group chat auto speaker selection
    # Otherwise our format will fail
    @field_validator("context_str_template", mode="before")
    def _replace_agentlist_placeholder(cls: Type["GroupManagerSelectionMessageContextStr"], v: Any) -> Union[str, Any]:  # noqa: N805
        """Replace {agentlist} placeholder before validation/assignment."""
        if isinstance(v, str):
            if "{agentlist}" in v:
                return v.replace("{agentlist}", "<<agent_list>>")  # Perform the replacement
            else:
                return v  # If no replacement is needed, return the original value
        return ""

    def get_message(self, agent: "ConversableAgent") -> str:
        """Get the formatted message with context variables substituted."""
        context_str = ContextStr(template=self.context_str_template)
        format_result = context_str.format(agent.context_variables)
        if format_result is None:
            return ""

        return format_result.replace(
            "<<agent_list>>", "{agentlist}"
        )  # Restore agentlist so it can be substituted by the internal group chat auto speaker selection


class GroupManagerTarget(TransitionTarget):
    """Target that represents an agent by name."""

    selection_message: Optional[GroupManagerSelectionMessage] = None

    def can_resolve_for_speaker_selection(self) -> bool:
        """Check if the target can resolve for speaker selection."""
        return True

    def resolve(
        self,
        groupchat: "GroupChat",
        current_agent: "ConversableAgent",
        user_agent: Optional["ConversableAgent"],
    ) -> SpeakerSelectionResult:
        """Resolve to the speaker selection for the group."""
        if self.selection_message is not None:
            prepare_groupchat_auto_speaker(groupchat, current_agent, self.selection_message)

        return SpeakerSelectionResult(speaker_selection_method="auto")

    def display_name(self) -> str:
        """Get the display name for the target."""
        return "the group manager"

    def normalized_name(self) -> str:
        """Get a normalized name for the target that has no spaces, used for function calling"""
        return self.display_name()

    def __str__(self) -> str:
        """String representation for AgentTarget, can be shown as a function call message."""
        return "Transfer to the group manager"

    def needs_agent_wrapper(self) -> bool:
        """Check if the target needs to be wrapped in an agent."""
        return False

    def create_wrapper_agent(self, parent_agent: "ConversableAgent", index: int) -> "ConversableAgent":
        """Create a wrapper agent for the target if needed."""
        raise NotImplementedError("GroupManagerTarget does not require wrapping in an agent.")
