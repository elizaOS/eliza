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


class BaseTool:
    tool_type = "base"

    def __init__(self, num_workers=1):
        self.num_workers = num_workers

    def instruction_string(self) -> str:
        """
        Return the instruction string for the tool.
        This string is used to guide the agent on how to use the tool.
        Returns: Instruction string
        """
        raise NotImplementedError("Subclass must implement this method")

    def execute_action(self, action):
        """
        Execute the action on the environment and return the observation.
        Args: action: The action to execute
        Returns:
            observation: The observation after executing the action
            done: Whether the trajectory is done
            valid: Whether the action is valid
            info: Additional information about the action execution
        """
        raise NotImplementedError("Subclass must implement this method")
