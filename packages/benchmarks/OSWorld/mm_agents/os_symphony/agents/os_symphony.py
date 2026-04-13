import logging
import platform
from typing import Dict, List, Tuple
from mm_agents.os_symphony.agents.os_aci import OSACI
from mm_agents.os_symphony.agents.searcher_agent import VLMSearcherAgent
from mm_agents.os_symphony.agents.worker import Worker

logger = logging.getLogger("desktopenv.agent")

class OSSymphony:
    def __init__(
        self,
        engine_params_for_orchestrator: Dict,
        engine_params_for_memoryer: Dict,
        os_aci: OSACI,
        platform: str = platform.system().lower(),
        client_password: str = "",
        max_trajectory_length: int = 8,
        enable_reflection: bool = True,
    ):
        """
        Args:
            worker_engine_params: Configuration parameters for the worker agent.
            grounding_agent: Instance of ACI class for UI interaction
            platform: Operating system platform (darwin, linux, windows)
            max_trajectory_length: Maximum number of image turns to keep
            enable_reflection: Creates a reflection agent to assist the worker agent
        """

        self.engine_params_for_orchestrator = engine_params_for_orchestrator
        self.engine_params_for_memoryer = engine_params_for_memoryer
        self.os_aci: OSACI = os_aci
        self.platform =platform
        self.client_password = client_password
        self.max_trajectory_length = max_trajectory_length
        self.enable_reflection = enable_reflection

    def reset(self, result_dir) -> None:
        """Reset agent state and initialize components"""
        # Reset the search time per task
        self.os_aci.result_dir = result_dir
        self.executor = Worker(
            engine_params_for_orchestrator=self.engine_params_for_orchestrator,
            engine_params_for_memoryer=self.engine_params_for_memoryer,
            os_aci=self.os_aci,
            platform=self.platform,
            client_password=self.client_password,
            max_trajectory_length=self.max_trajectory_length,
            enable_reflection=self.enable_reflection,
        )

    def predict(self, instruction: str, observation: Dict, is_last_step: bool) -> Tuple[Dict, List[str]]:
        # Initialize the three info dictionaries
        executor_info, actions = self.executor.generate_next_action(
            instruction=instruction, obs=observation, is_last_step=is_last_step
        )

        # concatenate the three info dictionaries
        info = {**{k: v for d in [executor_info or {}] for k, v in d.items()}}

        return info, actions
