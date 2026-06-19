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

"""Asynchronous (thread pool) vectorized environment execution."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from typing import Any, Dict, Sequence, Tuple, Union

import numpy as np

from gem.core import ActType, ObsType
from gem.vector.vector_env import ArrayType, AutoresetMode, VectorEnv


def step_reset_env(action, env, autoreset_mode, autoreset_env):
    if autoreset_mode == AutoresetMode.NEXT_STEP:
        if autoreset_env:
            obs, info = env.reset()
            reward, terminated, truncated = 0.0, False, False
        else:
            obs, reward, terminated, truncated, info = env.step(action)
    elif autoreset_mode == AutoresetMode.SAME_STEP:
        obs, reward, terminated, truncated, info = env.step(action)
        if terminated or truncated:
            obs, info = env.reset()
    else:
        raise ValueError
    return obs, reward, terminated, truncated, info


class AsyncVectorEnv(VectorEnv):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.thread_pool_executer = ThreadPoolExecutor(max_workers=self.num_envs)

    def step(self, actions: Union[Sequence[ActType], Dict[int, ActType]]) -> Tuple[
        Sequence[ObsType],
        ArrayType,
        ArrayType,
        ArrayType,
        Dict[str, Any],
    ]:
        if isinstance(actions, Sequence):
            assert len(actions) == self.num_envs
            actions = {i: action for i, action in enumerate(actions)}

        active_env_indices = list(actions.keys())
        if isinstance(actions, Sequence):
            assert len(actions) == self.num_envs
            actions = {i: action for i, action in enumerate(actions)}

        active_env_indices = list(actions.keys())
        results = list(
            self.thread_pool_executer.map(
                lambda args: step_reset_env(*args),
                list(
                    zip(
                        actions.values(),
                        [self.envs[i] for i in actions.keys()],
                        [self.autoreset_mode] * len(actions),
                        [self._autoreset_envs[i] for i in actions.keys()],
                    )
                ),
            )
        )
        for i, (obs, reward, terminated, truncated, info) in zip(
            actions.keys(), results
        ):
            self._env_obs[i] = obs
            self._rewards[i] = reward
            self._terminations[i] = terminated
            self._truncations[i] = truncated
            self._env_infos[i] = info
        self._autoreset_envs = np.logical_or(self._terminations, self._truncations)

        return (
            [deepcopy(self._env_obs[i]) for i in actions.keys()],
            np.copy(self._rewards)[active_env_indices],
            np.copy(self._terminations)[active_env_indices],
            np.copy(self._truncations)[active_env_indices],
            [deepcopy(self._env_infos[i]) for i in actions.keys()],
        )
