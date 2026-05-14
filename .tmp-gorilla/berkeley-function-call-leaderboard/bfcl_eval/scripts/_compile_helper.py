import inspect
import json
import re
from typing import Dict, Union, Optional

TYPE_MAPPING = {
    "str": "string",
    "int": "integer",
    "float": "float",
    "bool": "boolean",
    "any": "any",
    "dict": "dict",
    "list": "array",
    "tuple": "tuple",
}

# Type Conversions
def convert_type_to_json_compatible(type_name: str) -> str:
    return TYPE_MAPPING.get(type_name.lower(), "any")

def parse_type_string(type_str: str) -> dict:
    """
    Parses a type string and returns a dict with type information.
    """
    if type_str.startswith("Optional[") and type_str.endswith("]"):
        type_str = type_str[len("Optional[") : -1]

    if type_str.startswith("Union[") and type_str.endswith("]"):
        union_types = type_str[len("Union[") : -1].split(", ")
        if "NoneType" in union_types or "None" in union_types:
            union_types = [t for t in union_types if t != "NoneType" and t != "None"]
        if len(union_types) == 1:
            return parse_type_string(union_types[0])
        else:
            return {"type": "any"}

    list_match = re.match(r"(?:List|list)\[(.+)\]", type_str)
    if list_match:
        inner_type_str = list_match.group(1)
        items_type = parse_type_string(inner_type_str)
        return {"type": "array", "items": items_type}

    tuple_match = re.match(r"(?:Tuple|tuple)\[(.+)\]", type_str)
    if tuple_match:
        inner_type_str = tuple_match.group(1)
        inner_types_strs = [t.strip() for t in inner_type_str.split(",")]
        items_types = [parse_type_string(t) for t in inner_types_strs]
        return {"type": "array", "items": items_types}

    dict_match = re.match(r"(?:Dict|dict)\[(.+),\s*(.+)\]", type_str)
    if dict_match:
        key_type_str, value_type_str = dict_match.groups()
        key_type = convert_type_to_json_compatible(key_type_str)
        value_type = parse_type_string(value_type_str)
        if key_type != "string":
            key_type = "string"
        return {"type": "dict", "additionalProperties": value_type}

    base_type = convert_type_to_json_compatible(type_str)
    return {"type": base_type}

def parse_docstring(docstring: str) -> Dict[str, Union[str, dict]]:
    description = ""
    parameters = {}
    response = {}
    lines = docstring.strip().split("\n")
    current_section = None
    indent_levels = []
    base_indent = None
    parent_param = None

    for idx, line in enumerate(lines):
        original_line = line
        line = line.rstrip()
        stripped_line = line.lstrip()
        current_indent = len(line) - len(stripped_line)

        if stripped_line.startswith("Args:"):
            current_section = "parameters"
            continue
        elif stripped_line.startswith("Returns:"):
            current_section = "response"
            continue

        if current_section is None:
            description += stripped_line + " "
        elif current_section == "parameters":
            match = re.match(r"(\w+)\s*\(([^)]+)\):\s*(.+)", stripped_line)
            if match:
                param_name, param_type_str, param_desc = match.groups()
                param_desc = (
                    param_desc.replace("[Required]", "").replace("[Optional]", "").strip()
                )
                type_info = parse_type_string(param_type_str)
                param_entry = type_info
                param_entry["description"] = param_desc
                if type_info["type"] == "dict":
                    param_entry["properties"] = {}
                    parent_param = param_name  # Track the parent parameter for nested dict entries
                parameters[param_name] = param_entry
            else:
                # Handle nested parameters in dicts if they start with a dash
                nested_match = re.match(r"-\s*(\w+)\s*\(([^)]+)\):\s*(.+)", stripped_line)
                if nested_match and parent_param:
                    nested_name, nested_type_str, nested_desc = nested_match.groups()
                    nested_desc = nested_desc.replace("[Optional]", "").strip()
                    nested_type_info = parse_type_string(nested_type_str)
                    nested_param_entry = nested_type_info
                    nested_param_entry["description"] = nested_desc
                    # Add nested property to the parent parameter
                    parameters[parent_param]["properties"][nested_name] = nested_param_entry
                elif parameters:
                    last_param = list(parameters.keys())[-1]
                    parameters[last_param]["description"] += " " + stripped_line
        elif current_section == "response":
            if not stripped_line:
                continue

            match = re.match(r"-?\s*(\w+)\s*\(([^)]+)\):\s*(.+)", stripped_line)
            if match:
                name, type_str, desc = match.groups()
                type_info = parse_type_string(type_str)
                desc = desc.strip()
                new_property = {"type": type_info.get("type", "any"), "description": desc}
                if "items" in type_info:
                    new_property["items"] = type_info["items"]
                if "properties" in type_info:
                    new_property["properties"] = type_info["properties"]
                if "additionalProperties" in type_info:
                    new_property["additionalProperties"] = type_info["additionalProperties"]

                if base_indent is None:
                    base_indent = current_indent

                # assume 4 spaces for each indent
                level = (current_indent - base_indent) // 4

                while len(indent_levels) > level:
                    indent_levels.pop()

                if not indent_levels:
                    response[name] = new_property
                    indent_levels.append(response[name])
                else:
                    parent = indent_levels[-1]
                    if parent.get("type") == "array":
                        if "items" not in parent:
                            parent["items"] = {}
                        if "properties" not in parent["items"]:
                            parent["items"]["properties"] = {}
                        parent["items"]["properties"][name] = new_property
                        indent_levels.append(parent["items"]["properties"][name])
                    else:
                        if "properties" not in parent:
                            parent["properties"] = {}
                        parent["properties"][name] = new_property
                        indent_levels.append(parent["properties"][name])
            else:
                if indent_levels:
                    current_property = indent_levels[-1]
                    current_property["description"] += " " + stripped_line
                else:
                    if "description" in response:
                        response["description"] += " " + stripped_line
                    else:
                        response["description"] = stripped_line

    return {
        "description": description.strip(),
        "parameters": {"type": "dict", "properties": parameters},
        "response_properties": response,
    }

def function_to_json(func) -> str:
    func_name = func.__name__
    docstring = func.__doc__

    if not docstring:
        raise ValueError("Function must have a docstring.")

    parsed_data = parse_docstring(docstring)

    # Response is always a dictionary
    response_structure = {"type": "dict", "properties": parsed_data["response_properties"]}

    json_representation = {
        "name": func_name,
        "description": parsed_data["description"],
        "parameters": parsed_data["parameters"],
        "response": response_structure,
    }

    # Adjust parameters based on function signature
    sig = inspect.signature(func)
    required_params = []
    for param_name, param in sig.parameters.items():
        if param_name == "self" or param_name == "cls":
            continue

        if param.default is inspect.Parameter.empty:
            required_params.append(param_name)
        else:
            if param_name in json_representation["parameters"]["properties"]:
                default_value = param.default
                param_type = json_representation["parameters"]["properties"][param_name][
                    "type"
                ]
                if param_type == "string":
                    default_value = str(default_value)
                elif param_type == "integer":
                    default_value = int(default_value)
                elif param_type == "number":
                    default_value = float(default_value)
                elif param_type == "boolean":
                    default_value = bool(default_value)
                json_representation["parameters"]["properties"][param_name][
                    "default"
                ] = default_value

    # Always include 'required', even if it's empty
    json_representation["parameters"]["required"] = required_params

    return json.dumps(json_representation)

# PROOF OF CONCEPT TEST

class TestAPI:
    # Amitoj Note: PASTE WHICHEVER FUNCTION YOU WANT TO CHECK HERE AND REPLACE
    def edit_ticket(
        self, ticket_id: int, updates: Dict[str, Optional[Union[str, int]]]
    ) -> Dict[str, str]:
        """
        Modify the details of an existing ticket.

        Args:
            ticket_id (int): ID of the ticket to be changed.
            updates (Dict): Dictionary containing the fields to be updated.
                - title (str): [Optional] New title for the ticket.
                - description (str): [Optional] New description for the ticket.
                - status (str): [Optional] New status for the ticket.
                - priority (int): [Optional] New priority for the ticket.

        Returns:
            status (str): Status of the update operation.
        """
        pass

# test_api = TestAPI()
# print(function_to_json(test_api.edit_ticket))