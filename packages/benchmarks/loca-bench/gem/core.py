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

"""Core APIs."""

import abc
from typing import Any, Optional, SupportsFloat, Tuple, TypeVar

from gem.utils import seeding

ObsType = TypeVar("ObsType")
ActType = TypeVar("ActType")


class Env(abc.ABC):

    @abc.abstractmethod
    def step(
        self, action: ActType
    ) -> Tuple[ObsType, SupportsFloat, bool, bool, dict[str, Any]]:
        """Runs one time step of the environment's dynamics using the agent actions.

        When the end of an episode is reached (``terminated or truncated``), it is necessary to call :meth:`reset` to
        reset this environment's state for the next episode.

        Args:
            action (ActType): an action provided by the agent to update the environment state.

        Returns:
            observation (ObsType): A typical observation is a text string describing the current state.
            reward (SupportsFloat): The reward as a result of taking the action.
            terminated (bool): Whether the agent reaches the terminal state (as defined under the MDP of the task).
            truncated (bool): Whether the truncation condition outside the scope of the MDP is satisfied, e.g., timelimit.
            info (dict): Contains auxiliary diagnostic information (helpful for debugging, learning, and logging).
        """

    @abc.abstractmethod
    def reset(self, seed: Optional[int] = None) -> Tuple[ObsType, dict[str, Any]]:
        """Resets the environment to an initial internal state, returning an initial observation and info.

        This method generates a new starting state often with some randomness to ensure that the agent explores the
        state space and learns a generalized policy about the environment.

        Returns:
            observation (ObsType): A typical observation is a text string describing the current state.
            info (dict): Contains auxiliary diagnostic information (helpful for debugging, learning, and logging).
        """
        if seed is not None:
            seeding.set_seed(seed)

    def sample_random_action(self) -> str:
        """Samples a random action given the current state."""
        raise NotImplementedError

    @property
    def unwrapped(self) -> "Env":
        """Returns the base non-wrapped environment.

        Returns:
            Env: The base non-wrapped :class:`gem.Env` instance
        """
        return self

    def spawn(self, same_state: bool = False, **kwargs) -> "Env":
        """Spawns a new instance of the environment with the same configuration, optionally overriding parameters.

        Args:
            same_state (bool, optional): If True, the spawned environment will have the same internal state as the current environment. Defaults to False.
            **kwargs: Optional keyword arguments to override environment configuration.

        Returns:
            Env: The newly spawned :class:`gem.Env` instance
        """
        raise NotImplementedError


class EnvWrapper(Env):
    def __init__(self, env: Env):
        super().__init__()
        self.env = env

        for attr in dir(env):
            if not attr.startswith("_") and not hasattr(self, attr):
                setattr(self, attr, getattr(env, attr))

    @property
    def unwrapped(self) -> "Env":
        """Returns the base environment of the wrapper.

        Returns:
            Env: The base environment of the wrapper :class:`gem.Env` instance
        """
        return self.env.unwrapped
