# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

import random
from typing import TYPE_CHECKING, Any, Optional

from pydantic import BaseModel

from ..speaker_selection_result import SpeakerSelectionResult
from .transition_utils import __AGENT_WRAPPER_PREFIX__

if TYPE_CHECKING:
    # Avoid circular import
    from ...conversable_agent import ConversableAgent
    from ...groupchat import GroupChat

__all__ = [
    "AgentNameTarget",
    "AgentTarget",
    "AskUserTarget",
    "NestedChatTarget",
    "RandomAgentTarget",
    "RevertToUserTarget",
    "StayTarget",
    "TerminateTarget",
    "TransitionTarget",
]

# Common options for transitions
# terminate: Terminate the conversation
# revert_to_user: Revert to the user agent
# stay: Stay with the current agent
# group_manager: Use the group manager (auto speaker selection)
# ask_user: Use the user manager (ask the user, aka manual)
# TransitionOption = Literal["terminate", "revert_to_user", "stay", "group_manager", "ask_user"]


class TransitionTarget(BaseModel):
    """Base class for all transition targets across OnCondition, OnContextCondition, and after work."""

    def can_resolve_for_speaker_selection(self) -> bool:
        """Check if the target can resolve to an option for speaker selection (Agent, 'None' to end, Str for speaker selection method). In the case of a nested chat, this will return False as it should be encapsulated in an agent."""
        return False

    def resolve(
        self,
        groupchat: "GroupChat",
        current_agent: "ConversableAgent",
        user_agent: Optional["ConversableAgent"],
    ) -> SpeakerSelectionResult:
        """Resolve to a speaker selection result (Agent, None for termination, or str for speaker selection method)."""
        raise NotImplementedError("Requires subclasses to implement.")

    def display_name(self) -> str:
        """Get the display name for the target."""
        raise NotImplementedError("Requires subclasses to implement.")

    def normalized_name(self) -> str:
        """Get a normalized name for the target that has no spaces, used for function calling"""
        raise NotImplementedError("Requires subclasses to implement.")

    def needs_agent_wrapper(self) -> bool:
        """Check if the target needs to be wrapped in an agent."""
        raise NotImplementedError("Requires subclasses to implement.")

    def create_wrapper_agent(self, parent_agent: "ConversableAgent", index: int) -> "ConversableAgent":
        """Create a wrapper agent for the target if needed."""
        raise NotImplementedError("Requires subclasses to implement.")


class AgentTarget(TransitionTarget):
    """Target that represents a direct agent reference."""

    agent_name: str

    def __init__(self, agent: "ConversableAgent", **data: Any) -> None:  # type: ignore[no-untyped-def]
        # Store the name from the agent for serialization
        super().__init__(agent_name=agent.name, **data)

    def can_resolve_for_speaker_selection(self) -> bool:
        """Check if the target can resolve for speaker selection."""
        return True

    def resolve(
        self,
        groupchat: "GroupChat",
        current_agent: "ConversableAgent",
        user_agent: Optional["ConversableAgent"],
    ) -> SpeakerSelectionResult:
        """Resolve to the actual agent object from the groupchat."""
        return SpeakerSelectionResult(agent_name=self.agent_name)

    def display_name(self) -> str:
        """Get the display name for the target."""
        return f"{self.agent_name}"

    def normalized_name(self) -> str:
        """Get a normalized name for the target that has no spaces, used for function calling"""
        return self.display_name()

    def __str__(self) -> str:
        """String representation for AgentTarget, can be shown as a function call message."""
        return f"Transfer to {self.agent_name}"

    def needs_agent_wrapper(self) -> bool:
        """Check if the target needs to be wrapped in an agent."""
        return False

    def create_wrapper_agent(self, parent_agent: "ConversableAgent", index: int) -> "ConversableAgent":
        """Create a wrapper agent for the target if needed."""
        raise NotImplementedError("AgentTarget does not require wrapping in an agent.")


class AgentNameTarget(TransitionTarget):
    """Target that represents an agent by name."""

    agent_name: str

    def __init__(self, agent_name: str, **data: Any) -> None:
        """Initialize with agent name as a positional parameter."""
        super().__init__(agent_name=agent_name, **data)

    def can_resolve_for_speaker_selection(self) -> bool:
        """Check if the target can resolve for speaker selection."""
        return True

    def resolve(
        self,
        groupchat: "GroupChat",
        current_agent: "ConversableAgent",
        user_agent: Optional["ConversableAgent"],
    ) -> SpeakerSelectionResult:
        """Resolve to the agent name string."""
        return SpeakerSelectionResult(agent_name=self.agent_name)

    def display_name(self) -> str:
        """Get the display name for the target."""
        return f"{self.agent_name}"

    def normalized_name(self) -> str:
        """Get a normalized name for the target that has no spaces, used for function calling"""
        return self.display_name()

    def __str__(self) -> str:
        """String representation for AgentTarget, can be shown as a function call message."""
        return f"Transfer to {self.agent_name}"

    def needs_agent_wrapper(self) -> bool:
        """Check if the target needs to be wrapped in an agent."""
        return False

    def create_wrapper_agent(self, parent_agent: "ConversableAgent", index: int) -> "ConversableAgent":
        """Create a wrapper agent for the target if needed."""
        raise NotImplementedError("AgentNameTarget does not require wrapping in an agent.")


class NestedChatTarget(TransitionTarget):
    """Target that represents a nested chat configuration."""

    nested_chat_config: dict[str, Any]

    def can_resolve_for_speaker_selection(self) -> bool:
        """Check if the target can resolve for speaker selection. For NestedChatTarget the nested chat must be encapsulated into an agent."""
        return False

    def resolve(
        self,
        groupchat: "GroupChat",
        current_agent: "ConversableAgent",
        user_agent: Optional["ConversableAgent"],
    ) -> SpeakerSelectionResult:
        """Resolve to the nested chat configuration."""
        raise NotImplementedError(
            "NestedChatTarget does not support the resolve method. An agent should be used to encapsulate this nested chat and then the target changed to an AgentTarget."
        )

    def display_name(self) -> str:
        """Get the display name for the target."""
        return "a nested chat"

    def normalized_name(self) -> str:
        """Get a normalized name for the target that has no spaces, used for function calling"""
        return "nested_chat"

    def __str__(self) -> str:
        """String representation for AgentTarget, can be shown as a function call message."""
        return "Transfer to nested chat"

    def needs_agent_wrapper(self) -> bool:
        """Check if the target needs to be wrapped in an agent. NestedChatTarget must be wrapped in an agent."""
        return True

    def create_wrapper_agent(self, parent_agent: "ConversableAgent", index: int) -> "ConversableAgent":
        """Create a wrapper agent for the nested chat."""
        from ...conversable_agent import ConversableAgent  # to avoid circular import - NEED SOLUTION

        nested_chat_agent = ConversableAgent(name=f"{__AGENT_WRAPPER_PREFIX__}nested_{parent_agent.name}_{index + 1}")

        nested_chat_agent.register_nested_chats(
            self.nested_chat_config["chat_queue"],
            reply_func_from_nested_chats=self.nested_chat_config.get("reply_func_from_nested_chats")
            or "summary_from_nested_chats",
            config=self.nested_chat_config.get("config"),
            trigger=lambda sender: True,
            position=0,
            use_async=self.nested_chat_config.get("use_async", False),
        )

        # After the nested chat is complete, transfer back to the parent agent
        nested_chat_agent.handoffs.set_after_work(AgentTarget(parent_agent))

        return nested_chat_agent


class TerminateTarget(TransitionTarget):
    """Target that represents a termination of the conversation."""

    def can_resolve_for_speaker_selection(self) -> bool:
        """Check if the target can resolve for speaker selection."""
        return True

    def resolve(
        self,
        groupchat: "GroupChat",
        current_agent: "ConversableAgent",
        user_agent: Optional["ConversableAgent"],
    ) -> SpeakerSelectionResult:
        """Resolve to termination."""
        return SpeakerSelectionResult(terminate=True)

    def display_name(self) -> str:
        """Get the display name for the target."""
        return "Terminate"

    def normalized_name(self) -> str:
        """Get a normalized name for the target that has no spaces, used for function calling"""
        return "terminate"

    def __str__(self) -> str:
        """String representation for AgentTarget, can be shown as a function call message."""
        return "Terminate"

    def needs_agent_wrapper(self) -> bool:
        """Check if the target needs to be wrapped in an agent."""
        return False

    def create_wrapper_agent(self, parent_agent: "ConversableAgent", index: int) -> "ConversableAgent":
        """Create a wrapper agent for the target if needed."""
        raise NotImplementedError("TerminateTarget does not require wrapping in an agent.")


class StayTarget(TransitionTarget):
    """Target that represents staying with the current agent."""

    def can_resolve_for_speaker_selection(self) -> bool:
        """Check if the target can resolve for speaker selection."""
        return True

    def resolve(
        self,
        groupchat: "GroupChat",
        current_agent: "ConversableAgent",
        user_agent: Optional["ConversableAgent"],
    ) -> SpeakerSelectionResult:
        """Resolve to staying with the current agent."""
        return SpeakerSelectionResult(agent_name=current_agent.name)

    def display_name(self) -> str:
        """Get the display name for the target."""
        return "Stay"

    def normalized_name(self) -> str:
        """Get a normalized name for the target that has no spaces, used for function calling"""
        return "stay"

    def __str__(self) -> str:
        """String representation for AgentTarget, can be shown as a function call message."""
        return "Stay with agent"

    def needs_agent_wrapper(self) -> bool:
        """Check if the target needs to be wrapped in an agent."""
        return False

    def create_wrapper_agent(self, parent_agent: "ConversableAgent", index: int) -> "ConversableAgent":
        """Create a wrapper agent for the target if needed."""
        raise NotImplementedError("StayTarget does not require wrapping in an agent.")


class RevertToUserTarget(TransitionTarget):
    """Target that represents reverting to the user agent."""

    def can_resolve_for_speaker_selection(self) -> bool:
        """Check if the target can resolve for speaker selection."""
        return True

    def resolve(
        self,
        groupchat: "GroupChat",
        current_agent: "ConversableAgent",
        user_agent: Optional["ConversableAgent"],
    ) -> SpeakerSelectionResult:
        """Resolve to reverting to the user agent."""
        if user_agent is None:
            raise ValueError("User agent must be provided to the chat for the revert_to_user option.")
        return SpeakerSelectionResult(agent_name=user_agent.name)

    def display_name(self) -> str:
        """Get the display name for the target."""
        return "Revert to User"

    def normalized_name(self) -> str:
        """Get a normalized name for the target that has no spaces, used for function calling"""
        return "revert_to_user"

    def __str__(self) -> str:
        """String representation for AgentTarget, can be shown as a function call message."""
        return "Revert to User"

    def needs_agent_wrapper(self) -> bool:
        """Check if the target needs to be wrapped in an agent."""
        return False

    def create_wrapper_agent(self, parent_agent: "ConversableAgent", index: int) -> "ConversableAgent":
        """Create a wrapper agent for the target if needed."""
        raise NotImplementedError("RevertToUserTarget does not require wrapping in an agent.")


class AskUserTarget(TransitionTarget):
    """Target that represents asking the user for input."""

    def can_resolve_for_speaker_selection(self) -> bool:
        """Check if the target can resolve for speaker selection."""
        return True

    def resolve(
        self,
        groupchat: "GroupChat",
        current_agent: "ConversableAgent",
        user_agent: Optional["ConversableAgent"],
    ) -> SpeakerSelectionResult:
        """Resolve to asking the user for input."""
        return SpeakerSelectionResult(speaker_selection_method="manual")

    def display_name(self) -> str:
        """Get the display name for the target."""
        return "Ask User"

    def normalized_name(self) -> str:
        """Get a normalized name for the target that has no spaces, used for function calling"""
        return "ask_user"

    def __str__(self) -> str:
        """String representation for AgentTarget, can be shown as a function call message."""
        return "Ask User"

    def needs_agent_wrapper(self) -> bool:
        """Check if the target needs to be wrapped in an agent."""
        return False

    def create_wrapper_agent(self, parent_agent: "ConversableAgent", index: int) -> "ConversableAgent":
        """Create a wrapper agent for the target if needed."""
        raise NotImplementedError("AskUserTarget does not require wrapping in an agent.")


class RandomAgentTarget(TransitionTarget):
    """Target that represents a random selection from a list of agents."""

    agent_names: list[str]
    nominated_name: str = "<Not Randomly Selected Yet>"

    def __init__(self, agents: list["ConversableAgent"], **data: Any) -> None:  # type: ignore[no-untyped-def]
        # Store the name from the agent for serialization
        super().__init__(agent_names=[agent.name for agent in agents], **data)

    def can_resolve_for_speaker_selection(self) -> bool:
        """Check if the target can resolve for speaker selection."""
        return True

    def resolve(
        self,
        groupchat: "GroupChat",
        current_agent: "ConversableAgent",
        user_agent: Optional["ConversableAgent"],
    ) -> SpeakerSelectionResult:
        """Resolve to the actual agent object from the groupchat, choosing a random agent (except the current one)"""
        # Randomly select the next agent
        self.nominated_name = random.choice([name for name in self.agent_names if name != current_agent.name])

        return SpeakerSelectionResult(agent_name=self.nominated_name)

    def display_name(self) -> str:
        """Get the display name for the target."""
        return self.nominated_name

    def normalized_name(self) -> str:
        """Get a normalized name for the target that has no spaces, used for function calling"""
        return self.display_name()

    def __str__(self) -> str:
        """String representation for RandomAgentTarget, can be shown as a function call message."""
        return f"Transfer to {self.nominated_name}"

    def needs_agent_wrapper(self) -> bool:
        """Check if the target needs to be wrapped in an agent."""
        return False

    def create_wrapper_agent(self, parent_agent: "ConversableAgent", index: int) -> "ConversableAgent":
        """Create a wrapper agent for the target if needed."""
        raise NotImplementedError("RandomAgentTarget does not require wrapping in an agent.")


# TODO: Consider adding a SequentialChatTarget class
