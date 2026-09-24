# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from typing import TYPE_CHECKING, Any, Optional, Union

from pydantic import BaseModel

from ....doc_utils import export_module
from ...agent import Agent
from ..speaker_selection_result import SpeakerSelectionResult
from .transition_target import AgentTarget, TransitionTarget
from .transition_utils import __AGENT_WRAPPER_PREFIX__

if TYPE_CHECKING:
    from ...conversable_agent import ConversableAgent
    from ...groupchat import GroupChat
    from ..patterns.pattern import Pattern


__all__ = ["GroupChatConfig", "GroupChatTarget"]


@export_module("autogen.agentchat.group")
class GroupChatConfig(BaseModel):
    """Configuration for a group chat transition target.

    Note: If context_variables are not passed in, the outer context variables will be passed in"""

    pattern: "Pattern"
    messages: Union[list[dict[str, Any]], str]
    max_rounds: int = 20


@export_module("autogen.agentchat.group")
class GroupChatTarget(TransitionTarget):
    """Target that represents a group chat."""

    group_chat_config: GroupChatConfig

    def can_resolve_for_speaker_selection(self) -> bool:
        """Check if the target can resolve for speaker selection. For GroupChatTarget the chat must be encapsulated into an agent."""
        return False

    def resolve(
        self,
        groupchat: "GroupChat",
        current_agent: "ConversableAgent",
        user_agent: Optional["ConversableAgent"],
    ) -> SpeakerSelectionResult:
        """Resolve to the nested chat configuration."""
        raise NotImplementedError(
            "GroupChatTarget does not support the resolve method. An agent should be used to encapsulate this nested chat and then the target changed to an AgentTarget."
        )

    def display_name(self) -> str:
        """Get the display name for the target."""
        return "a group chat"

    def normalized_name(self) -> str:
        """Get a normalized name for the target that has no spaces, used for function calling."""
        return "group_chat"

    def __str__(self) -> str:
        """String representation for AgentTarget, can be shown as a function call message."""
        return "Transfer to group chat"

    def needs_agent_wrapper(self) -> bool:
        """Check if the target needs to be wrapped in an agent. GroupChatTarget must be wrapped in an agent."""
        return True

    def create_wrapper_agent(self, parent_agent: "ConversableAgent", index: int) -> "ConversableAgent":
        """Create a wrapper agent for the group chat."""
        from autogen.agentchat import initiate_group_chat

        from ...conversable_agent import ConversableAgent  # to avoid circular import

        # Create the wrapper agent with a name that identifies it as a wrapped group chat
        group_chat_agent = ConversableAgent(
            name=f"{__AGENT_WRAPPER_PREFIX__}group_{parent_agent.name}_{index + 1}",
            # Copy LLM config from parent agent to ensure it can generate replies if needed
            llm_config=parent_agent.llm_config,
        )

        # Store the config directly on the agent
        group_chat_agent._group_chat_config = self.group_chat_config  # type: ignore[attr-defined]

        # Define the reply function that will run the group chat
        def group_chat_reply(
            agent: "ConversableAgent",
            messages: Optional[list[dict[str, Any]]] = None,
            sender: Optional["Agent"] = None,
            config: Optional[Any] = None,
        ) -> tuple[bool, Optional[dict[str, Any]]]:
            """Run the inner group chat and return its results as a reply."""
            # Get the configuration stored directly on the agent
            group_config = agent._group_chat_config  # type: ignore[attr-defined]

            # Pull through the second last message from the outer chat (the last message will be the handoff message)
            # This may need work to make sure we get the right message(s) from the outer chat
            message = (
                messages[-2]["content"]
                if messages and len(messages) >= 2 and "content" in messages[-2]
                else "No message to pass through."
            )

            try:
                # Run the group chat with direct agent references from the config
                result, _, _ = initiate_group_chat(
                    pattern=group_config.pattern,
                    messages=message,
                    max_rounds=group_config.max_rounds,
                )

                # Return the summary from the chat result summary
                return True, {"content": result.summary}

            except Exception as e:
                # Handle any errors during execution
                return True, {"content": f"Error running group chat: {str(e)}"}

        # Register the reply function with the wrapper agent
        group_chat_agent.register_reply(
            trigger=[ConversableAgent, None],
            reply_func=group_chat_reply,
            remove_other_reply_funcs=True,  # Use only this reply function
        )

        # After the group chat completes, transition back to the parent agent
        group_chat_agent.handoffs.set_after_work(AgentTarget(parent_agent))

        return group_chat_agent
