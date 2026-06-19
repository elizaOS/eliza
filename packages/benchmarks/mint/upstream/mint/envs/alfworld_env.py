from mint.envs.general_env import GeneralEnv
from mint.datatypes import StepOutput, Action
from mint.tools import Tool
from mint.tools.alfworld import ALFWORLD_TOOL_CLS
from mint.tasks.alfworld import AlfWorldTask
from typing import Any, Dict, List, Mapping


class AlfworldEnv(GeneralEnv):
    def __init__(
        self,
        task: AlfWorldTask,
        tool_set: List[Tool],
        feedback_config: Dict[str, Any],
        environment_config: Dict[str, Any],
    ):
        self.env = task.env
        self.action_results: List[StepOutput] = []
        self.tool_set = [
            tool_cls(self.env, callback_fn=self.action_results.append)
            for tool_cls in ALFWORLD_TOOL_CLS
        ]  # will be merged with the tool_set in GeneralEnv
        super().__init__(task, tool_set, feedback_config, environment_config)

    def check_task_success(self, *args, **kwargs) -> bool:
        """Check if the task is successful.

        In AlfWorld, we can check the last tool call result to see if the task is successful.
        """
        if len(self.action_results) == 0:
            # If no interaction with AlfWorld, then the task cannot be successful.
            return False
        for result in reversed(self.action_results):
            if result.success:
                return True
        return False

    def handle_tool_call(self, action: Action):
        obs = super().handle_tool_call(action)
        # since in alfworld, making the correct tool call is enough to finish the task
        # so we need to check success and update the state here
        self.state.success = self.check_task_success()
        if self.state.success:
            self.state.finished = True
            self.state.terminate_reason = "task_success"
        return obs
