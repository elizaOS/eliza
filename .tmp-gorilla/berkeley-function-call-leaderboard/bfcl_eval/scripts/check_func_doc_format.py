from keyword import kwlist

from bfcl_eval._llm_response_generation import parse_test_category_argument
from bfcl_eval.constants.eval_config import PROMPT_PATH
from bfcl_eval.utils import is_java, is_js, load_file

"""
This script checks for the correct format of the function description for test category in Python.

To run this script, use the following command:
```
cd berkeley-function-call-leaderboard/bfcl_eval/scripts
python check_func_doc_format.py
```

The section on checking correct type in the enum field is modified from the script that Chuanhui Zhang (@zhangch-ss) provided in https://github.com/ShishirPatil/gorilla/pull/826. Credit to him for the original idea and implementation. 


# Function Schema Validation Rules and Error Cases

## Top-Level Structure
The function description must be a dictionary with exactly three fields:
- `name`: Function name
- `description`: Function description
- `parameters`: Parameter information dictionary

## Parameters Object Structure
The `parameters` field must be a dictionary with exactly three fields:
- `type`: Must be "dict"
- `properties`: Dictionary of parameter definitions
- `required`: List of required parameter names

## Parameter Definition Rules

### Basic Parameter Structure
Each parameter in `properties` must be a dictionary containing:
- `type`: One of ["boolean", "array", "string", "integer", "float", "tuple", "any", "dict"]
- `description`: String describing the parameter

### Type-Specific Rules

#### For Array/Tuple Types
- Must include `items` field
- `items` must be a dictionary with single field `type`
- Cannot have `properties` field
- Item type must be one of the allowed types

#### For Dict Type
Must have either:
- `properties` field with nested parameter definitions, OR
- `additionalProperties` field with `type` specification
Cannot have `items` field

#### For Basic Types (boolean, string, integer, float, any)
- Cannot have `items` field
- Cannot have `properties` field

### Optional Fields

#### Enum Field
If present:
- Must be a list
- All values must match the parameter's declared type

#### Default Value
- Required for optional parameters (those not in `required` list)
- Must not exist for required parameters
- Must match the parameter's declared type
- For `any` type, no type checking is performed

### Parameter Naming
- Cannot use Python keywords as parameter names
- Cannot have duplicate parameter names

## Error Cases

1. Top-Level Structure Errors:
   - Input is not a dictionary
   - Missing required fields (name, description, parameters)
   - Extra fields present
   - Parameters field is not a dictionary

2. Parameters Object Errors:
   - Missing type/properties/required fields
   - Extra fields present
   - Required field is not a list
   - Required parameter listed but not in properties
   - Required parameter has default value
   - Optional parameter missing default value

3. Parameter Definition Errors:
   - Parameter value is not a dictionary
   - Missing type or description
   - Invalid type specified
   - Python keyword used as parameter name
   - Duplicate parameter names

4. Type-Specific Errors:
   - Array/tuple without items field
   - Array/tuple with properties field
   - Dict without properties or additionalProperties
   - Dict with items field
   - Non-array with items field
   - Non-dict with properties field

5. Enum Validation Errors:
   - Enum field is not a list
   - Enum values don't match declared type

6. Default Value Errors:
   - Default value type doesn't match declared type
   - Required parameter has default value
   - Optional parameter missing default value

"""

TYPE_MAP = {
    "int": int,
    "float": float,
    "bool": bool,
    "str": str,
    "list": list,
    "dict": dict,
    "tuple": tuple,
    "boolean": bool,
    "Boolean": bool,
    "string": str,
    "integer": int,
    "number": float,
    "array": list,
    "object": dict,
    "String": str,
}


AVAILABLE_TYPES = [
    "boolean",
    "array",
    "string",
    "integer",
    "float",
    "tuple",
    "any",
    "dict",
]  # python

entry_id_with_problem = set()
test_categories_total, test_filename_total = parse_test_category_argument(["single_turn"])


def format_checker(func_description: dict):
    if type(func_description) != dict:
        return False, "Function description must be a dictionary."

    if "name" not in func_description:
        return (
            False,
            "Function description must contain a field 'name' with the function name.",
        )

    if "description" not in func_description:
        return (
            False,
            "Function description must contain a field 'description' with the function description.",
        )

    if "parameters" not in func_description:
        return (
            False,
            "Function description must contain a field 'parameters' with the function parameters information.",
        )

    if len(func_description.keys()) != 3:
        return (
            False,
            "Function description must only contain 'name', 'description', and 'parameters' fields. Any other fields should be removed.",
        )

    parameters = func_description["parameters"]
    if type(parameters) != dict:
        return False, "Function 'parameters' field must be a dictionary."

    if "type" not in parameters:
        return (
            False,
            "Function 'parameters' field must contain a field 'type' with the value 'dict'.",
        )

    if "properties" not in parameters:
        return (
            False,
            "Function 'parameters' field must contain a field 'properties' with the function parameters.",
        )

    if "required" not in parameters:
        return (
            False,
            "Function 'parameters' field must contain a field 'required' that is a list of required parameters.",
        )

    if len(parameters.keys()) != 3:
        return (
            False,
            "Function 'parameters' field must only contain 'type', 'properties', and 'required' fields. Any other fields should be removed.",
        )

    properties = parameters["properties"]
    if type(properties) != dict:
        return (
            False,
            "The 'properties' field must be a dictionary. Each key in the dictionary should be a parameter name, and the value should be a dictionary describing the parameter (with the 'type' and 'description' fields).",
        )

    valid, message = param_checker(properties)
    if not valid:
        return False, message

    all_param = list(properties.keys())

    # Check for default and optional parameters
    required = parameters["required"]
    if type(required) != list:
        return False, "The 'required' field must be a list of required parameters."
    for param_name in required:
        if param_name not in all_param:
            return (
                False,
                f"The parameter '{param_name}' in the 'required' field is not present in the 'properties' field.",
            )
        if "default" in properties[param_name]:
            return (
                False,
                f"The parameter '{param_name}' is a required parameter and should not have a 'default' field.",
            )

    for param_name in all_param:
        if param_name not in required:
            if "default" not in properties[param_name]:
                return (
                    False,
                    f"The parameter '{param_name}' is an optional parameter and should have a 'default' field with the default value in the correct type.",
                )

    return True, "Function description is correctly formatted.✅"


def param_checker(properties: dict):
    if type(properties) != dict:
        return (
            False,
            "The 'properties' field must be a dictionary. Each key in the dictionary should be a parameter name, and the value should be a dictionary describing the parameter (with the 'type' and 'description' fields).",
        )
    if type(properties) != dict:
        return (
            False,
            "The 'properties' field must be a dictionary. Each key in the dictionary should be a parameter name, and the value should be a dictionary describing the parameter (with the 'type' and 'description' fields).",
        )

    all_param = []
    for param_name, param_details in properties.items():

        if param_name in kwlist:
            return (
                False,
                f"The parameter name '{param_name}' is a Python keyword and should not be used as a parameter name.",
            )

        if type(param_details) != dict:
            return (
                False,
                f"In parameter 'properties', the value for each parameter must be a dictionary describing the parameter (with the 'type' and 'description' fields). The parameter '{param_name}' is not a dictionary.",
            )

        if "type" not in param_details:
            return (
                False,
                f"The parameter '{param_name}' should contain a field 'type' with the parameter type. Allowed types are: {AVAILABLE_TYPES}. No other types are allowed.",
            )

        if "description" not in param_details:
            return (
                False,
                f"The parameter '{param_name}' should contain a field 'description' with a description of the parameter.",
            )

        if param_name in all_param:
            return (
                False,
                f"The parameter '{param_name}' is repeated. Each parameter should only appear once.",
            )

        if param_details["type"] not in AVAILABLE_TYPES:
            return (
                False,
                f"The parameter '{param_name}' has an invalid type '{param_details['type']}'. Allowed types are: {AVAILABLE_TYPES}. No other types are allowed.",
            )

        if param_details["type"] == "dict":
            if "properties" in param_details:
                dict_properties = param_details["properties"]
                valid, message = param_checker(dict_properties)

                if not valid:
                    return (
                        False,
                        f"Problem in the inner nested field for the parameter '{param_name}': {message} Note that the outer parameter is of type 'dict', and so the 'properties' field is a inner nested dictionary with the sub-parameters details. Be careful with the structure and where the issue is.",
                    )

                if "items" in param_details:
                    return (
                        False,
                        f"The parameter '{param_name}' is of type 'dict' and should not contain a field 'items'.",
                    )

            elif "additionalProperties" in param_details:
                if (
                    type(param_details["additionalProperties"]) != dict
                    or "type" not in param_details["additionalProperties"]
                ):
                    return (
                        False,
                        f"The 'additionalProperties' field for parameter '{param_name}' must be a dictionary with a 'type' field that describes the type of the key-value pairs in it.",
                    )

            else:
                return (
                    False,
                    f"The parameter '{param_name}' is of type 'dict' and should contain either 'properties' or 'additionalProperties' field to specify the sub-parameters details.",
                )

        elif param_details["type"] == "array" or param_details["type"] == "tuple":
            if "items" not in param_details:
                return (
                    False,
                    f"The parameter '{param_name}' is of type 'array' and should contain a field 'items' with the description of the items in the array.",
                )

            list_properties = param_details["items"]
            if type(list_properties) != dict:
                return (
                    False,
                    f"Since the parameter '{param_name}' is of type 'array', the 'items' field for the parameter '{param_name}' should be a dictionary with only one key 'type' that describes the type of the items in the {param_details['type']}.",
                )

            if "type" not in list_properties:
                return (
                    False,
                    f"The 'items' field for the parameter '{param_name}' should be a dictionary that must contain a key 'type' that describes the type of the items in the array.",
                )

            if list_properties["type"] not in AVAILABLE_TYPES:
                return (
                    False,
                    f"The 'items' field for the parameter '{param_name}' has an invalid 'type' value '{list_properties['type']}'. Allowed types are: {AVAILABLE_TYPES}. No other types are allowed.",
                )

            if "properties" in param_details:
                return (
                    False,
                    f"The parameter '{param_name}' is of type 'array' and should not contain a field 'properties'.",
                )
        else:
            if "items" in param_details:
                return (
                    False,
                    f"The parameter '{param_name}' is not of type 'array' and should not contain a field 'items'.",
                )

            if "properties" in param_details:
                return (
                    False,
                    f"The parameter '{param_name}' is not of type 'dict' and should not contain a field 'properties'.",
                )

        if "enum" in param_details:
            if type(param_details["enum"]) != list:
                return (
                    False,
                    f"The 'enum' field for the parameter '{param_name}' must be a list of allowed values for the parameter.",
                )

            for enum_value in param_details["enum"]:
                if type(enum_value) != TYPE_MAP[param_details["type"]]:
                    return (
                        False,
                        f"The enum value {repr(enum_value)} is not of type {param_details['type']}. Expected {TYPE_MAP[param_details['type']]}, got {type(enum_value)}.",
                    )

        if "default" in param_details:
            if (
                param_details["type"] != "any"
                and param_details["default"] is not None
                and type(param_details["default"]) != TYPE_MAP[param_details["type"]]
            ):
                return (
                    False,
                    f"The default value {repr(param_details['default'])} for the parameter '{param_name}' is not of type {param_details['type']}. Expected {TYPE_MAP[param_details['type']]}, got {type(param_details['default'])}.",
                )

        all_param.append(param_name)

    return True, "Parameter is correctly formatted."


for test_category, file_path in zip(test_categories_total, test_filename_total):
    # We only care about Python test cases; Java and JavaScript test cases have different rules
    if is_java(test_category) or is_js(test_category):
        continue
    dataset_data = load_file(PROMPT_PATH / file_path)
    for test_entry in dataset_data:
        for function in test_entry["function"]:
            valid, message = format_checker(function)
            if not valid:
                print("--------------------")
                print(f"Entry ID: {test_entry['id']}")
                print(f"Function: {function['name']}")
                print(f"Error: {message}")
                entry_id_with_problem.add(test_entry["id"])


print("--------------------")
print(f"The following {len(entry_id_with_problem)} entries have problems:")
print(entry_id_with_problem)
