import json
import re

from typing import Optional
from json_minify import json_minify
from json_repair import repair_json
from dataclasses import dataclass, field

class ValidationException(Exception):
    def __init__(self, message: str):
        self.message = message

class GroundingOutputValidationException(ValidationException):
    def __init__(self, message: str, element_description: str, raw_response: str | None = None):
        super().__init__(message)
        self.message = message
        self.element_description = element_description
        self.raw_response = raw_response
    
@dataclass
class RawAgentResponse:
    raw_planning_prediction: str | None = None
    grounding_error: Optional[GroundingOutputValidationException] = None


class ExecutionInfo:
    planner_action_review: Optional[dict] = None
    responses: list[RawAgentResponse] = field(default_factory=list)  # can contain both planning and grounding raw responses
    current_response: Optional[RawAgentResponse] = None

def parse_message_json(message: str) -> dict:
    message = message.strip()
    code_block_pattern = r"```json\s*([\s\S]+?)```"
    code_block_match = re.search(code_block_pattern, message, re.DOTALL)

    if code_block_match:
        json_str = code_block_match.group(1).strip()
    else:
        bracket_pattern = r"\{.*\}"
        bracket_match = re.search(bracket_pattern, message, re.DOTALL)
        if not bracket_match:
            raise ValidationException("Response does not have correct json format")
        json_str = bracket_match.group(0).strip()

    try:
        json_str = json_minify(json_str)
        data = json.loads(json_str)
    except json.JSONDecodeError:
        try:
            json_str = repair_json(json_str)
            data = json.loads(json_str)
        except json.JSONDecodeError:
            raise ValidationException("Response does not have correct json format")
    return data


class GroundingOutput:
    def __init__(
        self,
        description: str,
        position: tuple[int, int],
        end_position: tuple[int, int] = None,
    ):
        self.description = description
        self.position = position
        self.end_position = end_position
    
    def get_point_location(self) -> tuple[int, int]:
        if self.position is None:
            x1, y1, x2, y2 = self.bbox
            x, y = (x1 + x2) // 2, (y1 + y2) // 2
        else:
            x, y = self.position
        return x, y

class GroundingRequest:
    def __init__(
        self, description: str, image_base64: str, action_type: str | None = None, element_description: str | None = None
    ):
        self.description = description
        self.image_base64 = image_base64
        self.action_type = action_type
        self.element_description = element_description