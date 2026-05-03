# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0

from typing import TYPE_CHECKING, Optional, Union

from pydantic import BaseModel

from ..agent import Agent

if TYPE_CHECKING:
    # Avoid circular import
    from ..groupchat import GroupChat


class SpeakerSelectionResult(BaseModel):
    """Represents a speaker selection result that will be returned to GroupChat._prepare_and_select_agents to determine the next speaker.

    This class can return an Agent, a None to end the conversation, or a string for a speaker selection method.
    """

    terminate: Optional[bool] = None
    agent_name: Optional[str] = None
    speaker_selection_method: Optional[str] = None

    def get_speaker_selection_result(self, groupchat: "GroupChat") -> Optional[Union[Agent, str]]:
        """Get the speaker selection result. If None, the conversation will end."""
        if self.agent_name is not None:
            # Find the agent by name in the groupchat
            for agent in groupchat.agents:
                if agent.name == self.agent_name:
                    return agent
            raise ValueError(f"Agent '{self.agent_name}' not found in groupchat.")
        elif self.speaker_selection_method is not None:
            return self.speaker_selection_method
        elif self.terminate is not None and self.terminate:
            return None
        else:
            raise ValueError(
                "Unable to establish speaker selection result. No terminate, agent, or speaker selection method provided."
            )
