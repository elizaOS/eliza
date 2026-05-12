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

from typing import Tuple

import regex as re

from gem.tools.base_tool import BaseTool
from gem.utils.sandbox import run_python


class PythonCodeTool(BaseTool):
    tool_type = "python_code"

    def __init__(
        self,
        timeout: int = 5,
        sandbox_type: str = "none",
        keep_error_last_line: bool = False,
    ):
        self.timeout = timeout
        self.sandbox_type = sandbox_type
        self.keep_error_last_line = keep_error_last_line

    def _parse_action(self, action: str) -> Tuple[str, bool]:
        """
        Extract the first complete codeblock from the raw action string (llm response) (if possible).
        Args: action: Raw action string containing Python code
        Returns:
            parsed_code: First extracted Python code block as a string (or "" if no code block found).
            parsed_action: Text up to the end of the first code block (or whole action if no code block found).
            is_valid: A boolean indicating if a valid code block was found.
        """
        # Regex patterns to search for.
        patterns = [r"<python>(.*?)</python>", r"```\n?python(.*?)```"]

        parsed_code = None
        parsed_action = action
        is_valid = False
        prev_end = len(action)
        for pattern in patterns:
            # Search for the first occurrence of the pattern
            matches = re.search(pattern, action, re.DOTALL)
            if matches:
                is_valid = True
                if matches.end() <= prev_end:
                    parsed_code = matches.group(1).strip()
                    parsed_action = action[: matches.end()]
                    prev_end = matches.end()
        return parsed_code, parsed_action, is_valid

    def instruction_string(self) -> str:
        return (
            "Solve the above problem step by step. You now have the ability to selectively write "
            "executable Python code to enhance your reasoning process. The Python code will be executed by an external sandbox, "
            'and the output (after "Code execution result: ") is returned to aid your reasoning and help you arrive at the final answer. '
            "The Python code should be complete scripts, including necessary imports, wrapped within <python>...</python> tags or using ```python...``` code block. "
            "Return your final answer within \\boxed{}."
        )

    def execute_action(self, action):
        """
        Execute the parsed action
        Args:
            trajectory_id: ID for tracking the action
            action: Raw action string
        Returns:
            Tuple containing observation, done flag, and validity flag
        """
        parsed_code, parsed_action, is_valid = self._parse_action(action)

        if not is_valid:
            # observation = "No valid Python code found. Please provide code in either <python>...</python> tags or ```python...``` code blocks."
            observation = ""
            has_error = True
        else:
            success, stdout, stderr = run_python(
                parsed_code, self.sandbox_type, timeout=self.timeout
            )
            has_error = not success
            if stderr and self.keep_error_last_line:
                stderr = stderr.split("\n")[-1]
            execution_result = f"{stdout}\n{stderr}" if stderr else stdout

            observation = execution_result.lstrip(" \n")

            observation = "Code execution result: " + observation + "\n"
            # if action.endswith("```output"):
            #     observation = "\n" + observation + "\n```\n"
            # elif action.endswith("</tool_call>"):
            #     observation = "\n```output\n" + observation + "\n```\n"
            # elif action.endswith("<output>"):
            #     observation = "\n" + observation + "\n</output>\n"
            # elif action.endswith("</python>") or "</python>" in action:
            #     observation = "\n<output>\n" + observation + "\n</output>\n"
            # elif "<|calling system for feedback|>" in action:
            #     if "```python" in action:
            #         observation = "\n```output\n" + observation + "\n```\n"
            #     elif "<python>" in action:
            #         observation = "\n<output>\n" + observation + "\n</output>\n"
            #     else:
            #         observation = "\n" + observation + "\n"
            # elif action.strip(" \n").endswith("```") or "```python" in action:
            #     if action.count("```") % 2 == 0:
            #         observation = "\n```output\n" + observation + "\n```\n"
            #     else:
            #         observation = "output\n" + observation + "\n```\n"
            # else:
            #     observation = "\n" + observation + "\n"

        return is_valid, has_error, observation, parsed_action
