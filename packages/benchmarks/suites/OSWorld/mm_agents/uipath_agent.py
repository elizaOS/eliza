import base64
import json
from typing import Dict, List
import re
import asyncio
import logging
from mm_agents.uipath.agent import UiPathComputerUseV1


def parse_actions_from_string(input_string):
    if input_string.strip() in ["WAIT", "DONE", "FAIL"]:
        return [input_string.strip()]
    actions = []
    matches = re.findall(r"```json\s+(.*?)\s+```", input_string, re.DOTALL)
    if matches:
        try:
            for match in matches:
                action_dict = json.loads(match)
                actions.append(action_dict)
            return actions
        except json.JSONDecodeError as e:
            return f"Failed to parse JSON: {e}"
    else:
        matches = re.findall(r"```\s+(.*?)\s+```", input_string, re.DOTALL)
        if matches:
            try:
                for match in matches:
                    action_dict = json.loads(match)
                    actions.append(action_dict)
                return actions
            except json.JSONDecodeError as e:
                return f"Failed to parse JSON: {e}"
        else:
            try:
                action_dict = json.loads(input_string)
                return [action_dict]
            except json.JSONDecodeError:
                raise ValueError("Invalid response format: " + input_string)


def map_key(key):
    key = key.lower()
    if key == "space":
        key = " "
    elif key == "back":
        key = "backspace"
    elif key == "super":
        key = "win"
    elif key == "arrowdown":
        key = "down"
    elif key == "arrowup":
        key = "up"
    elif key == "arrowright":
        key = "right"
    elif key == "arrowrleft":
        key = "left"
    return key


def map_uipath_agent_actions_to_osworld(actions):
    results = []

    def handle_click(params):
        x, y = tuple(params["position"])
        if "button" in params:
            if params["button"] == "right":
                return {"action_type": "RIGHT_CLICK", "x": x, "y": y}
            elif params["button"] == "left":
                return {"action_type": "LEFT_CLICK", "x": x, "y": y}
            else:
                raise ValueError(f"Unknown click button: {params['button']}")
        elif "click_type" in params:
            if params["click_type"] == "double":
                return {"action_type": "DOUBLE_CLICK", "x": x, "y": y}
            elif params["click_type"] == "triple":
                return {"action_type": "CLICK", "x": x, "y": y, "num_clicks": 3}
            else:
                raise ValueError(f"Unknown click type: {params['click_type']}")
        else:
            return {"action_type": "CLICK", "x": x, "y": y}

    def handle_keypress(params):
        keys = [map_key(k) for k in params["keys"]]
        if len(keys) == 1:
            return {"action_type": "PRESS", "key": keys[0]}
        return {"action_type": "HOTKEY", "keys": keys}

    def handle_key_event(params, event_type):
        key = map_key(params["keys"][0])
        return {"action_type": event_type, "key": key}

    for action in actions:
        method = action["method_type"].lower()
        params = action["parameters"]

        match method:
            case "click":
                result = handle_click(params)
            case "type_into":
                result = {"action_type": "TYPING", "text": params["value"]}
            case "wait_load_completed":
                result = "WAIT"
            case "keypress":
                result = handle_keypress(params)
            case "keydown":
                result = handle_key_event(params, "KEY_DOWN")
            case "keypup":
                result = handle_key_event(params, "KEY_UP")
            case "finish":
                status_map = {"failure": "FAIL", "success": "DONE"}
                result = status_map.get(params.get("status"), "DONE")
            case "scroll":
                x, y = tuple(params["position"])
                if "offset" in params:
                    dx, dy = tuple(params["offset"])
                else:
                    dy = 5 if params["direction"] == "up" else -5
                    dx = 5 if params["direction"] == "left" else -5
                result = [
                    {"action_type": "MOVE_TO", "x": x, "y": y},
                    {"action_type": "SCROLL", "dx": dx, "dy": dy},
                ]
            case "mouse_move":
                x, y = tuple(params["position"])
                result = {"action_type": "MOVE_TO", "x": x, "y": y}
            case "drag":
                path = params["path"]
                x1, y1 = path[0]["x"], path[0]["y"]
                x2, y2 = path[1]["x"], path[1]["y"]
                result = [
                    {"action_type": "MOVE_TO", "x": x1, "y": y1},
                    {"action_type": "DRAG_TO", "x": x2, "y": y2},
                ]
            case _:
                raise ValueError(f"Unknown method type: {method}")

        results.append(result)

    return json.dumps(results)


class UipathBaseAgent:
    def __init__(
        self,
        platform="ubuntu",
        model="gpt-5-mini-2025-08-07",
        action_space="computer_13",
        observation_type="screenshot",
        client_password="password",
    ):
        self.platform = platform
        self.model = model
        self.action_space = action_space
        self.observation_type = observation_type
        self.client_password = client_password
        self.uipath_computer_use_model = UiPathComputerUseV1()

        self.thoughts = []
        self.actions = []
        self.observations = []
        self.uipath_hist = []

    def update_history(self, rsp, img_base64):
        self.uipath_hist.append(
            {
                "actions": rsp["step"]["actions"],
                "description": rsp["step"]["description"],
                "additional_parameters": rsp['step']['additional_parameters'],
                "image": img_base64,
            }
        )

    def predict(self, instruction: str, obs: Dict, args, step_idx) -> List:
        if step_idx >= args.max_steps - 1:
            message = (
                instruction + """You have reached the final step of the process.
At this point, no further actions can be taken - it may therefore be impossible to complete the task successfully.
Conclude by returning a finish action with success or failure, depending on what can be determined from the current state."""
            )
        else:
            message = instruction + "The sudo password is password, if needed."
        img_base64 = base64.b64encode(obs["screenshot"]).decode("utf-8")
        payload = {
            "previousSteps": self.uipath_hist,
            "userTask": message,
            "image": img_base64,
            "model_name": args.uipath_model_name,
        }
        rsp = asyncio.run(
            self.uipath_computer_use_model.predict_request(
                payload, args.uipath_model_name
            )
        )
        self.update_history(rsp, img_base64)

        uipath_actions = map_uipath_agent_actions_to_osworld(rsp["step"]["actions"])
        try:
            actions = self.parse_actions(uipath_actions)
            self.thoughts.append(rsp)
        except ValueError as e:
            print("Failed to parse action from response", e)
            actions = None
            self.thoughts.append("")

        if len(actions) != 0:
            while actions and isinstance(actions[0], list):
                actions = [
                    action for multi_action in actions for action in multi_action
                ]
        return rsp["step"], actions

    def parse_actions(self, response: str, masks=None):
        if self.observation_type in ["screenshot"]:
            if self.action_space == "computer_13":
                actions = parse_actions_from_string(response)
            else:
                raise ValueError("Invalid action space: " + self.action_space)
            self.actions.append(actions)
            return actions
        else:
            raise ValueError("Invalid observation type: " + self.action_space)

    def reset(self, _logger=None):
        global logger
        logger = (
            _logger if _logger is not None else logging.getLogger("desktopenv.agent")
        )

        self.thoughts = []
        self.actions = []
        self.observations = []
        self.uipath_hist = []