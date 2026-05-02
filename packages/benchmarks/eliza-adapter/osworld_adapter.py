import logging
import base64
import json
import time
from typing import Dict, List, Any

# Adjust import path to match where this file is placed relative to mm_agents
try:
    from mm_agents.agent import PromptAgent
except ImportError:
    # Fallback if running from a different context, though this file is intended to be used with OSWorld
    import sys
    import os
    sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../OSWorld")))
    from mm_agents.agent import PromptAgent

from milady_adapter.client import MiladyClient

logger = logging.getLogger("desktopenv.agent")

class MiladyOSWorldAgent(PromptAgent):
    """
    Agent that delegates decision making to a running Milady server via HTTP.
    """
    def __init__(
        self,
        milady_url: str = "http://localhost:3939",
        model: str = "milady-agent", # Logic is handled by server, model name is for logging
        **kwargs
    ):
        super().__init__(model=model, **kwargs)
        self.client = MiladyClient(base_url=milady_url)
        self.milady_url = milady_url
        print(f"Initialized MiladyOSWorldAgent connecting to {milady_url}")
        
    def call_llm(self, payload: Dict[str, Any]) -> str:
        """
        Override call_llm to send request to Milady server.
        Note: PromptAgent.predict constructs the prompt and calls call_llm.
        However, PromptAgent logic is tightly coupled with specific prompt templates for GPT/Claude.
        Milady expects high-level context, not raw chat messages formatted for GPT.
        
        So we might want to override predict() instead.
        But let's see if we can just shim call_llm first.
        
        The payload 'messages' contains the history + current observation constructed by PromptAgent.
        """
        # We'll ignore the specific PromptAgent prompting and just send the observation to Milady
        # But PromptAgent.predict() has already processed the observation into the prompt.
        # This is messy.
        
        # Better approach: Override predict() completely.
        return ""

    def predict(self, instruction: str, obs: Dict) -> List:
        """
        Predict the next action(s) based on the current observation.
        """
        # Prepare context for Milady
        context = {
            "benchmark": "osworld",
            "taskId": "osworld-task", # We could pass real ID if available
            "goal": instruction,
            "observation": {},
            "actionSpace": ["computer_13" if self.action_space == "computer_13" else "pyautogui"]
        }
        
        # Format observation
        # OSWorld obs has 'screenshot' (bytes), 'accessibility_tree', etc.
        if "screenshot" in obs and obs["screenshot"]:
             # Encode to base64 string if not already
             if isinstance(obs["screenshot"], bytes):
                 context["observation"]["screenshot_base64"] = base64.b64encode(obs["screenshot"]).decode('utf-8')
             else:
                 context["observation"]["screenshot_base64"] = obs["screenshot"] # Assuming already base64 string or compatible

        if "accessibility_tree" in obs:
            context["observation"]["accessibility_tree"] = obs["accessibility_tree"]

        # Send to Milady
        try:
            # We construct a text message describing the task to trigger Milady
            # The context carries the heavy data (screenshot)
            resp = self.client.send_message(
                text=f"Task: {instruction}",
                context=context
            )
            
            # Response should contain actions in params
            # resp.params: { command, tool_name, arguments, ... }
            # OSWorld expects a list of action dictionaries (e.g. [{'action_type': 'click', ...}])
            # OR code string if using PyAutoGUI
            
            # We need to map Milady response to OSWorld expected format.
            # This depends on self.action_space
            
            # For now, let's assume we use 'computer_13' or similar high level actions
            # PromptAgent expects a raw string response from LLM, then parses it in self.parse_actions
            # We should probably return the "thought" as the first return value
            
            thought = resp.thought or resp.text
            
            # If we returned actions directly in params (via BENCHMARK_ACTION), we need to format them back to code/json
            # expected by PromptAgent.parse_actions OR just return the parsed actions directly.
            
            # PromptAgent.predict returns (response, actions)
            # We can construct actions manually and return them.
            
            actions = []
            params = resp.params
            
            # Map BENCHMARK_ACTION params to OSWorld actions
            # Example params: { command: "CLICK(123)", ... }
            # or { tool_name: "computer", arguments: { action: "click", coordinate: [x, y] } }
            
            # Adaptation logic here...
            # For simplicity, let's just use the text response if it contains code blocks
            # But prompt-agent expects specific formats.
            
            # Let's say we teach Milady to output code blocks matching OSWorld format in the system prompt.
            # BENCHMARK_MESSAGE_TEMPLATE is generic.
            
            # If we return the text from Milady, and Milady followed instructions to output code blocks:
            # We can use PromptAgent.parse_actions(resp.text)
            
            # But Milady is instructed to use BENCHMARK_ACTION.
            # We should construct the action list from resp.params.
            
            # Example mapping for PyAutoGUI (code based):
            if self.action_space == "pyautogui":
                # params should have the code?
                # If Milady used BENCHMARK_ACTION with 'command' or 'value' containing code
                code = params.get("command") or params.get("value") or params.get("arguments")
                if code:
                    # If it's a dict/json string, try to extract code
                    if isinstance(code, dict):
                        code = json.dumps(code)
                    return thought, [code]
            
            return thought, actions

        except Exception as e:
            logger.error(f"Error calling Milady: {e}", exc_info=True)
            return "Error", []

