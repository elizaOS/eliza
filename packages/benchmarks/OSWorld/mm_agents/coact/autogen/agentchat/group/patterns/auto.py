# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from typing import TYPE_CHECKING, Any, Callable, Optional, Tuple, Union

from ..context_variables import ContextVariables
from ..targets.group_manager_target import GroupManagerSelectionMessage, GroupManagerTarget
from ..targets.transition_target import TransitionTarget
from .pattern import Pattern

if TYPE_CHECKING:
    from ...conversable_agent import ConversableAgent
    from ...groupchat import GroupChat, GroupChatManager
    from ..group_tool_executor import GroupToolExecutor


class AutoPattern(Pattern):
    """AutoPattern implements a flexible pattern where agents are selected based on their expertise.

    In this pattern, a group manager automatically selects the next agent to speak based on the context
    of the conversation and agent descriptions. The after_work is always set to "group_manager" as
    this is the defining characteristic of this pattern.
    """

    def __init__(
        self,
        initial_agent: "ConversableAgent",
        agents: list["ConversableAgent"],
        user_agent: Optional["ConversableAgent"] = None,
        group_manager_args: Optional[dict[str, Any]] = None,
        context_variables: Optional[ContextVariables] = None,
        selection_message: Optional[GroupManagerSelectionMessage] = None,
        exclude_transit_message: bool = True,
        summary_method: Optional[Union[str, Callable[..., Any]]] = "last_msg",
    ):
        """Initialize the AutoPattern.

        The after_work is always set to group_manager selection, which is the defining
        characteristic of this pattern. You can customize the selection message used
        by the group manager when selecting the next agent.

        Args:
            initial_agent: The first agent to speak in the group chat.
            agents: List of all agents participating in the chat.
            user_agent: Optional user proxy agent.
            group_manager_args: Optional arguments for the GroupChatManager.
            context_variables: Initial context variables for the chat.
            selection_message: Custom message to use when the group manager is selecting agents.
            exclude_transit_message: Whether to exclude transit messages from the conversation.
            summary_method: Method for summarizing the conversation.
        """
        # Create the group_manager after_work with the provided selection message
        group_manager_after_work = GroupManagerTarget(selection_message=selection_message)

        super().__init__(
            initial_agent=initial_agent,
            agents=agents,
            user_agent=user_agent,
            group_manager_args=group_manager_args,
            context_variables=context_variables,
            group_after_work=group_manager_after_work,
            exclude_transit_message=exclude_transit_message,
            summary_method=summary_method,
        )

        # Store the selection message for potential use
        self.selection_message = selection_message

    def prepare_group_chat(
        self,
        max_rounds: int,
        messages: Union[list[dict[str, Any]], str],
    ) -> Tuple[
        list["ConversableAgent"],
        list["ConversableAgent"],
        Optional["ConversableAgent"],
        ContextVariables,
        "ConversableAgent",
        TransitionTarget,
        "GroupToolExecutor",
        "GroupChat",
        "GroupChatManager",
        list[dict[str, Any]],
        Any,
        list[str],
        list[Any],
    ]:
        """Prepare the group chat for organic agent selection.

        Ensures that:
        1. The group manager has a valid LLM config
        2. All agents have appropriate descriptions for the group manager to use

        Args:
            max_rounds: Maximum number of conversation rounds.
            messages: Initial message(s) to start the conversation.

        Returns:
            Tuple containing all necessary components for the group chat.
        """
        # Validate that group_manager_args has an LLM config which is required for this pattern
        if not self.group_manager_args.get("llm_config", False):
            # Check if any agent has an LLM config we can use
            has_llm_config = any(getattr(agent, "llm_config", False) for agent in self.agents)

            if not has_llm_config:
                raise ValueError(
                    "AutoPattern requires the group_manager_args to include an llm_config, "
                    "or at least one agent to have an llm_config"
                )

        # Check that all agents have descriptions for effective group manager selection
        for agent in self.agents:
            if not hasattr(agent, "description") or not agent.description:
                agent.description = f"Agent {agent.name}"

        # Use the parent class's implementation to prepare the agents and group chat
        components = super().prepare_group_chat(
            max_rounds=max_rounds,
            messages=messages,
        )

        # Extract the group_after_work and the rest of the components
        (
            agents,
            wrapped_agents,
            user_agent,
            context_variables,
            initial_agent,
            _,
            tool_executor,
            groupchat,
            manager,
            processed_messages,
            last_agent,
            group_agent_names,
            temp_user_list,
        ) = components

        # Ensure we're using the group_manager after_work
        group_after_work = self.group_after_work

        # Return all components with our group_after_work
        return (
            agents,
            wrapped_agents,
            user_agent,
            context_variables,
            initial_agent,
            group_after_work,
            tool_executor,
            groupchat,
            manager,
            processed_messages,
            last_agent,
            group_agent_names,
            temp_user_list,
        )
