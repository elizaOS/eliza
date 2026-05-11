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

import asyncio
import logging
import random
import re
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, SupportsFloat, Tuple

import yaml
from terminal_bench.handlers.trial_handler import TrialHandler
from terminal_bench.terminal.terminal import Terminal

from gem.core import Env
from gem.envs.terminal.executor import DockerExecutor
from gem.envs.terminal.reward import calculate_test_score
from gem.utils.constants import TERMINAL_STATE


@dataclass
class TaskConfig:
    """Configuration for a specific terminal bench task."""

    task_name: str
    task_path: str
    test_weights: Dict[str, float]
    max_test_timeout_sec: float = 300.0
    max_retry: int = 5


@dataclass
class ContainerConfig:
    """Configuration for Docker container runtime settings."""

    no_rebuild: bool = False
    timeout: int = 600  # seconds


class DockerEnv(Env):
    """Docker environment that runs inside containers for terminal interaction tasks."""

    action_space = ["bash", "finish"]

    def __init__(
        self,
        task_configs: List[TaskConfig],
        container_config: ContainerConfig,
    ):
        super().__init__()
        self.trial_handler = None
        self.terminal = None
        self.session = None
        self.task_configs = task_configs
        self.container_config = container_config

    def reset(self, seed: Optional[None] = None) -> Tuple[str, dict[str, Any]]:
        super().reset(seed)
        self.env_name = str(uuid.uuid4())
        self.current_task_config = random.choice(self.task_configs)
        self.trial_handler = TrialHandler(
            trial_name=f"gem_{self.env_name}_{self.current_task_config.task_name}",
            input_path=Path(self.current_task_config.task_path),
            output_path=Path(f"/tmp/gem_docker_output/{self.env_name}/"),
        )
        self.terminal = Terminal(
            client_container_name=self.trial_handler.client_container_name,
            client_image_name=self.trial_handler.client_image_name,
            docker_compose_path=self.trial_handler.task_paths.docker_compose_path,
            docker_image_name_prefix=f"gem_{self.env_name}_{self.current_task_config.task_name}",
            commands_path=self.trial_handler.trial_paths.commands_path,
            sessions_logs_path=self.trial_handler.trial_paths.sessions_path,
            agent_logs_path=self.trial_handler.trial_paths.agent_logging_dir,
            no_rebuild=self.container_config.no_rebuild,
            cleanup=False,  # We'll handle cleanup ourselves
        )

        try:
            self.terminal.start()
            logging.debug(
                f"[{self.env_name[:8]}] Container started: {self.trial_handler.client_container_name}"
            )
        except Exception as e:
            logging.error(f"[{self.env_name[:8]}] Container start failed: {e}")
            raise

        # Get or create session
        try:
            self.session = self.terminal.get_session("agent")
        except ValueError:
            self.session = self.terminal.create_session("agent")

        self.executor = DockerExecutor(self.terminal.container.name)

        self._capture_pre_agent_pane()

        self.done = False
        self.bash_error_count = 0

        return self.trial_handler.instruction, {}

    def step(
        self, action: str
    ) -> Tuple[str, SupportsFloat, bool, bool, dict[str, Any]]:
        if self.done:
            logging.warning(f"[{self.env_name[:8]}] Step on completed env")
            return TERMINAL_STATE, 0.0, True, True, {"error": "Environment is done"}

        # 1) Parse the action.
        xml_pattern = r"<(\w+)>([\s\S]*?)</\1>"
        matches = re.findall(xml_pattern, action)
        info = {}
        if not matches:
            # Invalid action, end the episode without command execution.
            reward = 0.0
            self.done = True
            observation = TERMINAL_STATE
        else:
            tag_name, content = matches[0]
            if tag_name not in self.action_space:
                reward = 0.0
                self.done = True
                observation = TERMINAL_STATE
            else:
                first_match = re.search(
                    f"<{tag_name}>(.*?)</{tag_name}>", action, re.DOTALL
                )
                parsed_action = action[: first_match.end()]
                try:
                    yaml_data = yaml.safe_load(content.strip())
                    if tag_name == "finish":
                        self.done = True
                        observation = TERMINAL_STATE
                        info["parsed_action"] = parsed_action
                        info["tool_type"] = "terminal-finish"
                    elif tag_name == "bash":
                        info["parsed_action"] = parsed_action
                        info["tool_type"] = "terminal-bash"
                        cmd = yaml_data.get("cmd", "")
                        output, exit_code = asyncio.run(
                            self.executor.execute(
                                cmd,
                                timeout=yaml_data.get("timeout_secs", 30),
                            )
                        )
                        observation = f"<bash_output>{output}</bash_output>"
                        if exit_code != 0:
                            self.bash_error_count += 1
                            if (
                                self.bash_error_count
                                < self.current_task_config.max_retry
                            ):
                                observation += "\nBash execution failed with above error. Please fix any potential bug and retry.\n"
                            else:
                                self.done = True
                                observation += "\nBash execution failure reaches maximum allowed times.\n"
                        reward = 0.0
                except yaml.YAMLError as e:
                    observation = f"Action parsing error. {str(e)}"
                    reward = 0.0

        # 2) Verify via test cases when it's done.
        if self.done:
            self._capture_post_agent_pane()
            try:
                reward = asyncio.run(
                    calculate_test_score(
                        terminal=self.terminal,  # type: ignore
                        trial_handler=self.trial_handler,  # type: ignore
                        task_name=self.current_task_config.task_name,
                        test_weights=self.current_task_config.test_weights,
                        max_test_timeout_sec=self.current_task_config.max_test_timeout_sec,
                        rollout_id=self.env_name,
                    )
                )
            except Exception as e:
                logging.error(f"[{self.env_name[:8]}] Reward calc failed: {e}")
                reward = 0.0
                info["reward_error"] = str(e)

        return (
            observation,
            reward,
            self.done,
            self.done,
            info,
        )

    def close(self):
        """Clean up Docker container and resources."""
        logging.debug(f"[{self.env_name[:8]}] Closing")
        self._cleanup()

    def _cleanup(self):
        """Cleanup Docker container and resources asynchronously."""
        container_name = None
        try:
            if self.terminal:
                # Store container name before stopping
                if self.terminal.container:
                    container_name = self.terminal.container.name

                logging.debug(f"[{self.env_name[:8]}] Stopping terminal")
                self.terminal.stop()
                logging.info(f"[{self.env_name[:8]}] Terminal stopped")
                self.terminal = None
                self.session = None

                # Verify container is actually stopped/removed
                if container_name:
                    self._verify_container_stopped(container_name)
        except Exception as e:
            logging.debug(f"[{self.env_name[:8]}] Cleanup error (non-critical): {e}")

    def _verify_container_stopped(self, container_name: str):
        """Verify Docker container is stopped/removed, force stop if necessary."""
        try:
            # Check if container exists
            result = subprocess.run(
                [
                    "docker",
                    "ps",
                    "-a",
                    "--filter",
                    f"name={container_name}",
                    "--format",
                    "{{.Names}}",
                ],
                capture_output=True,
                text=True,
                timeout=5,
            )

            if container_name in result.stdout:
                logging.warning(
                    f"[{self.env_name[:8]}] Container {container_name} still exists after cleanup"
                )

                # Check if it's still running
                running_result = subprocess.run(
                    [
                        "docker",
                        "ps",
                        "--filter",
                        f"name={container_name}",
                        "--format",
                        "{{.Names}}",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )

                if container_name in running_result.stdout:
                    logging.warning(
                        f"[{self.env_name[:8]}] Container {container_name} is still running - forcing stop"
                    )
                    # Force stop the container
                    subprocess.run(
                        ["docker", "stop", "-t", "0", container_name],
                        capture_output=True,
                        timeout=10,
                    )
                    logging.info(
                        f"[{self.env_name[:8]}] Force stopped container {container_name}"
                    )

                # Remove the container
                logging.debug(
                    f"[{self.env_name[:8]}] Removing container {container_name}"
                )
                subprocess.run(
                    ["docker", "rm", "-f", container_name],
                    capture_output=True,
                    timeout=10,
                )
                logging.info(
                    f"[{self.env_name[:8]}] Removed container {container_name}"
                )
        except subprocess.TimeoutExpired:
            logging.error(
                f"[{self.env_name[:8]}] Timeout while verifying/stopping container {container_name}"
            )
        except Exception as e:
            logging.error(
                f"[{self.env_name[:8]}] Error verifying container cleanup: {e}"
            )

    def _capture_pre_agent_pane(self):
        """Capture the terminal pane before agent starts."""
        try:
            if self.session:
                pane_content = self.session.capture_pane(capture_entire=True)
                # Ensure directory exists
                self.trial_handler.trial_paths.pre_agent_pane_path.parent.mkdir(
                    parents=True, exist_ok=True
                )
                self.trial_handler.trial_paths.pre_agent_pane_path.write_text(
                    pane_content
                )
                logging.debug(f"[{self.env_name[:8]}] Captured pre-agent pane")
        except Exception as e:
            logging.warning(
                f"[{self.env_name[:8]}] Failed to capture pre-agent pane: {e}"
            )
            # Write empty file to prevent downstream errors
            try:
                self.trial_handler.trial_paths.pre_agent_pane_path.parent.mkdir(
                    parents=True, exist_ok=True
                )
                self.trial_handler.trial_paths.pre_agent_pane_path.write_text("")
            except Exception:
                pass

    def _capture_post_agent_pane(self):
        """Capture the terminal pane after agent completes."""
        try:
            if self.session:
                pane_content = self.session.capture_pane(capture_entire=True)
                # Ensure directory exists
                self.trial_handler.trial_paths.post_agent_pane_path.parent.mkdir(
                    parents=True, exist_ok=True
                )
                self.trial_handler.trial_paths.post_agent_pane_path.write_text(
                    pane_content
                )
                logging.debug(f"[{self.env_name[:8]}] Captured post-agent pane")
        except Exception as e:
            logging.warning(
                f"[{self.env_name[:8]}] Failed to capture post-agent pane: {e}"
            )
            # Write empty file to prevent downstream errors
            try:
                self.trial_handler.trial_paths.post_agent_pane_path.parent.mkdir(
                    parents=True, exist_ok=True
                )
                self.trial_handler.trial_paths.post_agent_pane_path.write_text("")
            except Exception:
                pass
