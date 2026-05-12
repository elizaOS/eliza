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

"""A collection of stateful observation wrappers."""

from collections import deque
from typing import Any, Optional, SupportsFloat, Tuple, TypeVar

from gem.core import Env, EnvWrapper

WrapperObsType = TypeVar("WrapperObsType")


def maybe_add_new_line(text: str):
    if text and not text.endswith("\n"):
        return text + "\n"
    return text


class ObservationWrapper(EnvWrapper):
    def __init__(
        self,
        env: Env,
        include_action: bool = True,
        include_chat_template: bool = True,
        apply_chat_template_on_reset: bool = False,
        max_history_length: Optional[int] = None,
        tokenizer=None,
    ):
        super().__init__(env)
        self.include_action = include_action
        self.include_chat_template = include_chat_template
        self.apply_chat_template_on_reset = apply_chat_template_on_reset
        self.obs_queue = deque(
            maxlen=max_history_length + 1 if max_history_length else None
        )
        self.act_queue = deque(maxlen=max_history_length)
        self.tokenizer = tokenizer

        if include_chat_template and apply_chat_template_on_reset:
            raise ValueError(
                "include_chat_template and apply_chat_template_on_reset cannot both be True at the same time."
            )
        if include_chat_template:
            assert (
                tokenizer is not None
            ), "Tokenizer must be provided for chat template."
            assert include_action, f"Action must be included if using chat template."

        if apply_chat_template_on_reset:
            assert (
                tokenizer is not None
            ), "Tokenizer must be provided for chat template."

    def reset(self, seed: Optional[int] = None, **kwargs) -> Tuple[str, dict[str, Any]]:
        self.act_queue.clear()
        self.obs_queue.clear()
        obs, info = self.env.reset(seed=seed, **kwargs)
        if self.apply_chat_template_on_reset:
            obs = self.tokenizer.apply_chat_template(
                [{"role": "user", "content": obs}],
                tokenize=False,
                add_generation_prompt=True,
            )
        self.obs_queue.append((obs, info.get("use_tool", False)))
        return self.observation(info), info

    def step(
        self, action: str
    ) -> Tuple[str, SupportsFloat, bool, bool, dict[str, Any]]:
        next_obs, reward, terminated, truncated, info = self.env.step(action)
        self.act_queue.append(
            info["parsed_action"] if "parsed_action" in info else action
        )
        self.obs_queue.append((next_obs, info.get("use_tool", False)))
        return self.observation(info), reward, terminated, truncated, info

    def observation(self, info: dict[str, Any]):
        if self.include_action:
            assert len(self.act_queue) == len(self.obs_queue) - 1, (
                f"Action queue should be one shorter than observation queue, but got: "
                f"{len(self.obs_queue)=}, {len(self.act_queue)=}."
                f"\n{self.obs_queue=}\n{self.act_queue=}"
            )

            obs_list = list(self.obs_queue)[:-1]
            act_list = list(self.act_queue)

            if self.include_chat_template:
                chat_messages = []
                for (o, use_tool), a in zip(obs_list, act_list):
                    if use_tool:
                        chat_messages.append({"role": "tool", "content": o})
                    else:
                        chat_messages.append({"role": "user", "content": o})
                    chat_messages.append({"role": "assistant", "content": a})

                next_obs, use_tool = self.obs_queue[-1]
                if use_tool:
                    chat_messages.append({"role": "tool", "content": next_obs})
                else:
                    chat_messages.append({"role": "user", "content": next_obs})

                wrapped_obs = self.tokenizer.apply_chat_template(
                    chat_messages,
                    tokenize=False,
                    add_generation_prompt=True,
                )
            else:
                wrapped_obs = ""
                for (o, use_tool), a in zip(obs_list, act_list):
                    # We may need a unified way to format tool's output,
                    # but the formatting might have been done at the tool side.
                    wrapped_obs += maybe_add_new_line(o)
                    wrapped_obs += maybe_add_new_line(a)
                wrapped_obs += maybe_add_new_line(self.obs_queue[-1][0])
        else:
            wrapped_obs = ""
            for obs, use_tool in self.obs_queue:
                wrapped_obs += maybe_add_new_line(obs)
        if "prefix" in info:
            wrapped_obs = info["prefix"] + wrapped_obs
        if "suffix" in info:
            wrapped_obs = wrapped_obs + info["suffix"]
        return wrapped_obs
