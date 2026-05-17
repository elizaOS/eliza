from typing import Optional, Union, List
from enum import Enum
from mm_agents.uipath.utils import ExecutionInfo

key_maps = {
    "Backspace": "Back",
    "Ctrl": "Ctrl",
    "Shift": "Shift",
    "Tab": "Tab",
    "Enter": "Enter",
    "Escape": "Esc",
    "Arrowleft": "Left",
    "Arrowup": "Up",
    "Arrowright": "Right",
    "Arrowdown": "Down",
    "Delete": "Del",
    "Pageup": "PgUp",
    "Pagedown": "PgDn",
}


class PlanActionType(str, Enum):
    Click = "click"
    DoubleClick = "double_click"
    TripleClick = "triple_click"
    RightClick = "right_click"
    Type = "type"
    Scroll = "scroll"
    Drag = "drag"
    Wait = "wait"
    KeyPress = "key_press"
    MouseMove = "move_mouse"
    ExtractData = "extract_data"
    Finish = "finish"


VALID_PLAN_ACTIONS = [action.value for action in PlanActionType]


class PlanAction:
    def __init__(
        self, action_type: str, description: str, parameters: dict | None = None
    ):
        self.action_type = action_type
        self.description = description
        self.parameters = parameters if parameters is not None else {}

    def to_dict(self) -> dict:
        return {
            "type": self.action_type,
            "description": self.description,
            "parameters": self.parameters,
        }

    @classmethod
    def from_dict(cls, data: dict | None) -> Union["PlanAction", None]:
        if data is None:
            return None

        action_type = data.get("type", "").lower()

        if action_type not in VALID_PLAN_ACTIONS:
            raise Exception(f"Invalid action type: {action_type}")

        target_element = data.get("target_element", None)

        action = PlanAction(
            action_type=action_type,
            description=data.get("description", ""),
            parameters=data.get("parameters", {}),
        )

        if target_element is not None:
            action.parameters["target_element"] = target_element

        return action


class SupportedActions(str, Enum):
    Click = "click"
    TypeInto = "type_into"
    Scroll = "scroll"
    Drag = "drag"
    Wait = "wait_load_completed"
    KeyPress = "keypress"
    MouseMove = "mouse_move"
    Finish = "finish"

    def __str__(self):
        return self.value


class ComputerUseAction(object):
    def __init__(
        self,
        name: str,
        description: str,
        parameters: dict,
        action_id: str | None = None,
        result: Optional[dict | str] = None,
    ):
        self.id = action_id
        self.name = name
        self.parameters = parameters
        self.description = description
        self.result = result

    @staticmethod
    def from_dict(action_dict: dict):
        result = action_dict.get("result")
        if (
            result is not None
            and isinstance(result, dict)
            and "token_usage" in result
            and "data" in result
        ):
            result = result["data"]

        return ComputerUseAction(
            name=action_dict["name"],
            description=action_dict["description"],
            result=result,
            parameters=action_dict.get("parameters", {}),
        )

    def to_response_dict(self):
        action_dict = {
            "description": self.description,
            "method_type": self.name,
            "parameters": self.parameters,
            "id": self.id,
        }

        if self.result is not None:
            action_dict["result"] = self.result

        return action_dict


class ComputerUseStep(object):
    def __init__(
        self,
        description: str,
        actions: List[ComputerUseAction],
        thought: str | None = None,
        screen_info: dict | None = None,
        image: str | None = None,
        additional_parameters: dict | None = None,
    ):
        self.description = description
        self.actions: List[ComputerUseAction] = actions
        self.thought = thought
        self.screen_info = screen_info
        self.additional_parameters = additional_parameters
        self.image = image

    @staticmethod
    def from_dict(step_dict):
        return ComputerUseStep(
            description=step_dict["description"],
            thought=step_dict.get("thought"),
            actions=[
                ComputerUseAction.from_dict(action_dict)
                for action_dict in step_dict["actions"]
            ],
        )

    def to_response_dict(self):
        response_step = {
            "description": self.description,
            "thought": self.thought,
            "additional_parameters": self.additional_parameters,
        }
        response_actions = []

        for action in self.actions:
            action_dict = action.to_response_dict()
            response_actions.append(action_dict)
        if self.image is not None:
            response_step["image"] = self.image
        response_step["actions"] = response_actions

        return response_step


class State(object):
    def __init__(self, task: str, image_base64: str, previous_steps: list):
        self.task = task
        self.image_base64 = image_base64
        self.previous_steps = previous_steps


class ExecutionState(object):
    def __init__(self, model_name: str):
        self.model_name = model_name
        self.execution_info = ExecutionInfo()