import json
from enum import Enum

from mm_agents.uipath.utils import ValidationException, parse_message_json, ExecutionInfo
from mm_agents.uipath.types_utils import ExecutionState, State

memory_system_template = """You also have a SHORT TERM MEMORY that stores only data  about the task. It is NOT a log of mechanical UI interactions. Use it to:
- Keep track of items that need to be processed as part of the task
- store only information that might be useful later in the task
- DO NOT store information which can be easily inferered from the task description
Never record: scrolling, mouse movement / hover, focusing an input (unless it results in a committed value change), transient pop-ups you just closed, partial / intermediate typed characters, pure navigation clicks that do not yield a new verifiable state.
Memory supports only the following operations emitted as a LIST of JSON objects (empty list if no update):
- store_info  # add or update information related to the task in memory
{{
    "key": str, # the info key, must be unique
    "info_type": Literal["data_update", "queue_elements"], 
    # data_update: different data related to the task
    # queue_elements: list of items to be processed in the task
    "value": str|json, 
    "description": str # Short human-readable description of the update (what changed and why it matters)
   
 }} 
- delete_info {{"key": str, "description": str}} - delete information from memory by key
Example: [{{"type": "store_info", "info_type": "queue_elements", "key": "scripts_to_be_executed", "value": "[script.py, script2.py, script3.py]", "description": "List of scripts that need to be executed as part of the task"}}]
"""


class EnumMemoryOperationType(str, Enum):
    StoreInfo = "store_info"
    DeleteInfo = "delete_info"
    NoOp = "no_op"


class MemoryOperation(object):
    def __init__(
        self,
        operation_type: str,
        key: str | None = None,
        value: str | dict | None = None,
        description: str | None = None,
        info_type: str | None = None,
    ):
        self.operation_type = operation_type
        self.key = key
        self.value = value
        self.description = description
        self.info_type = info_type

    @staticmethod
    def from_dict(data: dict) -> "MemoryOperation":
        operation_type = data.get("type", "").lower()

        if data.get("info_type", None) is not None or data.get("value", None) is not None:
            operation_type = EnumMemoryOperationType.StoreInfo

        if operation_type not in (EnumMemoryOperationType.StoreInfo, EnumMemoryOperationType.DeleteInfo, EnumMemoryOperationType.NoOp):
            raise ValidationException(f"Invalid memory operation type: {operation_type}")

        if operation_type == EnumMemoryOperationType.StoreInfo:
            if "key" not in data or "value" not in data:
                raise ValidationException("StoreInfo operation requires 'key' and 'value'")

        key = data.get("key", None)
        value = data.get("value", None)
        description = data.get("description", None)
        info_type = data.get("info_type", None)
        return MemoryOperation(operation_type, key, value, description, info_type)


class ShortTermMemoryManager:
    async def get_updated_memory(
        self, state: State, memory_operations: list[MemoryOperation], execution_state: ExecutionState
    ) -> tuple[dict[str, dict[str, str]], list[str]]:
        current_memory = json.loads(state.previous_steps[-1]["additional_parameters"].get("memory", "{}")) if len(state.previous_steps) > 0 else {}

        for i, memory_operation in enumerate(memory_operations):
            if memory_operation.operation_type == EnumMemoryOperationType.StoreInfo:
                if "data" not in current_memory:
                    current_memory["data"] = {}
                data_memory = current_memory["data"]

                if memory_operation.key is None or memory_operation.value is None:
                    raise ValidationException("StoreInfo operation requires 'key' and 'value'")
                if memory_operation.key not in data_memory:
                    data_memory[memory_operation.key] = {}
                data_memory[memory_operation.key]["value"] = memory_operation.value
                data_memory[memory_operation.key]["description"] = memory_operation.description
                data_memory[memory_operation.key]["info_type"] = memory_operation.info_type
            elif memory_operation.operation_type == EnumMemoryOperationType.DeleteInfo:
                data_memory = current_memory.get("data", {})
                data_memory.pop(memory_operation.key, None)
            elif memory_operation.operation_type == EnumMemoryOperationType.NoOp:
                pass
        return current_memory

    def extract_memory_operations(self, memory_response: str | None) -> list[MemoryOperation]:
        if isinstance(memory_response, str):
            try:
                memory_response = json.loads(memory_response)
            except Exception as e:
                raise ValidationException(f"Invalid memory format, cannot parse JSON: {memory_response}. Error: {e}")

        memory_operations = [MemoryOperation.from_dict(item) for item in memory_response]

        return memory_operations
