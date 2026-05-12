# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from typing import TYPE_CHECKING, Any, Optional, Tuple, Union

from ..context_variables import ContextVariables
from ..targets.transition_target import RandomAgentTarget, TransitionTarget
from .pattern import Pattern

if TYPE_CHECKING:
    from ...conversable_agent import ConversableAgent
    from ...groupchat import GroupChat, GroupChatManager
    from ..group_tool_executor import GroupToolExecutor


class RandomPattern(Pattern):
    """RandomPattern implements a random agent selection process."""

    def _generate_handoffs(
        self,
        initial_agent: "ConversableAgent",
        agents: list["ConversableAgent"],
        user_agent: Optional["ConversableAgent"],
    ) -> None:
        """Generate handoffs between agents in a random fashion."""
        agent_list = agents + ([user_agent] if user_agent is not None else [])

        for agent in agent_list:
            # Get the list of agents except itself
            other_agents = [a for a in agent_list if a != agent]

            # Create a random after work
            agent.handoffs.set_after_work(target=RandomAgentTarget(agents=other_agents))

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
        (
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
        ) = super().prepare_group_chat(
            max_rounds=max_rounds,
            messages=messages,
        )

        # Create the random handoffs between agents
        self._generate_handoffs(initial_agent=initial_agent, agents=agents, user_agent=user_agent)

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
