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

"""MCPMark environments. (https://github.com/eval-sys/mcpmark)"""

import random
from typing import Any, Optional, SupportsFloat, Tuple

from mcpmark import factory

from gem.core import Env
from gem.utils.constants import TERMINAL_STATE


class MCPMarkEnv(Env):
    def __init__(self, mcp_service: str, tasks: str = "all", seed: int = 42, **_: Any):
        """
        Args:
            mcp_service: The MCP service to use.
            tasks: Tasks to run: (1). "all"; (2). "category"; or (3). "category/task".
        """
        super().__init__()
        self.task_manager = factory.MCPServiceFactory.create_task_manager(mcp_service)
        self.state_manager = factory.MCPServiceFactory.create_state_manager(mcp_service)
        self.task_list = self.task_manager.filter_tasks(tasks)
        self.task_size = len(self.task_list)
        self.current_task = None
        self.task_iter = None
        self.seed = seed

    def step(
        self, action: str
    ) -> Tuple[str, SupportsFloat, bool, bool, dict[str, Any]]:
        pseudo_agent_result = {"success": True}
        result = self.task_manager.execute_task(self.current_task, pseudo_agent_result)
        if result.success:
            reward = 1.0
        else:
            reward = 0.0

        self._cleanup()
        return TERMINAL_STATE, reward, True, True, {"correct": bool(result.success)}

    def reset(self, seed: Optional[int] = None) -> Tuple[str, dict[str, Any]]:
        super().reset(seed)
        if seed is not None:
            self.current_task = random.choice(self.task_list)
        else:
            if self.task_iter is None:
                self.task_iter = iter(self.task_list)
            try:
                self.current_task = next(self.task_iter)
            except StopIteration:
                self.task_iter = iter(self.task_list)
                self.current_task = next(self.task_iter)

        setup_success = self.state_manager.set_up(self.current_task)
        if not setup_success:
            raise RuntimeError(f"Failed to set up task {self.current_task}")

        task_instruction = self.task_manager.get_task_instruction(self.current_task)
        return task_instruction, {"task_name": self.current_task.name}

    def _cleanup(self):
        self.state_manager.clean_up(self.current_task)
