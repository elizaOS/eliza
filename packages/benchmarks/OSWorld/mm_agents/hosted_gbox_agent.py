"""
Hosted GBOX Agent Client
Thin HTTP wrapper that calls the hosted GBOX service
"""
import os
import logging
import requests
from typing import Dict, List, Tuple

logger = logging.getLogger("hosted-gbox-agent")


class HostedGboxAgent:
    """
    Client wrapper for hosted GBOX service.
    Follows the same interface as other OSWorld agents but delegates execution to remote service.
    """

    def __init__(
        self,
        server_url: str,
        api_key: str,
        vm_ip: str,
        platform: str = "ubuntu",
        model: str = "claude-sonnet-4-5",
        max_steps: int = 15,
        **kwargs
    ):
        """
        Initialize hosted agent client

        Args:
            server_url: URL of hosted GBOX service (e.g., "http://44.201.221.203:8000")
            api_key: API key for authentication
            vm_ip: IP address of the VM to control
            platform: OS platform (ubuntu/windows)
            model: Claude model to use
            max_steps: Maximum steps per task
        """
        self.server_url = server_url.rstrip('/')
        self.api_key = api_key
        self.vm_ip = vm_ip
        self.platform = platform
        self.model = model
        self.max_steps = max_steps
        self.runtime_logger = None

        # HTTP client with timeout
        self.client = requests.Session()
        self.client.headers.update({"X-API-Key": api_key})

        logger.info(f"Initialized hosted agent client for VM {vm_ip}")
        logger.info(f"Server: {server_url}, Model: {model}")

    def reset(self, runtime_logger=None, vm_ip: str = None):
        """
        Reset agent state (called by OSWorld before each task)

        Args:
            runtime_logger: Logger instance for OSWorld runtime logs
            vm_ip: Updated VM IP (in case of snapshot revert)
        """
        self.runtime_logger = runtime_logger

        if vm_ip:
            self.vm_ip = vm_ip
            if self.runtime_logger:
                self.runtime_logger.info(f"[HOSTED] Updated VM IP to {vm_ip}")

        if self.runtime_logger:
            self.runtime_logger.info(f"[HOSTED] Agent reset for VM {self.vm_ip}")

    def predict(self, instruction: str, obs: Dict) -> Tuple[str, List[str]]:
        """
        Execute task prediction (one call = full task execution)

        Args:
            instruction: Task instruction
            obs: Observation dict (not used - agent fetches its own screenshots)

        Returns:
            (reasoning_text, actions_list)
            - reasoning_text: Claude's reasoning/explanation
            - actions_list: ["DONE"] or ["FAIL"] or PyAutoGUI code
        """
        try:
            # Prepare request (no screenshot needed - agent fetches its own)
            payload = {
                "vm_ip": self.vm_ip,
                "instruction": instruction,
                "platform": self.platform,
                "model": self.model,
                "max_steps": self.max_steps
            }

            # Log request
            if self.runtime_logger:
                self.runtime_logger.info(f"[HOSTED] Sending task to service...")
                self.runtime_logger.info(f"[HOSTED] Instruction: {instruction[:100]}...")

            # Call hosted service (this may take several minutes)
            response = self.client.post(
                f"{self.server_url}/execute",
                json=payload,
                timeout=3600  # 60 minutes timeout for full task execution
            )

            # Check for errors
            if response.status_code == 401:
                raise RuntimeError("Authentication failed - invalid API key")
            elif response.status_code != 200:
                raise RuntimeError(f"Service returned {response.status_code}: {response.text}")

            # Parse response
            result = response.json()
            reasoning = result.get("reasoning", "")
            actions = result.get("actions", ["FAIL"])
            logs = result.get("logs", "")
            session_id = result.get("session_id", "unknown")

            # Forward server logs to OSWorld's runtime logger
            if logs and self.runtime_logger:
                for line in logs.split('\n'):
                    if line.strip():
                        self.runtime_logger.info(f"[SERVER] {line}")

            # Log results
            if self.runtime_logger:
                self.runtime_logger.info(f"[HOSTED] Session ID: {session_id}")
                self.runtime_logger.info(f"[HOSTED] Actions: {actions}")
                self.runtime_logger.info(f"[HOSTED] Reasoning: {reasoning[:200]}...")

            return reasoning, actions

        except requests.Timeout:
            error_msg = "Service timeout (task took longer than 60 minutes)"
            logger.error(error_msg)
            if self.runtime_logger:
                self.runtime_logger.error(f"[HOSTED] {error_msg}")
            return f"ERROR: {error_msg}", ["FAIL"]

        except requests.ConnectionError as e:
            error_msg = f"Cannot connect to service at {self.server_url}: {str(e)}"
            logger.error(error_msg)
            if self.runtime_logger:
                self.runtime_logger.error(f"[HOSTED] {error_msg}")
            return f"ERROR: {error_msg}", ["FAIL"]

        except Exception as e:
            error_msg = f"Hosted agent error: {str(e)}"
            logger.error(error_msg, exc_info=True)
            if self.runtime_logger:
                self.runtime_logger.error(f"[HOSTED] {error_msg}")
            return f"ERROR: {error_msg}", ["FAIL"]

    def close(self):
        """Close HTTP session"""
        self.client.close()

    def __del__(self):
        """Cleanup on deletion"""
        try:
            self.close()
        except:
            pass


# Factory function for compatibility with OSWorld runner
def create_agent(vm_ip: str, **kwargs) -> HostedGboxAgent:
    """
    Factory function to create hosted agent

    Expects environment variables:
    - GBOX_SERVICE_URL: URL of hosted service
    - GBOX_SERVICE_API_KEY: API key for authentication
    """
    server_url = os.getenv("GBOX_SERVICE_URL")
    api_key = os.getenv("GBOX_SERVICE_API_KEY")

    if not server_url:
        raise ValueError("GBOX_SERVICE_URL environment variable not set")
    if not api_key:
        raise ValueError("GBOX_SERVICE_API_KEY environment variable not set")

    return HostedGboxAgent(
        server_url=server_url,
        api_key=api_key,
        vm_ip=vm_ip,
        **kwargs
    )
