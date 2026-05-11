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

from functools import partial

from gem.tools.python_code_tool import PythonCodeTool
from gem.tools.search_tool import SearchTool
from gem.tools.tool_env_wrapper import ToolEnvWrapper
from gem.wrappers.episode_tracking_wrapper import EpisodeTrackingWrapper
from gem.wrappers.observation_wrapper import ObservationWrapper

# TODO refactor later

### Note: Order is important!
WRAPPER_FACTORY = {
    ### 1. First, optionlly add the tool wrapper
    "python_tool": partial(
        ToolEnvWrapper,
        tools=[PythonCodeTool(timeout=5)],
        tool_reward=0.05,
        tool_success_reward=0.25,
        max_tool_uses=5,
    ),
    "python_tool_no_int_reward": partial(
        ToolEnvWrapper,
        tools=[PythonCodeTool(timeout=5)],
        tool_reward=0.0,
        tool_success_reward=0.0,
        max_tool_uses=5,
    ),
    "python_tool_no_int_reward_last_line_error": partial(
        ToolEnvWrapper,
        tools=[PythonCodeTool(timeout=5, keep_error_last_line=True)],
        tool_reward=0.0,
        tool_success_reward=0.0,
        max_tool_uses=5,
    ),
    "search_tool": partial(
        ToolEnvWrapper,
        tools=[SearchTool(topk=3, timeout=5)],
        tool_reward=0.3,
        tool_success_reward=0.0,
        max_tool_uses=5,
    ),
    "search_tool_no_int_reward": partial(
        ToolEnvWrapper,
        tools=[SearchTool(topk=3, timeout=5)],
        tool_reward=0.0,
        tool_success_reward=0.0,
        max_tool_uses=5,
    ),
    ### 2. Then choose an observation wrapper
    "concat": partial(
        ObservationWrapper,
        include_action=False,
        include_chat_template=False,
    ),
    "concat_chat": partial(
        ObservationWrapper,
        include_action=True,
        include_chat_template=True,
        # Requires tokenizer to be passed later
    ),
    "concat_with_action": partial(
        ObservationWrapper,
        include_action=True,
        include_chat_template=False,
    ),
    "concat_chat_on_reset": partial(
        ObservationWrapper,
        include_action=True,
        include_chat_template=False,
        apply_chat_template_on_reset=True,
    ),
    ### 3. Finally, optionally add the episode tracking wrapper
    "episode_tracking": EpisodeTrackingWrapper,
}

TOKENIZER_REQUIRED = ["concat_chat", "concat_chat_on_reset"]


def get_wrapper_fns(wrappers: str, tokenizer=None):
    """Get a list of wrapper functions based on the provided wrapper names."""
    wrapper_fns = []
    print(f"Wrappers requested: {wrappers}")
    if wrappers:
        wrappers = wrappers.split(",")
        for w in wrappers:
            wrapper_fn = WRAPPER_FACTORY[w]
            if w in TOKENIZER_REQUIRED and tokenizer is not None:
                wrapper_fn = partial(wrapper_fn, tokenizer=tokenizer)
            wrapper_fns.append(wrapper_fn)
        print(f"Wrappers: {wrapper_fns}")
    return wrapper_fns
