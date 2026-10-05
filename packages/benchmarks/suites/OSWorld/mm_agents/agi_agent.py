import base64
import logging
import time
from typing import Dict, List, Tuple, Any, Optional

import httpx

logger = logging.getLogger("desktopenv.agent")


class Timer:
    """Context manager for timing code blocks."""

    def __enter__(self):
        self.start = time.time()
        return self

    def __exit__(self, *args):
        self.duration = time.time() - self.start


class AGIAgent:
    """Agent that communicates with your private AGI server for decision-making."""

    def __init__(
        self,
        env,
        server_url: str = "https://your-private-agi-endpoint", # Contact the authors for access to a private deployment endpoint.
        platform: str = "ubuntu",
        action_space: str = "pyautogui",
        observation_type: str = "screenshot",
        max_trajectory_length: int = 100,
        client_password: str = "",
        provider_name: str = "aws",
        screen_width: int = 1920,
        screen_height: int = 1080,
        timeout: int = 1800,
    ):
        """Initialize the AGI client.

        Args:
            env: The desktop environment
            server_url: URL of your private AGI server
        """
        self.env = env
        self.server_url = server_url.rstrip("/")
        self.platform = platform
        self.action_space = action_space
        self.observation_type = observation_type
        self.max_trajectory_length = max_trajectory_length
        self.client_password = client_password
        self.provider_name = provider_name
        self.screen_width = screen_width
        self.screen_height = screen_height

        # Session management
        self.session_id: Optional[str] = None
        self.instruction: Optional[str] = None

        # HTTP client
        self.client = httpx.Client(timeout=timeout)

        # Tracking
        self.thoughts = []
        self.actions = []
        self.observations = []

        logger.info(f"Initialized AGIAgent with server URL: {self.server_url}")

    def reset(self, runtime_logger=None):
        """Reset the agent and create a new session on the server.

        Args:
            runtime_logger: Optional logger for runtime information
        """
        global logger
        logger = runtime_logger if runtime_logger is not None else logging.getLogger("desktopenv.agent")

        # Clear local state
        self.thoughts = []
        self.actions = []
        self.observations = []
        self.session_id = None

        logger.info("AGIAgent reset complete")

    def _create_session(self, instruction: str) -> str:
        """Create a new session on the server.

        Args:
            instruction: The task instruction

        Returns:
            The session ID
            
        Equivalent curl request:
            curl -X POST {server_url}/sessions \
                 -H "Content-Type: application/json" \
                 -d '{"task_description": "{instruction}"}'
        """
        try:
            # print(f"Creating session with instruction: {instruction}")
            # print(f"Server URL: {self.server_url}")
            response = self.client.post(
                f"{self.server_url}/sessions",
                json={"task_description": instruction}
            )
            response.raise_for_status()
            session_id = response.json()["session_id"]
            logger.info(f"Created session: {session_id}")
            return session_id
        except Exception as e:
            logger.error(f"Failed to create session: {e}")
            raise

    def predict(self, instruction: str, obs: Dict) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
        """Predict the next action based on the current observation.

        Args:
            instruction: The task instruction
            obs: Observation dictionary containing 'screenshot' key with image bytes

        Returns:
            Tuple of (predict_info dict, list of action dicts)
        """
        # Create session on first prediction
        if self.session_id is None:
            self.instruction = instruction
            self.session_id = self._create_session(instruction)
        
        # input("Session created, press Enter to continue")

        # Encode screenshot to base64
        screenshot_bytes = obs["screenshot"]
        screenshot_b64 = base64.b64encode(screenshot_bytes).decode("utf-8")

        # Call the server
        with Timer() as model_timer:
            try:
                response = self.client.post(
                    f"{self.server_url}/sessions/{self.session_id}/step",
                    json={
                        "screenshot_base64_png": screenshot_b64,
                        "error": None  # Could be populated from previous step errors
                    }
                )
                response.raise_for_status()
                result = response.json()
                parsed_action = result["parsed_response"]

                logger.info(f"Server returned action: {parsed_action[:100]}...")

            except Exception as e:
                logger.error(f"Error calling server: {e}")
                raise

        # Format response as expected by lib_run_single
        actions = [{
            "action_space": "pyautogui",
            "action": parsed_action,
            "pending_checks": [],
            "call_id": ""
        }]

        # Check if task is complete or failed
        state_correct = parsed_action not in ["FAIL", "DONE"]

        predict_info = {
            "model_usage": {
                "model_time": model_timer.duration,
                "prompt_tokens": 0,  # Server doesn't expose these
                "completion_tokens": 0,
            },
            "messages": [],  # Server manages conversation history
            "response": parsed_action,
            "state_correct": state_correct,
        }

        return predict_info, actions

    def step(self, action: Dict[str, Any]) -> Tuple[Dict, float, bool, Dict, Dict]:
        """Execute an action in the environment.

        Args:
            action: Action dictionary with 'action' key containing PyAutoGUI command

        Returns:
            Tuple of (observation, reward, done, info, step_info)
        """
        try:
            if not action:
                logger.warning("Empty action received, terminating episode")
                # Get observation without executing action
                obs = self.env._get_obs()
                return obs, 0.0, True, {}, {"step_time": 0.0, "action": action}

            action_str = action.get("action", "")
            logger.info(f"Executing action: {action_str[:100]}...")

            with Timer() as step_timer:
                # Execute the action directly (it's already a PyAutoGUI command string)
                obs, reward, terminated, info = self.env.step(action_str)

            logger.debug(f"Action completed in {step_timer.duration:.2f}s")
            if terminated:
                logger.info("Environment signaled termination")

            return obs, reward, terminated, info, {
                "step_time": step_timer.duration,
                "action": action
            }

        except Exception as e:
            logger.exception(f"Environment step failed: {str(e)}")
            raise

    def close(self):
        """Close the HTTP client."""
        self.client.close()
