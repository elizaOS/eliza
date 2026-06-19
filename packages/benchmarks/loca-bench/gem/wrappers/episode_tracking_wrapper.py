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

"""An environment wrapper for tracking episode statistics,
e.g. step count and cumulative rewards.
Note: Must be used as the outermost wrapper.
"""

from typing import Any, Optional, SupportsFloat, Tuple

from gem.core import ActType, Env, EnvWrapper
from gem.wrappers.observation_wrapper import WrapperObsType


class EpisodeTrackingWrapper(EnvWrapper):
    def __init__(self, env: Env):
        super().__init__(env)
        self.step_counter = 0
        self.cumulative_rewards = 0.0

    def step(
        self, action: ActType
    ) -> Tuple[WrapperObsType, SupportsFloat, bool, bool, dict[str, Any]]:
        obs, reward, terminated, truncated, info = self.env.step(action)
        self.step_counter += 1
        self.cumulative_rewards += reward
        info["step_counter"] = self.step_counter
        info["cumulative_rewards"] = self.cumulative_rewards
        return obs, reward, terminated, truncated, info

    def reset(
        self, seed: Optional[int] = None
    ) -> Tuple[WrapperObsType, dict[str, Any]]:
        prev_ep_step_counter = self.step_counter
        prev_ep_step_cumulative_rewards = self.cumulative_rewards
        obs, info = self.env.reset(seed)
        self.step_counter = 0
        self.cumulative_rewards = 0.0
        info["step_counter"] = self.step_counter
        info["prev_ep_step_counter"] = prev_ep_step_counter
        info["cumulative_rewards"] = self.cumulative_rewards
        info["prev_ep_cumulative_rewards"] = prev_ep_step_cumulative_rewards
        return obs, info
