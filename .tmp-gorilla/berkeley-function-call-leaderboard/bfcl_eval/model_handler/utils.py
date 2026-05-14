import ast
import builtins
import copy
import json
import operator
import re
from functools import reduce
from typing import TYPE_CHECKING, Callable, List, Optional, Type, Union

from bfcl_eval.constants.default_prompts import *
from bfcl_eval.constants.enums import ModelStyle, ReturnFormat
from bfcl_eval.constants.type_mappings import GORILLA_TO_OPENAPI
from bfcl_eval.model_handler.parser.java_parser import parse_java_function_call
from bfcl_eval.model_handler.parser.js_parser import parse_javascript_function_call
from bfcl_eval.model_handler.parser.json_parser import parse_json_function_call
from bfcl_eval.model_handler.parser.xml_parser import (
    parse_concise_xml_function_call,
    parse_verbose_xml_function_call,
)
from bfcl_eval.utils import *
from tenacity import (
    retry,
    retry_if_exception_message,
    retry_if_exception_type,
    wait_random_exponential,
)

if TYPE_CHECKING:
    from bfcl_eval.eval_checker.multi_turn_eval.func_source_code.memory_api_metaclass import (
        MemoryAPI,
    )


def _cast_to_openai_type(properties, mapping):
    for key, value in properties.items():
        if "type" not in value:
            properties[key]["type"] = "string"
        else:
            var_type = value["type"]
            if mapping == GORILLA_TO_OPENAPI and var_type == "float":
                properties[key]["format"] = "float"
                properties[key]["description"] += " This is a float type value."
            if var_type in mapping:
                properties[key]["type"] = mapping[var_type]
            else:
                properties[key]["type"] = "string"

        # Currently support:
        # - list of any
        # - list of list of any
        # - list of dict
        # - list of list of dict
        # - dict of any

        if properties[key]["type"] == "array" or properties[key]["type"] == "object":
            if "properties" in properties[key]:
                properties[key]["properties"] = _cast_to_openai_type(
                    properties[key]["properties"], mapping
                )
            elif "items" in properties[key]:
                properties[key]["items"]["type"] = mapping[properties[key]["items"]["type"]]
                if (
                    properties[key]["items"]["type"] == "array"
                    and "items" in properties[key]["items"]
                ):
                    properties[key]["items"]["items"]["type"] = mapping[
                        properties[key]["items"]["items"]["type"]
                    ]
                elif (
                    properties[key]["items"]["type"] == "object"
                    and "properties" in properties[key]["items"]
                ):
                    properties[key]["items"]["properties"] = _cast_to_openai_type(
                        properties[key]["items"]["properties"], mapping
                    )
    return properties


def convert_to_tool(functions, mapping, model_style):
    functions = copy.deepcopy(functions)
    oai_tool = []
    for item in functions:
        if "." in item["name"] and model_style in [
            ModelStyle.OPENAI_COMPLETIONS,
            ModelStyle.OPENAI_RESPONSES,
            ModelStyle.MISTRAL,
            ModelStyle.GOOGLE,
            ModelStyle.OSSMODEL,
            ModelStyle.ANTHROPIC,
            ModelStyle.COHERE,
            ModelStyle.AMAZON,
            ModelStyle.NOVITA_AI,
        ]:
            # OAI does not support "." in the function name so we replace it with "_". ^[a-zA-Z0-9_-]{1,64}$ is the regex for the name.
            item["name"] = re.sub(r"\.", "_", item["name"])

        item["parameters"]["type"] = "object"
        item["parameters"]["properties"] = _cast_to_openai_type(
            item["parameters"]["properties"], mapping
        )

        if model_style == ModelStyle.ANTHROPIC:
            item["input_schema"] = item["parameters"]
            del item["parameters"]

        if model_style == ModelStyle.AMAZON:
            item["inputSchema"] = {"json": item["parameters"]}
            del item["parameters"]

        if model_style in [
            ModelStyle.GOOGLE,
            ModelStyle.WRITER,
        ]:
            # Remove fields that are not supported by Gemini or Palmyra.
            # No `optional` field in function schema.
            if "optional" in item["parameters"]:
                del item["parameters"]["optional"]
            for params in item["parameters"]["properties"].values():
                if "description" not in params:
                    params["description"] = ""
                # No `default` field in GOOGLE or Palmyra's schema.
                if "default" in params:
                    params["description"] += f" Default is: {str(params['default'])}."
                    del params["default"]
                # No `optional` field in parameter schema as well.
                if "optional" in params:
                    params["description"] += f" Optional: {str(params['optional'])}."
                    del params["optional"]
                # No `required` field in parameter schema as well.
                if "required" in params:
                    params["description"] += f" Required: {str(params['required'])}."
                    del params["required"]
                # No `maximum` field.
                if "maximum" in params:
                    params["description"] += f" Maximum value: {str(params['maximum'])}."
                    del params["maximum"]
                # No `minItems` field.
                if "minItems" in params:
                    params[
                        "description"
                    ] += f" Minimum number of items: {str(params['minItems'])}."
                    del params["minItems"]
                # No `maxItems` field.
                if "maxItems" in params:
                    params[
                        "description"
                    ] += f" Maximum number of items: {str(params['maxItems'])}."
                    del params["maxItems"]
                # No `additionalProperties` field.
                if "additionalProperties" in params:
                    params[
                        "description"
                    ] += f" Additional properties: {str(params['additionalProperties'])}."
                    del params["additionalProperties"]
                # For Gemini, only `enum` field when the type is `string`.
                # For Palmyra, `enum` field is not supported.
                if "enum" in params and (
                    model_style == ModelStyle.WRITER
                    or (model_style == ModelStyle.GOOGLE and params["type"] != "string")
                ):
                    params["description"] += f" Enum values: {str(params['enum'])}."
                    del params["enum"]
                # No `format` when type is `string`
                if "format" in params and params["type"] == "string":
                    params["description"] += f" Format: {str(params['format'])}."
                    del params["format"]

        # Process the return field
        if "response" in item:
            if model_style in [
                ModelStyle.ANTHROPIC,
                ModelStyle.GOOGLE,
                ModelStyle.FIREWORK_AI,
                ModelStyle.WRITER,
                ModelStyle.AMAZON,
                ModelStyle.NOVITA_AI,
            ]:
                item[
                    "description"
                ] += f" The response field has the following schema: {json.dumps(item['response'])}"
                del item["response"]

        if model_style in [
            ModelStyle.ANTHROPIC,
            ModelStyle.GOOGLE,
            ModelStyle.OSSMODEL,
        ]:
            oai_tool.append(item)
        elif model_style in [ModelStyle.OPENAI_RESPONSES]:
            item["type"] = "function"
            oai_tool.append(item)
        elif model_style in [
            ModelStyle.COHERE,
            ModelStyle.OPENAI_COMPLETIONS,
            ModelStyle.MISTRAL,
            ModelStyle.FIREWORK_AI,
            ModelStyle.WRITER,
            ModelStyle.NOVITA_AI,
        ]:
            oai_tool.append({"type": "function", "function": item})
        elif model_style == ModelStyle.AMAZON:
            oai_tool.append({"toolSpec": item})

    return oai_tool


def convert_to_function_call(function_call_list):
    if type(function_call_list) == dict:
        function_call_list = [function_call_list]
    # function_call_list is of type list[dict[str, str]] or list[dict[str, dict]]
    execution_list = []
    for function_call in function_call_list:
        for key, value in function_call.items():
            if type(value) == str:
                value = json.loads(value)
            execution_list.append(
                f"{key}({','.join([f'{k}={repr(v)}' for k,v in value.items()])})"
            )

    return execution_list


def convert_value(value, type_str):
    """Convert a string value into its appropriate Python data type based on the provided type string.

    Arg:
        value: the value to convert
        type_str: the type to convert the value to

    Returns:
        The value converted into the requested type or the original value
        if the conversion failed.
    """

    if type_str in ("list", "dict"):
        try:
            return ast.literal_eval(value)
        except:
            return value

    type_class = getattr(builtins, type_str)
    try:
        return type_class(value)
    except ValueError:
        return value


def ast_parse(
    input_str: str,
    language: ReturnFormat = ReturnFormat.PYTHON,
    has_tool_call_tag: bool = False,
) -> list[dict]:
    if has_tool_call_tag:
        match = re.search(r"<TOOLCALL>(.*?)</TOOLCALL>", input_str, re.DOTALL)
        if match:
            input_str = match.group(1).strip()
        else:
            raise ValueError(f"No tool call tag found in input string: {input_str}")

    if language == ReturnFormat.PYTHON:
        # We only want to remove wrapping quotes that could have been added by the model.
        cleaned_input = input_str.strip().strip("'")
        parsed = ast.parse(cleaned_input, mode="eval")
        extracted = []
        if isinstance(parsed.body, ast.Call):
            extracted.append(resolve_ast_call(parsed.body))
        else:
            for elem in parsed.body.elts:
                assert isinstance(elem, ast.Call)
                extracted.append(resolve_ast_call(elem))
        return extracted

    elif language == ReturnFormat.JAVA:
        # Remove the [ and ] from the string
        # Note: This is due to legacy reasons, we should fix this in the future.
        return parse_java_function_call(input_str[1:-1])

    elif language == ReturnFormat.JAVASCRIPT:
        # Note: Same as above, we should fix this in the future.
        return parse_javascript_function_call(input_str[1:-1])

    elif language == ReturnFormat.VERBOSE_XML:
        # Remove ```xml and anything before/after XML
        match = re.search(r"<functions>(.*?)</functions>", input_str, re.DOTALL)
        if not match:
            raise ValueError(
                f"No XML function call found in input string: {input_str}. Missing <functions> tag."
            )
        return parse_verbose_xml_function_call(match.group(0))

    elif language == ReturnFormat.CONCISE_XML:
        # Remove anything before/after <functions> and </functions>
        match = re.search(r"<functions>(.*?)</functions>", input_str, re.DOTALL)
        if not match:
            raise ValueError(
                f"No XML function call found in input string: {input_str}. Missing <functions> tag."
            )
        return parse_concise_xml_function_call(match.group(0))

    elif language == ReturnFormat.JSON:
        json_match = re.search(r"\[.*\]", input_str, re.DOTALL)
        if json_match:
            input_str = json_match.group(0)
        return parse_json_function_call(input_str)

    else:
        raise NotImplementedError(f"Unsupported language: {language}")


def resolve_ast_call(elem):
    # Handle nested attributes for deeply nested module paths
    func_parts = []
    func_part = elem.func
    while isinstance(func_part, ast.Attribute):
        func_parts.append(func_part.attr)
        func_part = func_part.value
    if isinstance(func_part, ast.Name):
        func_parts.append(func_part.id)
    func_name = ".".join(reversed(func_parts))
    args_dict = {}
    for arg in elem.keywords:
        output = resolve_ast_by_type(arg.value)
        args_dict[arg.arg] = output
    return {func_name: args_dict}


def resolve_ast_by_type(value):
    if isinstance(value, ast.Constant):
        if value.value is Ellipsis:
            output = "..."
        else:
            output = value.value
    elif isinstance(value, ast.UnaryOp):
        output = -value.operand.value
    elif isinstance(value, ast.List):
        output = [resolve_ast_by_type(v) for v in value.elts]
    elif isinstance(value, ast.Dict):
        output = {
            resolve_ast_by_type(k): resolve_ast_by_type(v)
            for k, v in zip(value.keys, value.values)
        }
    elif isinstance(
        value, ast.NameConstant
    ):  # Added this condition to handle boolean values
        output = value.value
    elif isinstance(
        value, ast.BinOp
    ):  # Added this condition to handle function calls as arguments
        output = eval(ast.unparse(value))
    elif isinstance(value, ast.Name):
        output = value.id
    elif isinstance(value, ast.Call):
        if len(value.keywords) == 0:
            output = ast.unparse(value)
        else:
            output = resolve_ast_call(value)
    elif isinstance(value, ast.Tuple):
        output = tuple(resolve_ast_by_type(v) for v in value.elts)
    elif isinstance(value, ast.Lambda):
        output = eval(ast.unparse(value.body[0].value))
    elif isinstance(value, ast.Ellipsis):
        output = "..."
    elif isinstance(value, ast.Subscript):
        try:
            output = ast.unparse(value.body[0].value)
        except:
            output = ast.unparse(value.value) + "[" + ast.unparse(value.slice) + "]"
    else:
        raise Exception(f"Unsupported AST type: {type(value)}")
    return output


# TODO: consider moving this step to pipeline instead of in each model handler
def system_prompt_pre_processing_chat_model(
    prompts: list[dict], function_docs: list[dict], test_entry_id: str
) -> list[dict]:
    """
    Add a system prompt to the chat model to instruct the model on the available functions and the expected response format.
    If the prompts list already contains a system prompt, append the additional system prompt content to the existing system prompt.
    """
    assert type(prompts) == list

    prompt_format = extract_prompt_format_from_id(test_entry_id)

    system_prompt = formulate_system_prompt(
        format_sensitivity_config=prompt_format, functions=function_docs
    )

    # System prompt must be in the first position
    # If the question comes with a system prompt, append its content at the end of the chat template.
    if prompts[0]["role"] == "system":
        prompts[0]["content"] = system_prompt + "\n\n" + prompts[0]["content"]
    # Otherwise, use the system prompt template to create a new system prompt.
    else:
        prompts.insert(
            0,
            {"role": "system", "content": system_prompt},
        )

    return prompts


def convert_system_prompt_into_user_prompt(prompts: list[dict]) -> list[dict]:
    """
    Some FC models doesn't support system prompt in the message field, so we turn it into user prompt
    """
    for prompt in prompts:
        if prompt["role"] == "system":
            prompt["role"] = "user"
    return prompts


def combine_consecutive_user_prompts(prompts: list[dict]) -> list[dict]:
    """
    Some models require the prompt to be alternating between user and assistant.
    We combine consecutive user prompts into a single user prompt.
    """
    combined_prompts = []
    for prompt in prompts:
        if (
            prompt["role"] == "user"
            and combined_prompts
            and combined_prompts[-1]["role"] == "user"
        ):
            combined_prompts[-1]["content"] += "\n\n" + prompt["content"]
        else:
            combined_prompts.append(prompt)

    return combined_prompts


# TODO: Re-organize this file to make it more readable and maintainable
def extract_system_prompt(prompts: list[dict]) -> str:
    for i, prompt in enumerate(prompts):
        if prompt["role"] == "system":
            system_prompt = prompt["content"]
            del prompts[i]
            return system_prompt
    return None


def extract_last_user_message(prompts: list[dict], user_role_name: str = "user") -> dict:
    for i in range(len(prompts) - 1, -1, -1):
        if prompts[i]["role"] == user_role_name:
            last_user_message = prompts[i]
            del prompts[i]
            return last_user_message
    return "User did not specify a query."


#### utils for multi-turn ####


def format_execution_results_prompting(
    inference_data: dict, execution_results: list[str], model_response_data: dict
) -> str:
    # Add the execution results to one single user message
    tool_results = []
    for execution_result, decoded_model_response in zip(
        execution_results, model_response_data["model_responses_decoded"]
    ):
        tool_results.append(
            {"role": "tool", "name": decoded_model_response, "content": execution_result}
        )

    return repr(tool_results)


def default_decode_ast_prompting(
    result: str,
    language: ReturnFormat = ReturnFormat.PYTHON,
    has_tool_call_tag: bool = False,
) -> list[dict]:
    result = result.strip("`\n ")
    if not result.startswith("["):
        result = "[" + result
    if not result.endswith("]"):
        result = result + "]"
    decoded_output = ast_parse(result, language, has_tool_call_tag)
    return decoded_output


def default_decode_execute_prompting(
    result: str, has_tool_call_tag: bool = False
) -> list[str]:
    # Note: For execute, there are only Python entries, so we don't need to check the language.
    result = result.strip("`\n ")
    if not result.startswith("["):
        result = "[" + result
    if not result.endswith("]"):
        result = result + "]"
    decoded_output = ast_parse(
        result, language=ReturnFormat.PYTHON, has_tool_call_tag=has_tool_call_tag
    )
    return decoded_output_to_execution_list(decoded_output)


def parse_nested_value(value):
    """
    Parse a potentially nested value from the AST output.

    Args:
        value: The value to parse, which could be a nested dictionary, which includes another function call, or a simple value.

    Returns:
        str: A string representation of the value, handling nested function calls and nested dictionary function arguments.
    """
    if isinstance(value, dict):
        # Check if the dictionary represents a function call (i.e., the value is another dictionary or complex structure)
        if all(isinstance(v, dict) for v in value.values()):
            func_name = list(value.keys())[0]
            args = value[func_name]
            args_str = ", ".join(f"{k}={parse_nested_value(v)}" for k, v in args.items())
            return f"{func_name}({args_str})"
        else:
            # If it's a simple dictionary, treat it as key-value pairs
            return (
                "{"
                + ", ".join(f"'{k}': {parse_nested_value(v)}" for k, v in value.items())
                + "}"
            )
    return repr(value)


def decoded_output_to_execution_list(decoded_output: list[dict]) -> list[str]:
    """
    Convert decoded output to a list of executable function calls.

    Args:
        decoded_output (list): A list of dictionaries representing function calls.

    Returns:
        list: A list of strings, each representing an executable function call.
    """
    execution_list = []
    for function_call in decoded_output:
        for key, value in function_call.items():
            args_str = ", ".join(f"{k}={parse_nested_value(v)}" for k, v in value.items())
            execution_list.append(f"{key}({args_str})")
    return execution_list


def retry_with_backoff(
    error_type: Optional[Union[Type[Exception], List[Type[Exception]]]] = None,
    error_message_pattern: Optional[str] = None,
    min_wait: int = 6,
    max_wait: int = 120,
    **kwargs,
) -> Callable:
    """
    Decorator to retry a function with exponential backoff based on specified error types or result conditions.

    Note:
        At least one of `error_type` or `error_message_pattern` must be provided.
        If both `error_type` and `error_message_pattern` are provided, the retry will occur if either condition is met.

    Args:
        error_type ([Union[Type[Exception], List[Type[Exception]]]], optional): The exception type to retry on. Supports one exception, or a list of exceptions.
        error_message_pattern (str, optional):
            A regex pattern to match against the exception message to retry on.
            This is useful when the user wants to retry based on the exception message,
            especially if the exception raised is too broad.
        min_wait (int, optional): Minimum wait time in seconds for the backoff.
        max_wait (int, optional): Maximum wait time in seconds for the backoff.
        **kwargs: Additional keyword arguments for the `tenacity.retry` decorator, such as `stop`, `reraise`, etc.

    Returns:
        Callable: The decorated function with retry logic applied.
    """

    def decorator(func: Callable) -> Callable:
        # Collect retry conditions based on provided parameters
        conditions = []
        if error_type is not None:
            if isinstance(error_type, list):
                for et in error_type:
                    conditions.append(retry_if_exception_type(et))
            else:
                conditions.append(retry_if_exception_type(error_type))
        if error_message_pattern is not None:
            conditions.append(retry_if_exception_message(match=error_message_pattern))

        if not conditions:
            raise ValueError("Either error_type or retry_condition must be provided.")

        # Combine all conditions using logical OR
        retry_policy = reduce(operator.or_, conditions)

        @retry(
            wait=wait_random_exponential(min=min_wait, max=max_wait),
            retry=retry_policy,
            before_sleep=lambda retry_state: print(
                f"Attempt {retry_state.attempt_number} failed. "
                f"Sleeping for {retry_state.next_action.sleep:.2f} seconds before retrying... "
                f"Error: {retry_state.outcome.exception()}"
            ),
            **kwargs,
        )
        def wrapped(*args, **inner_kwargs):
            return func(*args, **inner_kwargs)

        return wrapped

    return decorator


#### utils for memory category ####


def add_memory_instruction_system_prompt(
    prompts: list[list[dict]],
    test_category: str,
    scenario: str,
    memory_backend_instance: "MemoryAPI",
) -> list[list[dict]]:
    """
    Memory categories requires a system prompt that instructs the model on how to use the memory backend, and also provides the content in core memory (if applicable).
    The input for prompts is a list of list of dictionaries, where each outer list item represents a conversation turn, and each inner list item represents a message in that turn.
    System prompt are added as the first message in the first turn of the conversation.
    """
    assert len(prompts) >= 1

    scenario_setting = MEMORY_AGENT_SETTINGS[scenario]

    memory_content = memory_backend_instance._dump_core_memory_to_context()

    if "rec_sum" in test_category:
        system_prompt_template = MEMORY_BACKEND_INSTRUCTION_UNIFIED
    else:
        system_prompt_template = MEMORY_BACKEND_INSTRUCTION_CORE_ARCHIVAL

    system_prompt = system_prompt_template.format(
        scenario_setting=scenario_setting, memory_content=memory_content
    )

    # System prompt must be in the first position
    # If the question comes with a system prompt, append its content at the end of the chat template.
    first_turn_prompts = prompts[0]
    if first_turn_prompts[0]["role"] == "system":
        first_turn_prompts[0]["content"] = (
            system_prompt + "\n\n" + first_turn_prompts[0]["content"]
        )
    # Otherwise, use the system prompt template to create a new system prompt.
    else:
        first_turn_prompts.insert(
            0,
            {"role": "system", "content": system_prompt},
        )

    return prompts


#### Utils for Format Sensitivity ####


def formulate_system_prompt(format_sensitivity_config: str, functions: list[dict]) -> str:
    """
    Formulate the default system prompt based on the provided parameters.
    """
    (
        return_format,
        has_tool_call_tag,
        function_doc_format,
        prompt_format,
        prompt_style,
    ) = parse_prompt_variation_params(format_sensitivity_config)

    formatted_function_doc = format_function_doc(functions, function_doc_format)

    prompt_template = PROMPT_TEMPLATE_MAPPING[prompt_format]
    style_template = PROMPT_STYLE_TEMPLATES[prompt_style]

    persona = style_template["persona"]
    task = style_template["task"]
    if has_tool_call_tag:
        tool_call_format = style_template["tool_call_with_tag"].format(
            output_format=OUTPUT_FORMAT_MAPPING[return_format],
            param_types=PARAM_TYPE_MAPPING[return_format],
        )
    else:
        tool_call_format = style_template["tool_call_no_tag"].format(
            output_format=OUTPUT_FORMAT_MAPPING[return_format],
            param_types=PARAM_TYPE_MAPPING[return_format],
        )
    multiturn_behavior = style_template["multiturn_behavior"]
    available_tools = style_template["available_tools"].format(
        format=function_doc_format,
        functions=formatted_function_doc,
    )

    system_prompt = prompt_template.format(
        persona=persona,
        task=task,
        tool_call_format=tool_call_format,
        multiturn_behavior=multiturn_behavior,
        available_tools=available_tools,
    )

    return system_prompt


def format_function_doc(functions: list[dict], function_doc_format: str) -> str:
    """
    Format the function documentation based on the specified format.
    """

    if function_doc_format == "xml":
        functions = _generate_function_doc_xml(functions)

    elif function_doc_format == "python":
        functions = _generate_function_doc_python(functions)

    elif function_doc_format == "json":
        functions = json.dumps(functions, indent=4)

    else:
        raise ValueError(f"Invalid function doc format: {function_doc_format}")

    return functions


def _generate_function_doc_xml(functions: list[dict]) -> str:
    """
    Generate the function documentation in XML format.
    """

    def _param_xml(
        name: str, meta: dict, required_set: Optional[list[str]], indent_lvl: int = 2
    ) -> str:
        """Recursively render a param and its nested structure to XML."""
        indent = " " * indent_lvl * 2  # 2 spaces per logical indent level

        p_type = meta.get("type", "string")
        p_desc = meta.get("description", "")
        # If there is no required set, then all parameters are required by default.
        if required_set is None:
            is_required = "true"
        else:
            is_required = "true" if name in required_set else "false"

        # Handle enum values
        if "enum" in meta:
            p_desc += f" Enum values: {meta['enum']}."

        # Handling for array/tuple/list types
        if "items" in meta and "type" in meta["items"]:
            inner_type = meta["items"]["type"]
            p_type = f"{p_type}[{inner_type}]"

        elif "additionalProperties" in meta:
            inner_type = meta["additionalProperties"].get("type", "string")
            p_type = f"{p_type}[{inner_type}]"

        # Build opening tag (include default attr if exists)
        attrs = [f'name="{name}", type="{p_type}", required="{is_required}"']
        if "default" in meta:
            attrs.append(f'default="{repr(meta["default"])}"')
        open_tag = f"{indent}<param " + " ".join(attrs).replace(",", "") + ">\n"

        xml_parts = [open_tag]
        xml_parts.append(f"{indent}  <desc>{p_desc}</desc>\n")

        # Recursive handling for object/dict types
        if "properties" in meta:
            child_required = meta.get("required", None)
            xml_parts.append(f"{indent}  <params>\n")
            for child_name, child_meta in meta["properties"].items():
                xml_parts.append(
                    _param_xml(child_name, child_meta, child_required, indent_lvl + 2)
                )
            xml_parts.append(f"{indent}  </params>\n")

        # closing tag
        xml_parts.append(f"{indent}</param>\n")
        return "".join(xml_parts)

    xml_blocks: list[str] = []
    for fn in functions:
        name = fn["name"]
        desc = fn.get("description", "")

        params_schema = fn["parameters"]
        top_props = params_schema.get("properties", {})
        top_required = params_schema.get("required", None)

        xml = f'<function name="{name}">\n'
        xml += f"  <desc>{desc}</desc>\n"
        xml += f"  <params>\n"

        for param_name, meta in top_props.items():
            xml += _param_xml(param_name, meta, top_required, indent_lvl=2)

        xml += f"  </params>\n"
        xml += f"</function>\n"
        xml_blocks.append(xml)

    return "\n".join(xml_blocks)


def _generate_function_doc_python(functions: list[dict]) -> str:
    """
    Generate the function documentation in Pythonic format.
    """

    def _to_py_type(meta: dict) -> str:
        t = meta.get("type", "string")
        primitive_map = {
            "string": "str",
            "number": "float",
            "integer": "int",
            "boolean": "bool",
        }

        if t in primitive_map:
            return primitive_map[t]

        if t in {"array", "list", "tuple"} and "items" in meta:
            return f"list[{_to_py_type(meta['items'])}]"

        if t in {"object", "dict"}:
            if "additionalProperties" in meta:
                return f"dict[str, {_to_py_type(meta['additionalProperties'])}]"
            # If specific properties, treat as dict
            return "dict"

        # Fallback
        return t

    INDENT_BASE = " " * 8  # 8 spaces inside the docstring block

    def _param_doc(name: str, meta: dict, depth: int = 0) -> list[str]:
        """Recursively build docstring lines for a parameter schema."""
        lines: list[str] = []
        indent = INDENT_BASE + (" " * 4 * depth)

        py_type = _to_py_type(meta)
        desc = meta.get("description", "")
        if "enum" in meta:
            desc += f" Enum values: {meta['enum']}."

        if "default" in meta:
            default_note = f", default={repr(meta['default'])}"
        else:
            default_note = ""
        lines.append(f"{indent}{name} ({py_type}{default_note}): {desc}\n")

        # Handle nested object properties
        if "properties" in meta:
            for child_name, child_meta in meta["properties"].items():
                lines.extend(_param_doc(f"{child_name}", child_meta, depth + 1))

        return lines

    docs: list[str] = []
    for fn in functions:
        full_name = fn["name"]
        desc = fn.get("description", "")

        doc_lines: list[str] = []
        doc_lines.append(f"# Function: {full_name}\n")
        doc_lines.append('    """\n')
        doc_lines.append(f"    {desc}\n\n")

        params_schema = fn.get("parameters", {})
        top_props = params_schema.get("properties", {})

        if top_props:
            doc_lines.append("    Args:\n")
            for param_name, meta in top_props.items():
                doc_lines.extend(_param_doc(param_name, meta))

        doc_lines.append('    """\n')
        docs.append("".join(doc_lines))
        docs.append("\n")

    return "\n\n".join(docs)


def parse_prompt_variation_params(input_str: str) -> tuple[str, bool, str, str, str]:
    """
    Parse a query string of the form:
      ret_fmt=…&tool_call_tag=…&func_doc_fmt=…&prompt_fmt=…&style=…

    Returns a 5-tuple containing, **in order**:
        1. return_format (str)
        2. has_tool_call_tag (bool)
        3. function_doc_format (str)
        4. prompt_format (str)
        5. prompt_style (str)

    Raises:
        ValueError: If the input string does not conform to the expected format.
    """
    _PATTERN = re.compile(
        r"^"
        r"ret_fmt=(?P<return_format>python|json|verbose_xml|concise_xml)"
        r"&tool_call_tag=(?P<has_tool_call_tag>True|False)"
        r"&func_doc_fmt=(?P<function_doc_format>python|xml|json)"
        r"&prompt_fmt=(?P<prompt_format>plaintext|markdown)"
        r"&style=(?P<prompt_style>classic|experimental)"
        r"$"
    )

    match = _PATTERN.match(input_str)
    if not match:
        raise ValueError(f"Invalid query format: {input_str!r}")

    # Extract named groups
    return_format = match.group("return_format")
    has_tool_call_tag = match.group("has_tool_call_tag") == "True"
    function_doc_format = match.group("function_doc_format")
    prompt_format = match.group("prompt_format")
    prompt_style = match.group("prompt_style")

    return (
        return_format,
        has_tool_call_tag,
        function_doc_format,
        prompt_format,
        prompt_style,
    )
