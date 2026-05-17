import ast
import re
import logging
from collections import defaultdict
from io import BytesIO
from typing import Any, Dict, List, Optional, Tuple, Union
import time
import pytesseract
from PIL import Image
from pytesseract import Output

from ..tools.new_tools import NewTools
from ..utils.common_utils import parse_single_code_from_string

logger = logging.getLogger("desktopenv.agent")


class ACI:

    def __init__(self):
        self.notes: List[str] = []


def agent_action(func):
    func.is_agent_action = True
    return func


class Grounding(ACI):

    def __init__(
        self,
        Tools_dict: Dict,
        platform: str,
        global_state=None,
        width: int = 1920,
        height: int = 1080,
    ):
        self.platform = platform
        self.Tools_dict = Tools_dict
        self.global_state = global_state
        self.width = width
        self.height = height
        self.coords1 = None
        self.coords2 = None

        self.grounding_model = NewTools()
        self.grounding_model.register_tool(
            "grounding", self.Tools_dict["grounding"]["provider"],
            self.Tools_dict["grounding"]["model"])

        self.grounding_width, self.grounding_height = self.grounding_model.tools[
            "grounding"].get_grounding_wh()
        if self.grounding_width is None or self.grounding_height is None:
            self.grounding_width = self.width
            self.grounding_height = self.height

        self.text_span_agent = NewTools()
        self.text_span_agent.register_tool(
            "text_span", self.Tools_dict["text_span"]["provider"],
            self.Tools_dict["text_span"]["model"])

    def generate_coords(self, ref_expr: str, obs: Dict) -> List[int]:
        grounding_start_time = time.time()
        self.grounding_model.tools["grounding"].llm_agent.reset()
        prompt = (
            f"Task: Visual Grounding - Locate and return coordinates\n"
            f"Query: {ref_expr}\n"
            "Instructions: "
            "1. Carefully analyze the provided screenshot image. "
            "2. Locate the EXACT element/area described in the query. "
            "3. Return ONLY the pixel coordinates [x, y] of one representative point strictly inside the target area. "
            "4. Choose a point that is clearly inside the described element/region "
            "5. Coordinates must be integers representing pixel positions on the image. "
            "6. If the described element has multiple instances, select the most prominent or central one "
            "7. If this appears to be for dragging (selecting text, moving items, etc.): For START points: Position slightly to the LEFT of text/content in empty space For END points: Position slightly to the RIGHT of text/content in empty space Avoid placing coordinates directly ON text characters to prevent text selection issues Keep offset minimal (3-5 pixels) - don't go too far from the target area Still return only ONE coordinate as requested \nStill return only ONE coordinate as requested \n"
            "Output Format: Return only two integers separated by comma, like: (900, 400)\n"
            "Important Notes: "
            "- Focus on the main descriptive elements in the query (colors, positions, objects) "
            "- Ignore any additional context "
            "- The returned point should be clickable/actionable within the target area \n"
            "CRITICAL REQUIREMENTS: "
            "- MUST return exactly ONE coordinate pair under ALL circumstances "
            "- NO explanations, NO multiple coordinates, NO additional text \n")
        response, total_tokens, cost_string = self.grounding_model.execute_tool(
            "grounding", {
                "str_input": prompt,
                "img_input": obs["screenshot"]
            })
        logger.info(
            f"Grounding model tokens: {total_tokens}, cost: {cost_string}")
        grounding_end_time = time.time()
        grounding_duration = grounding_end_time - grounding_start_time
        logger.info(
            f"Grounding model execution time: {grounding_duration:.2f} seconds")
        logger.info(f"RAW GROUNDING MODEL RESPONSE: {response}")
        if self.global_state:
            self.global_state.log_llm_operation(
                module="grounding",
                operation="grounding_model_response",
                data={
                    "tokens": total_tokens,
                    "cost": cost_string,
                    "content": response,
                    "duration": grounding_duration
                },
                str_input=prompt,
                img_input=obs["screenshot"]
            )
        numericals = re.findall(r"\d+", response)
        assert len(numericals) >= 2
        return [int(numericals[0]), int(numericals[1])]

    def assign_coordinates(self, plan: str, obs: Dict):
        self.coords1, self.coords2 = None, None
        try:
            action = parse_single_code_from_string(
                plan.split("Grounded Action")[-1])
            function_name = re.match(r"(\w+\.\w+)\(",
                                     action).group(1)  # type: ignore
            args = self.parse_function_args(action)
        except Exception as e:
            raise RuntimeError(f"Error in parsing grounded action: {e}") from e

        if (function_name in [
                "agent.click", "agent.doubleclick", "agent.move", "agent.scroll", "agent.type"
        ] and len(args) >= 1 and args[0] is not None and str(args[0]).strip() != ""):
            self.coords1 = self.generate_coords(args[0], obs)
        elif function_name == "agent.drag" and len(args) >= 2:
            self.coords1 = self.generate_coords(args[0], obs)
            self.coords2 = self.generate_coords(args[1], obs)

    def reset_screen_size(self, width: int, height: int):
        self.width = width
        self.height = height

    def resize_coordinates(self, coordinates: List[int]) -> List[int]:
        return [
            round(coordinates[0] * self.width / self.grounding_width),
            round(coordinates[1] * self.height / self.grounding_height),
        ]

    def resize_coordinates_with_padding(self,
                                        coordinates: List[int]) -> List[int]:
        grounding_size = max(self.grounding_width, self.grounding_height)
        original_size = max(self.width, self.height)
        coordinates = [
            round(coordinates[0] * original_size / grounding_size),
            round(coordinates[1] * original_size / grounding_size),
        ]
        padding_left = round((original_size - self.width) / 2)
        padding_top = round((original_size - self.height) / 2)
        return [
            coordinates[0] - padding_left,
            coordinates[1] - padding_top,
        ]

    def parse_function_args(self, function: str) -> List[str]:
        if not function or not isinstance(function, str):
            return []
        pattern = r'(\w+\.\w+)\((?:"([^"]*)")?(?:,\s*(\d+))?\)'
        match = re.match(pattern, function)
        if match:
            args = []
            if match.group(2) is not None:
                args.append(match.group(2))
            if match.group(3) is not None:
                args.append(int(match.group(3)))
            if args:
                return args
        try:
            tree = ast.parse(function)
        except Exception:
            return []
        if not tree.body or not hasattr(tree.body[0], 'value'):
            return []
        call_node = tree.body[0].value  # type: ignore
        if not isinstance(call_node, ast.Call):
            return []

        def safe_eval(node):
            if isinstance(node, ast.Constant):
                return node.value
            elif hasattr(ast, 'Str') and isinstance(node, ast.Str):
                return node.s
            else:
                try:
                    return ast.unparse(node)
                except Exception:
                    return str(node)

        positional_args = []
        try:
            positional_args = [safe_eval(arg) for arg in call_node.args]
        except Exception:
            positional_args = []
        keyword_args = {}
        try:
            keyword_args = {
                kw.arg: safe_eval(kw.value) for kw in call_node.keywords
            }
        except Exception:
            keyword_args = {}
        res = []
        for key, val in keyword_args.items():
            if key and "description" in key:
                res.append(val)
        for arg in positional_args:
            res.append(arg)
        return res

    def _record_passive_memory(self, action_type: str, action_details: str):
        memory_content = f"Hardware action `{action_type}` has been executed. Details: {action_details}"

    @agent_action
    def click(
        self,
        element_description: str,
        button: int = 1,
        holdKey: List[str] = [],
    ):
        x, y = self.resize_coordinates(self.coords1)  # type: ignore
        actionDict = {
            "type": "Click",
            "x": x,
            "y": y,
            "element_description": element_description,
            "button": button,
            "holdKey": holdKey
        }
        action_details = f"Clicked at coordinates ({x}, {y}) with button {button}, element: {element_description}"
        self._record_passive_memory("Click", action_details)
        return actionDict

    @agent_action
    def doubleclick(
        self,
        element_description: str,
        button: int = 1,
        holdKey: List[str] = [],
    ):
        x, y = self.resize_coordinates(self.coords1)  # type: ignore
        actionDict = {
            "type": "DoubleClick",
            "x": x,
            "y": y,
            "element_description": element_description,
            "button": button,
            "holdKey": holdKey
        }
        action_details = f"Double clicked at coordinates ({x}, {y}) with button {button}, element: {element_description}"
        self._record_passive_memory("DoubleClick", action_details)
        return actionDict

    @agent_action
    def move(
        self,
        element_description: str,
        holdKey: List[str] = [],
    ):
        x, y = self.resize_coordinates(self.coords1)  # type: ignore
        actionDict = {
            "type": "Move",
            "x": x,
            "y": y,
            "element_description": element_description,
            "holdKey": holdKey
        }
        action_details = f"Moved to coordinates ({x}, {y}), element: {element_description}"
        self._record_passive_memory("Move", action_details)
        return actionDict

    @agent_action
    def scroll(
        self,
        element_description: str,
        clicks: int,
        vertical: bool = True,
        holdKey: List[str] = [],
    ):
        x, y = self.resize_coordinates(self.coords1)  # type: ignore
        if vertical:
            actionDict = {
                "type": "Scroll",
                "x": x,
                "y": y,
                "element_description": element_description,
                "stepVertical": clicks,
                "holdKey": holdKey
            }
            action_details = f"Scrolled vertically at coordinates ({x}, {y}) with {clicks} clicks, element: {element_description}"
        else:
            actionDict = {
                "type": "Scroll",
                "x": x,
                "y": y,
                "element_description": element_description,
                "stepHorizontal": -clicks,
                "holdKey": holdKey
            }
            action_details = f"Scrolled horizontally at coordinates ({x}, {y}) with {clicks} clicks (mapped to {-clicks}), element: {element_description}"
        self._record_passive_memory("Scroll", action_details)
        return actionDict

    @agent_action
    def drag(
        self,
        starting_description: str,
        ending_description: str,
        holdKey: List[str] = [],
    ):
        x1, y1 = self.resize_coordinates(self.coords1)  # type: ignore
        x2, y2 = self.resize_coordinates(self.coords2)  # type: ignore
        actionDict = {
            "type": "Drag",
            "startX": x1,
            "startY": y1,
            "endX": x2,
            "endY": y2,
            "holdKey": holdKey,
            "starting_description": starting_description,
            "ending_description": ending_description
        }
        action_details = f"Dragged from ({x1}, {y1}) to ({x2}, {y2}), starting: {starting_description}, ending: {ending_description}"
        self._record_passive_memory("Drag", action_details)
        return actionDict

    @agent_action
    def type(
        self,
        element_description: Optional[str] = None,
        text: str = "",
        overwrite: bool = False,
        enter: bool = False,
    ):
        # 若提供 element_description 并已在 assign_coordinates 中得到 coords1，则下发坐标
        payload: Dict[str, Any] = {
            "type": "TypeText",
            "text": text,
            "overwrite": overwrite,
            "enter": enter,
        }
        if element_description and self.coords1 is not None:
            x, y = self.resize_coordinates(self.coords1)  # type: ignore
            payload.update({
                "x": x,
                "y": y,
                "element_description": element_description,
            })

        action_details = f"Type text with params: element={element_description}, overwrite={overwrite}, enter={enter}, text={text}"
        self._record_passive_memory("TypeText", action_details)
        return payload

    @agent_action
    def hotkey(
        self,
        keys: List[str] = [],
        duration: int = 0,
    ):
        keys = [f"{key}" for key in keys]
        if 1 <= duration <= 5000:
            actionDict = {
                "type": "Hotkey",
                "keys": keys,
                "duration": duration,
            }
            action_details = f"Pressed hotkey combination: {', '.join(keys)} with duration {duration}ms"
        else:
            actionDict = {
                "type": "Hotkey",
                "keys": keys,
            }
            action_details = f"Pressed hotkey combination: {', '.join(keys)}"
        self._record_passive_memory("Hotkey", action_details)
        return actionDict

    @agent_action
    def wait(self, duration: int):
        actionDict = {"type": "Wait", "duration": duration}
        action_details = f"Waited for {duration} milliseconds"
        self._record_passive_memory("Wait", action_details)
        return actionDict

    @agent_action
    def done(
        self,
        message: str = '',
    ):
        self.returned_info = message
        actionDict = {"type": "Done", "message": message}
        return actionDict

    @agent_action
    def fail(
        self,
        message: str = '',
    ):
        actionDict = {"type": "Failed", "message": message}
        return actionDict

    @agent_action
    def supplement(
        self,
        message: str = '',
    ):
        actionDict = {"type": "Supplement", "message": message}
        return actionDict

    @agent_action
    def need_quality_check(
        self,
        message: str = '',
    ):
        actionDict = {"type": "NeedQualityCheck", "message": message}
        return actionDict

    @agent_action
    def memorize(
        self,
        information: str,
        memory_type: str = "active",
    ):
        actionDict = {
            "type": "Memorize",
            "information": information,
        }
        return actionDict

    @agent_action
    def passive_memorize(
        self,
        information: str,
    ):
        return self.memorize(information, memory_type="passive")

    @agent_action
    def user_takeover(
        self,
        message: str = '',
    ):
        # self.global_state.set_running_state("stopped")
        actionDict = {"type": "UserTakeover", "message": message}
        return actionDict

    @agent_action
    def set_cell_values(
        self,
        cell_values: Dict[str, Any],
        app_name: str,
        sheet_name: str,
    ):
        if str(self.platform).lower() == "windows":
            raise RuntimeError(
                "set_cell_values is not supported on Windows in agents3")
        actionDict = {
            "type": "SetCellValues",
            "cell_values": cell_values,
            "app_name": app_name,
            "sheet_name": sheet_name,
        }
        self._record_passive_memory(
            "SetCellValues",
            f"Set values in app '{app_name}', sheet '{sheet_name}', cells: {list(cell_values.keys())}",
        )
        return actionDict

    @agent_action
    def switch_applications(self, app_code: str):
        actionDict = {
            "type": "SwitchApplications",
            "app_code": app_code,
        }
        self._record_passive_memory(
            "SwitchApplications",
            f"Switch to application '{app_code}' on platform '{self.platform}'",
        )
        return actionDict

    @agent_action
    def switch_app(self, app_code: str):
        return self.switch_applications(app_code)

    @agent_action
    def open(self, app_or_filename: str):
        actionDict = {
            "type": "Open",
            "app_or_filename": app_or_filename,
        }
        self._record_passive_memory(
            "Open",
            f"Open app or file '{app_or_filename}' on platform '{self.platform}'",
        )
        return actionDict
