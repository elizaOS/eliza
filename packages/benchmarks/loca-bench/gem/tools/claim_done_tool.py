# Copyright 2025 AxonRL Team. All Rights Reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Claim Done Tool - Signal task completion.

This tool allows the agent to explicitly signal that it has completed
the assigned task.
"""

import re
from typing import Tuple

import regex

from gem.tools.base_tool import BaseTool


class ClaimDoneTool(BaseTool):
    """Tool for claiming task completion.
    
    This tool provides a simple way for agents to signal that they have
    finished their assigned task. When invoked, it returns a confirmation
    message.
    """
    
    tool_type = "claim_done"

    def __init__(self, num_workers: int = 1):
        """Initialize the Claim Done Tool.
        
        Args:
            num_workers: Number of worker processes (not used for this tool)
        """
        super().__init__(num_workers)

    def _parse_action(self, action: str) -> Tuple[bool, str]:
        """Parse action to check for claim_done tag.
        
        Args:
            action: Raw action string
        
        Returns:
            tuple: (is_valid, parsed_action)
        """
        # Pattern for claim_done operation
        pattern = r"<claim_done\s*/>"
        match = regex.search(pattern, action, regex.IGNORECASE)
        
        if match:
            return True, match.group(0)
        
        # Also support with closing tag
        pattern_with_close = r"<claim_done>.*?</claim_done>"
        match_with_close = regex.search(pattern_with_close, action, regex.IGNORECASE | regex.DOTALL)
        
        if match_with_close:
            return True, match_with_close.group(0)
        
        return False, ""

    def instruction_string(self) -> str:
        """Return instruction string for using the claim done tool."""
        return (
            "When you have completed your assigned task, you can signal completion using:\n\n"
            "<claim_done />\n\n"
            "This will confirm that you believe the task is finished. "
            "Use this only when you are confident that all requirements have been met."
        )

    def execute_action(self, action: str, workspace_path: str = ".") -> Tuple[bool, bool, str, str]:
        """Execute the claim done action.
        
        Args:
            action: Raw action string
            workspace_path: Path to workspace (not used for this tool)
        
        Returns:
            tuple: (is_valid, has_error, observation, parsed_action)
        """
        is_valid, parsed_action = self._parse_action(action)
        
        if not is_valid:
            return False, True, "", ""
        
        # Generate confirmation message
        observation = (
            "\n"
            "✅ Task Completion Claimed\n"
            "=" * 60 + "\n"
            "You have claimed that the task is done!\n"
            "The system will now evaluate your work.\n"
            "=" * 60 + "\n"
        )
        
        return True, False, observation, parsed_action

