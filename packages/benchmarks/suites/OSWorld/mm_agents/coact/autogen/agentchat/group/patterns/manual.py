# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from typing import TYPE_CHECKING, Any, Callable, Optional, Tuple, Union

from ..context_variables import ContextVariables
from ..group_tool_executor import GroupToolExecutor
from ..targets.transition_target import AskUserTarget, TransitionTarget
from .pattern import Pattern

if TYPE_CHECKING:
    from ...conversable_agent import ConversableAgent
    from ...groupchat import GroupChat, GroupChatManager


class ManualPattern(Pattern):
    """ManualPattern will ask the user to nominate the next agent to speak at each turn."""

    def __init__(
        self,
        initial_agent: "ConversableAgent",
        agents: list["ConversableAgent"],
        user_agent: Optional["ConversableAgent"] = None,
        group_manager_args: Optional[dict[str, Any]] = None,
        context_variables: Optional[ContextVariables] = None,
        exclude_transit_message: bool = True,
        summary_method: Optional[Union[str, Callable[..., Any]]] = "last_msg",
    ):
        """Initialize the ManualPattern.

        The after_work is always set to ask_user, which will prompt the user for the next agent

        Args:
            initial_agent: The first agent to speak in the group chat.
            agents: List of all agents participating in the chat.
            user_agent: Optional user proxy agent.
            group_manager_args: Optional arguments for the GroupChatManager.
            context_variables: Initial context variables for the chat.
            exclude_transit_message: Whether to exclude transit messages from the conversation.
            summary_method: Method for summarizing the conversation.
        """
        # The group after work will be to ask the user
        group_after_work = AskUserTarget()

        super().__init__(
            initial_agent=initial_agent,
            agents=agents,
            user_agent=user_agent,
            group_manager_args=group_manager_args,
            context_variables=context_variables,
            group_after_work=group_after_work,
            exclude_transit_message=exclude_transit_message,
            summary_method=summary_method,
        )

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

        # Set up the allowed speaker transitions to exclude user_agent and GroupToolExecutor
        self._setup_allowed_transitions(groupchat, user_agent, tool_executor)

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

    def _setup_allowed_transitions(
        self, groupchat: "GroupChat", user_agent: Optional["ConversableAgent"], tool_executor: "GroupToolExecutor"
    ) -> None:
        """Set up the allowed speaker transitions for the group chat so that when a user selects the next agent the tool executor and user agent don't appear as options.

        Creates transitions where:
        1. Any agent can speak after any other agent, including themselves
        2. The user_agent and GroupToolExecutor are excluded from transitions

        Args:
            groupchat: The GroupChat instance to configure
            user_agent: The user agent to exclude from transitions
            tool_executor: The GroupToolExecutor to exclude from transitions
        """
        # NOTE: THIS IS NOT WORKING - THE TRANSITIONS ARE NOT BEING KEPT?!
        """
        # Get all agents in the group chat
        all_agents = groupchat.agents

        # Filter out user_agent and group tool executor
        eligible_agents = []
        for agent in all_agents:
            # Skip user_agent
            if agent == user_agent:
                continue

            # Skip GroupToolExecutor
            if isinstance(agent, GroupToolExecutor):
                continue

            eligible_agents.append(agent)

        # Create a fully connected graph among eligible agents
        # Each agent can be followed by any other eligible agent
        allowed_transitions = {}
        for agent in eligible_agents:
            # For each agent, every other eligible agent can follow
            allowed_transitions[agent] = eligible_agents

        # Set the transitions in the group chat
        groupchat.allowed_speaker_transitions_dict = allowed_transitions
        """
