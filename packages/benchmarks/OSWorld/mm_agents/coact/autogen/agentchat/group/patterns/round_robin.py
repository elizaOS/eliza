# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from typing import TYPE_CHECKING, Any, Optional, Tuple, Union

from ..context_variables import ContextVariables
from ..targets.transition_target import AgentTarget, TransitionTarget
from .pattern import Pattern

if TYPE_CHECKING:
    from ...conversable_agent import ConversableAgent
    from ...groupchat import GroupChat, GroupChatManager
    from ..group_tool_executor import GroupToolExecutor


class RoundRobinPattern(Pattern):
    """RoundRobinPattern implements a round robin with handoffs between agents."""

    def _generate_handoffs(
        self,
        initial_agent: "ConversableAgent",
        agents: list["ConversableAgent"],
        user_agent: Optional["ConversableAgent"],
    ) -> None:
        """Generate handoffs between agents in a round-robin fashion."""
        # Create a list of the agents and the user_agent but put the initial_agent first
        agent_list = [initial_agent]

        # Add the rest of the agents, excluding the initial_agent and user_agent
        for agent in agents:
            if agent != initial_agent and (user_agent is None or agent != user_agent):
                agent_list.append(agent)

        # Add the user_agent last if it exists
        if user_agent is not None:
            agent_list.append(user_agent)

        # Create handoffs in a round-robin fashion
        for i, agent in enumerate(agent_list):
            # Last agent hands off to the first agent
            # Otherwise agent hands off to the next one
            handoff_target = agent_list[0] if i == len(agent_list) - 1 else agent_list[i + 1]

            agent.handoffs.set_after_work(target=AgentTarget(agent=handoff_target))

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

        # Create the handoffs between agents
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
