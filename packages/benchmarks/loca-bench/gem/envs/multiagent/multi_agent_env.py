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

import abc
from typing import Any, Dict, List, Optional, Tuple

from gem.core import Env


class MultiAgentEnv(Env):

    def __init__(self):
        super().__init__()

        self.possible_agents: List[str] = []
        self.agents: List[str] = []

        self.terminations: Dict[str, bool] = {}
        self.truncations: Dict[str, bool] = {}
        self.rewards: Dict[str, float] = {}
        self.infos: Dict[str, dict] = {}
        self._cumulative_rewards: Dict[str, float] = {}

        self.agent_selector: Optional["AgentSelector"] = None

        self.shared_memory = []
        self.global_context = ""

    def step(self, actions: Dict[str, str]) -> Tuple[
        Dict[str, str],
        Dict[str, float],
        Dict[str, bool],
        Dict[str, bool],
        Dict[str, dict],
    ]:
        if not isinstance(actions, dict):
            raise ValueError(f"Actions must be a dict, got {type(actions)}")

        active_agents = (
            self.agent_selector.get_active_agents()
            if self.agent_selector
            else self.agents
        )

        self._validate_actions(actions, active_agents)

        observations, rewards, terminations, truncations, infos = self._process_actions(
            actions
        )

        for agent in self.agents:
            if agent in rewards:
                self._cumulative_rewards[agent] = (
                    self._cumulative_rewards.get(agent, 0.0) + rewards[agent]
                )

        self._remove_dead_agents()

        if self.agent_selector:
            self.agent_selector.next()

        return observations, rewards, terminations, truncations, infos

    def _validate_actions(self, actions: Dict[str, str], active_agents: List[str]):
        for agent in active_agents:
            if agent not in self.terminations or self.terminations[agent]:
                continue
            if agent not in self.truncations or self.truncations[agent]:
                continue
            if agent not in actions:
                raise ValueError(f"Missing action for active agent {agent}")

        for agent in actions:
            if agent not in active_agents:
                raise ValueError(f"Agent {agent} provided action but is not active")

    @abc.abstractmethod
    def _process_actions(self, actions: Dict[str, str]) -> Tuple[
        Dict[str, str],
        Dict[str, float],
        Dict[str, bool],
        Dict[str, bool],
        Dict[str, dict],
    ]:
        raise NotImplementedError

    def reset(
        self, seed: Optional[int] = None
    ) -> Tuple[Dict[str, str], Dict[str, Any]]:
        if seed is not None:
            self._np_random = self._make_np_random(seed)

        self.agents = self.possible_agents.copy()

        self.terminations = {agent: False for agent in self.agents}
        self.truncations = {agent: False for agent in self.agents}
        self.rewards = {agent: 0.0 for agent in self.agents}
        self.infos = {agent: {} for agent in self.agents}
        self._cumulative_rewards = {agent: 0.0 for agent in self.agents}

        self.shared_memory = []
        self.global_context = ""

        if self.agent_selector:
            self.agent_selector.reinit(self.agents)

        observations = {agent: self.observe(agent) for agent in self.agents}
        infos = {agent: {} for agent in self.agents}

        return observations, infos

    @abc.abstractmethod
    def observe(self, agent: str) -> str:
        raise NotImplementedError

    def get_state(self, agent: str) -> Tuple[str, float, bool, bool, dict]:
        if agent not in self.agents:
            raise ValueError(f"Agent {agent} not in environment")

        return (
            self.observe(agent),
            self._cumulative_rewards.get(agent, 0.0),
            self.terminations.get(agent, False),
            self.truncations.get(agent, False),
            self.infos.get(agent, {}),
        )

    def get_active_states(self) -> Dict[str, Tuple[str, float, bool, bool, dict]]:
        active_agents = (
            self.agent_selector.get_active_agents()
            if self.agent_selector
            else self.agents
        )

        return {
            agent: self.get_state(agent)
            for agent in active_agents
            if agent in self.agents
        }

    def add_agent(self, agent_id: str):
        if agent_id in self.agents:
            return

        self.agents.append(agent_id)
        self.terminations[agent_id] = False
        self.truncations[agent_id] = False
        self.rewards[agent_id] = 0.0
        self.infos[agent_id] = {}
        self._cumulative_rewards[agent_id] = 0.0

        if self.agent_selector:
            self.agent_selector.add_agent(agent_id)

    def remove_agent(self, agent_id: str):
        if agent_id not in self.agents:
            return

        self.agents.remove(agent_id)
        del self.terminations[agent_id]
        del self.truncations[agent_id]
        del self.rewards[agent_id]
        del self.infos[agent_id]
        del self._cumulative_rewards[agent_id]

        if self.agent_selector:
            self.agent_selector.remove_agent(agent_id)

    def _remove_dead_agents(self):
        dead_agents = [
            agent
            for agent in self.agents
            if self.terminations.get(agent, False) or self.truncations.get(agent, False)
        ]
        for agent in dead_agents:
            self.remove_agent(agent)

    def send_message(self, from_agent: str, to_agent: str, message: str):
        if from_agent not in self.agents:
            raise ValueError(f"Sender {from_agent} not in environment")
        if to_agent not in self.agents:
            raise ValueError(f"Receiver {to_agent} not in environment")

        self.shared_memory.append(
            {"from": from_agent, "to": to_agent, "message": message}
        )

    def broadcast_message(self, from_agent: str, message: str):
        if from_agent not in self.agents:
            raise ValueError(f"Sender {from_agent} not in environment")

        for agent in self.agents:
            if agent != from_agent:
                self.shared_memory.append(
                    {"from": from_agent, "to": agent, "message": message}
                )


class AgentSelector:

    def __init__(self, agents: List[str], mode: str = "sequential"):
        self.mode = mode
        self._agents = agents.copy()
        self._current_idx = 0
        self.selected = self._agents[0] if self._agents else None

    def get_active_agents(self) -> List[str]:
        if self.mode == "sequential":
            return [self.selected] if self.selected else []
        elif self.mode == "parallel":
            return self._agents.copy()
        else:
            raise ValueError(f"Unknown mode: {self.mode}")

    def next(self):
        if self.mode == "sequential" and self._agents:
            self._current_idx = (self._current_idx + 1) % len(self._agents)
            self.selected = self._agents[self._current_idx]

    def is_first(self) -> bool:
        return self._current_idx == 0

    def is_last(self) -> bool:
        return self._current_idx == len(self._agents) - 1

    def reinit(self, agents: List[str]):
        self._agents = agents.copy()
        self._current_idx = 0
        self.selected = self._agents[0] if self._agents else None

    def add_agent(self, agent: str):
        if agent not in self._agents:
            self._agents.append(agent)

    def remove_agent(self, agent: str):
        if agent in self._agents:
            idx = self._agents.index(agent)
            self._agents.remove(agent)

            if self._agents:
                if idx <= self._current_idx:
                    self._current_idx = max(0, self._current_idx - 1)
                self._current_idx = self._current_idx % len(self._agents)
                self.selected = self._agents[self._current_idx]
            else:
                self._current_idx = 0
                self.selected = None
