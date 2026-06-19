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

import re
from typing import Optional


def last_boxed_only_string(string: str) -> Optional[str]:
    idx = string.rfind("\\boxed")
    if idx < 0:
        idx = string.rfind("\\fbox")
        if idx < 0:
            return None

    i = idx
    right_brace_idx = None
    num_left_braces_open = 0
    while i < len(string):
        if string[i] == "{":
            num_left_braces_open += 1
        if string[i] == "}":
            num_left_braces_open -= 1
            if num_left_braces_open == 0:
                right_brace_idx = i
                break
        i += 1

    if right_brace_idx == None:
        retval = None
    else:
        retval = string[idx : right_brace_idx + 1]

    return retval


def remove_boxed(s: Optional[str]):
    left = "\\boxed{"
    if isinstance(s, str):
        try:
            assert s[: len(left)] == left
            assert s[-1] == "}"
            return s[len(left) : -1]
        except:
            return None


def extract_last_boxed_answer(solution: str) -> Optional[str]:
    """Extract the answer from inside a LaTeX \\boxed{} command"""
    extracted_solution = last_boxed_only_string(solution)
    return remove_boxed(extracted_solution)


def extract_code_from_model(model_response: str):
    """
    Extracts the code from a Markdown-style code block in an LLM output.

    Parameters:
        model_response (str): The text output from the LLM.

    Returns:
        str: The extracted code, or an empty string if no code block is found.
    """
    code_blocks = re.findall(r"```(?:\w+)?\n(.*?)```", model_response, re.DOTALL)
    if not code_blocks:
        return None
    return code_blocks[-1].strip()


def extract_last_tagged_answer(model_response: str):
    """
    Extracts the last answer enclosed in <answer>...</answer> tags from the model response.

    Parameters:
        model_response (str): The text output from the LLM.

    Returns:
        str or None: The extracted answer, or None if not found.
    """

    answer_pattern = r"<answer>(.*?)</answer>"
    match = re.finditer(answer_pattern, model_response, re.DOTALL)
    matches = list(match)

    if len(matches) == 0:
        return None

    return matches[-1].group(1).strip()
