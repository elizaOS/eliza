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

"""Synchronous (for loop) vectorized environment execution."""

from copy import deepcopy
from typing import Any, Dict, Sequence, Tuple, Union

import numpy as np

from gem.core import ActType, ObsType
from gem.vector.vector_env import ArrayType, AutoresetMode, VectorEnv


class SyncVectorEnv(VectorEnv):
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
        for i, action in actions.items():
            if self.autoreset_mode == AutoresetMode.NEXT_STEP:
                if self._autoreset_envs[i]:
                    self._env_obs[i], self._env_infos[i] = self.envs[i].reset()
                    self._rewards[i] = 0.0
                    self._terminations[i] = False
                    self._truncations[i] = False
                else:
                    (
                        self._env_obs[i],
                        self._rewards[i],
                        self._terminations[i],
                        self._truncations[i],
                        self._env_infos[i],
                    ) = self.envs[i].step(action)
            elif self.autoreset_mode == AutoresetMode.SAME_STEP:
                (
                    self._env_obs[i],
                    self._rewards[i],
                    self._terminations[i],
                    self._truncations[i],
                    self._env_infos[i],
                ) = self.envs[i].step(action)

                if self._terminations[i] or self._truncations[i]:
                    self._env_obs[i], self._env_infos[i] = self.envs[i].reset()
            else:
                raise ValueError

        self._autoreset_envs = np.logical_or(self._terminations, self._truncations)

        return (
            [deepcopy(self._env_obs[i]) for i in actions.keys()],
            np.copy(self._rewards)[active_env_indices],
            np.copy(self._terminations)[active_env_indices],
            np.copy(self._truncations)[active_env_indices],
            [deepcopy(self._env_infos[i]) for i in actions.keys()],
        )
