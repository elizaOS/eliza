import json
import re
from typing import Any, Dict, List, Optional, Tuple, Union

from bfcl_eval.model_handler.local_inference.base_oss_handler import OSSHandler
from overrides import override


# Constants
class Tokens:
    ESCAPE = "<escape>"
    START_TURN = "<start_of_turn>"
    END_TURN = "<end_of_turn>"
    START_FUNC_DECL = "<start_function_declaration>"
    END_FUNC_DECL = "<end_function_declaration>"
    START_FUNC_CALL = "<start_function_call>"
    END_FUNC_CALL = "<end_function_call>"
    START_FUNC_RESP = "<start_function_response>"
    END_FUNC_RESP = "<end_function_response>"


class SchemaKeys:
    DESCRIPTION = "description"
    TYPE = "type"
    PROPERTIES = "properties"
    REQUIRED = "required"
    ITEMS = "items"
    ENUM = "enum"
    NULLABLE = "nullable"


class Prefixes:
    CALL = "call:"
    RESPONSE = "response:"
    DECLARATION = "declaration:"


SYSTEM_PROMPT = (
    "You are a model that can do function calling with the following functions"
)


class FunctionGemmaHandler(OSSHandler):
    """
    Handler for FunctionGemma (Gemma 3 270M fine-tuned for function calling).
    Handles specific formatting with control tokens and custom AST parsing.
    """

    def __init__(
        self,
        model_name,
        temperature,
        registry_name,
        is_fc_model,
        dtype="bfloat16",
        **kwargs,
    ) -> None:
        super().__init__(model_name, temperature, registry_name, is_fc_model, **kwargs)

    def _escape(self, content: Any) -> str:
        """Helper to wrap content in escape tags."""
        return f"{Tokens.ESCAPE}{content}{Tokens.ESCAPE}"

    def _format_value(self, argument: Any, escape_keys: bool = True) -> str:
        if argument is None:
            return "null"

        if isinstance(argument, bool):
            return "true" if argument else "false"

        if isinstance(argument, str):
            return self._escape(argument)

        if isinstance(argument, (list, tuple)):
            items = [
                self._format_value(item, escape_keys=escape_keys) for item in argument
            ]
            return f"[{','.join(items)}]"

        if isinstance(argument, dict):
            parts = []
            # Sort keys to ensure deterministic output, matching 'dictsort' in Jinja chat template.
            for key, value in sorted(argument.items()):
                fmt_key = self._escape(key) if escape_keys else key
                fmt_val = self._format_value(value, escape_keys=escape_keys)
                parts.append(f"{fmt_key}:{fmt_val}")
            return f"{{{','.join(parts)}}}"

        return str(argument)

    def _format_schema_property(self, key: str, value: Dict[str, Any]) -> str:
        """Formats a single property definition in the schema."""
        desc = value.get(SchemaKeys.DESCRIPTION, "")
        type_val = value.get(SchemaKeys.TYPE, "").upper()

        parts = [f"{key}:{{{SchemaKeys.DESCRIPTION}:{self._escape(desc)}"]

        if type_val == "STRING":
            if SchemaKeys.ENUM in value:
                parts.append(
                    f",{SchemaKeys.ENUM}:{self._format_value(value[SchemaKeys.ENUM])}"
                )

        elif type_val == "OBJECT":
            parts.append(self._format_object_details(value))

        elif type_val == "ARRAY":
            parts.append(self._format_array_details(value))

        parts.append(f",{SchemaKeys.TYPE}:{self._escape(type_val)}}}")
        return "".join(parts)

    def _format_object_details(self, value: Dict[str, Any]) -> str:
        """Helper to format OBJECT specific fields (properties, required)."""
        res = []
        res.append(f",{SchemaKeys.PROPERTIES}:{{")

        sub_props = value.get(SchemaKeys.PROPERTIES, {})
        if sub_props:
            res.append(self._format_parameters(sub_props))
        res.append("}")

        sub_req = value.get(SchemaKeys.REQUIRED, [])
        if sub_req:
            req_list = [self._escape(item) for item in sub_req]
            res.append(f",{SchemaKeys.REQUIRED}:[{','.join(req_list)}]")

        return "".join(res)

    def _format_array_details(self, value: Dict[str, Any]) -> str:
        """Helper to format ARRAY specific fields (items)."""
        items = value.get(SchemaKeys.ITEMS, {})
        if not items:
            return ""

        item_parts = []
        for item_key, item_value in sorted(items.items()):
            if item_value is None:
                continue

            part = ""
            if item_key == SchemaKeys.PROPERTIES and isinstance(item_value, dict):
                part = (
                    f"{SchemaKeys.PROPERTIES}:{{{self._format_parameters(item_value)}}}"
                )

            elif item_key == SchemaKeys.REQUIRED:
                req_list = [self._escape(r) for r in item_value]
                part = f"{SchemaKeys.REQUIRED}:[{','.join(req_list)}]"

            elif item_key == SchemaKeys.TYPE:
                # Handle single type (str) or list of types
                if isinstance(item_value, str):
                    val_to_fmt = item_value.upper()
                else:
                    val_to_fmt = [t.upper() for t in item_value]
                part = f"{SchemaKeys.TYPE}:{self._format_value(val_to_fmt)}"

            else:
                part = f"{item_key}:{self._format_value(item_value)}"

            item_parts.append(part)

        return f",{SchemaKeys.ITEMS}:{{{','.join(item_parts)}}}"

    def _format_parameters(self, properties: Dict[str, Any]) -> str:
        """Main entry point for formatting a dictionary of parameters."""
        if not properties:
            return ""

        standard_keys = {
            SchemaKeys.DESCRIPTION,
            SchemaKeys.TYPE,
            SchemaKeys.PROPERTIES,
            SchemaKeys.REQUIRED,
            SchemaKeys.NULLABLE,
        }

        parts = []
        for key, value in sorted(properties.items()):
            if key in standard_keys:
                continue
            parts.append(self._format_schema_property(key, value))

        return ",".join(parts)

    def _format_function_declaration(self, tool_data: Dict[str, Any]) -> str:
        func = (
            tool_data.get("function", tool_data)
            if isinstance(tool_data.get("function"), dict)
            else tool_data
        )

        name = func.get("name", "")
        description = func.get("description", "")
        params = func.get("parameters", {})

        buffer = [
            f"{Prefixes.DECLARATION}{name}{{{SchemaKeys.DESCRIPTION}:{self._escape(description)}"
        ]

        if params:
            props = params.get(SchemaKeys.PROPERTIES, {})
            required = params.get(SchemaKeys.REQUIRED, [])

            if props:
                buffer.append(
                    f",{SchemaKeys.PROPERTIES}:{{{self._format_parameters(props)}}}"
                )

            if required:
                req_list = [self._escape(item) for item in required]
                buffer.append(f",{SchemaKeys.REQUIRED}:[{','.join(req_list)}]")

            if SchemaKeys.TYPE in params:
                buffer.append(
                    f",{SchemaKeys.TYPE}:{self._escape(params[SchemaKeys.TYPE].upper())}"
                )

        buffer.append("}")
        return "".join(buffer)

    @override
    def _pre_query_processing_prompting(self, test_entry: dict) -> dict:
        functions: list = test_entry["function"]

        # FuntionGemma uses its own system prompt.

        return {"message": [], "function": functions}

    def _build_system_turn(self, messages: List[Dict], function: List) -> str:
        system_content = SYSTEM_PROMPT
        if messages and messages[0]["role"] == "system":
            system_content = messages[0]["content"]

        if not function and not system_content:
            return ""

        parts = [f"{Tokens.START_TURN}developer\n"]
        if system_content:
            parts.append(f"{system_content.strip()}\n")

        for tool in function or []:
            parts.append(Tokens.START_FUNC_DECL)
            parts.append(self._format_function_declaration(tool))
            parts.append(Tokens.END_FUNC_DECL)

        parts.append(f"{Tokens.END_TURN}\n")
        return "".join(parts)

    def _build_model_turn(self, message: Dict) -> str:
        content = message.get("content", "")
        tool_calls = message.get("tool_calls", [])

        parts = [f"{Tokens.START_TURN}model\n"]
        if content:
            parts.append(f"{content.strip()}")

        for tool_call in tool_calls:
            func = tool_call.get("function", {})
            f_name = func.get("name")
            f_args = func.get("arguments")

            parts.append(f"{Tokens.START_FUNC_CALL}{Prefixes.CALL}{f_name}")

            if isinstance(f_args, str):
                try:
                    f_args = json.loads(f_args)
                except json.JSONDecodeError:
                    pass  # Keep as string if parsing fails

            if isinstance(f_args, dict):
                parts.append(self._format_value(f_args, escape_keys=False))
            else:
                parts.append(f"{{value:{self._escape(f_args)}}}")

            parts.append(Tokens.END_FUNC_CALL)

        parts.append(f"{Tokens.END_TURN}\n")
        return "".join(parts)

    def _build_tool_turn(self, message: Dict) -> str:
        tool_name = message.get("name", "unknown_tool")
        content = message.get("content", "")

        try:
            result_data = json.loads(content) if isinstance(content, str) else content
        except json.JSONDecodeError:
            result_data = content

        parts = [f"{Tokens.START_FUNC_RESP}{Prefixes.RESPONSE}{tool_name}"]

        if isinstance(result_data, dict):
            parts.append(self._format_value(result_data, escape_keys=False))
        else:
            parts.append(f"{{value:{self._escape(str(content))}}}")

        parts.append(Tokens.END_FUNC_RESP)
        return "".join(parts)

    @override
    def _format_prompt(self, messages, function):
        """
        Chat template source:
        https://huggingface.co/google/functiongemma-270m-it/blob/main/chat_template.jinja
        """
        prompt_buffer = []

        # System Turn
        prompt_buffer.append(self._build_system_turn(messages, function))

        remaining_messages = (
            messages[1:] if (messages and messages[0]["role"] == "system") else messages
        )

        for message in remaining_messages:
            role = message["role"]
            if role == "user":
                content = message.get("content", "").strip()
                prompt_buffer.append(
                    f"{Tokens.START_TURN}user\n{content}{Tokens.END_TURN}\n"
                )
            elif role == "assistant":
                prompt_buffer.append(self._build_model_turn(message))
            elif role == "tool":
                prompt_buffer.append(self._build_tool_turn(message))

        # Generation Trigger
        prompt_buffer.append(f"{Tokens.START_TURN}model\n")
        return "".join(prompt_buffer)

    def _parse_functiongemma_response(
        self, model_output: str
    ) -> List[Tuple[str, Dict[str, Any]]]:
        parsed_calls = []
        # Regex to find blocks between call tokens
        pattern = f"{Tokens.START_FUNC_CALL}(.*?){Tokens.END_FUNC_CALL}"
        matches = re.findall(pattern, model_output, re.DOTALL)

        for match_content in matches:
            match_content = match_content.strip()
            if not match_content.startswith(Prefixes.CALL):
                continue

            # Extract Function Name
            try:
                name_end_idx = match_content.index("{")
                func_name = match_content[len(Prefixes.CALL) : name_end_idx].strip()
                args_content = match_content[name_end_idx:]
            except ValueError:
                # No '{' found -> Function call with no args
                func_name = match_content[len(Prefixes.CALL) :].strip()
                parsed_calls.append((func_name, {}))
                continue

            # Parse Args
            parser = _FunctionGemmaResponseParser()
            final_args = parser.parse(args_content)
            parsed_calls.append((func_name, final_args))

        return parsed_calls

    @override
    def decode_ast(self, result, language, has_tool_call_tag):
        parsed_calls = self._parse_functiongemma_response(result)
        return [{name: args} for name, args in parsed_calls]

    @override
    def decode_execute(self, result, has_tool_call_tag):
        parsed_calls = self._parse_functiongemma_response(result)
        execution_list = []
        for func_name, args_dict in parsed_calls:
            params_str_list = [f"{k}={repr(v)}" for k, v in args_dict.items()]
            execution_list.append(f"{func_name}({', '.join(params_str_list)})")
        return execution_list


class _FunctionGemmaResponseParser:
    """
    Helper class to encapsulate the state machine logic for parsing
    FunctionGemma's output format.
    """

    def __init__(self):
        self.root: List[Any] = []
        self.stack: List[Any] = [self.root]
        self.key_stack: List[Optional[str]] = []
        self.buffer: List[str] = []
        self.pending_key: Any = None

    def parse(self, text: str) -> Dict[str, Any]:
        cursor = 0
        length = len(text)

        while cursor < length:
            # Handle <escape>...<escape> blocks
            if text.startswith(Tokens.ESCAPE, cursor):
                cursor = self._consume_escape_block(text, cursor)
                continue

            char = text[cursor]

            # Handle Structural Characters
            if char in "{[:]},":
                self._commit_buffer()
                self._handle_structure_char(char)
            else:
                self.buffer.append(char)

            cursor += 1

        self._commit_buffer()
        # Return first element of root if it exists and is a dict, else empty dict
        return self.root[0] if (self.root and isinstance(self.root[0], dict)) else {}

    def _consume_escape_block(self, text: str, start_idx: int) -> int:
        """Consumes an escaped block, adds value to container, returns new cursor position."""
        content_start = start_idx + len(Tokens.ESCAPE)
        esc_end = text.find(Tokens.ESCAPE, content_start)

        if esc_end == -1:
            # Malformed: consume rest as plain text
            val = text[start_idx:]
            new_cursor = len(text)
        else:
            val = text[content_start:esc_end]
            new_cursor = esc_end + len(Tokens.ESCAPE)

        if self.buffer:
            self._commit_buffer()

        self._add_value(val)
        return new_cursor

    def _handle_structure_char(self, char: str):
        """Processes structural characters to manage stack and containers."""
        if char == "{":
            new_dict: Dict[str, Any] = {}
            self._add_value(new_dict)
            self.stack.append(new_dict)
            self.key_stack.append(None)
            self.pending_key = None

        elif char == "}":
            if len(self.stack) > 1:
                self.stack.pop()
                if self.key_stack:
                    self.key_stack.pop()
            self.pending_key = None

        elif char == "[":
            new_list: List[Any] = []
            self._add_value(new_list)
            self.stack.append(new_list)
            self.pending_key = None

        elif char == "]":
            if len(self.stack) > 1:
                self.stack.pop()
            self.pending_key = None

        elif char == ":":
            final_key = None
            if self.buffer:
                final_key = "".join(self.buffer).strip()
                self.buffer.clear()
            elif (
                self.pending_key is not None
            ):  # Key was a previous value (likely quoted/escaped)
                final_key = str(self.pending_key)
                self.pending_key = None

            if (
                final_key is not None
                and isinstance(self.stack[-1], dict)
                and self.key_stack
            ):
                self.key_stack[-1] = final_key

        elif char == ",":
            self.pending_key = None

    def _commit_buffer(self):
        if not self.buffer:
            return

        raw_val = "".join(self.buffer).strip()
        self.buffer.clear()

        if raw_val:
            val = self._parse_primitive(raw_val)
            self._add_value(val)

    def _add_value(self, val: Any):
        """Adds a value to the current container (List or Dict)."""
        container = self.stack[-1]

        if isinstance(container, list):
            container.append(val)
        elif isinstance(container, dict):
            # Check if we have a pending key waiting for a value
            current_key = self.key_stack[-1] if self.key_stack else None
            if current_key is not None:
                container[current_key] = val
                self.key_stack[-1] = None  # Consume key
            else:
                self.pending_key = val

    @staticmethod
    def _parse_primitive(value_str: str) -> Union[str, int, float, bool, None]:
        if value_str == "null":
            return None
        if value_str == "true":
            return True
        if value_str == "false":
            return False

        try:
            return int(value_str)
        except ValueError:
            pass
        try:
            return float(value_str)
        except ValueError:
            pass
        return value_str
