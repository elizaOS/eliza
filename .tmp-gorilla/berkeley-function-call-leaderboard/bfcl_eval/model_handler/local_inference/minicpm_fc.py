import ast
import json
from typing import Dict, List

import datamodel_code_generator
from bfcl_eval.constants.type_mappings import GORILLA_TO_OPENAPI
from bfcl_eval.model_handler.local_inference.base_oss_handler import OSSHandler
from bfcl_eval.model_handler.utils import convert_to_tool, resolve_ast_call
from datamodel_code_generator import DataModelType
from datamodel_code_generator.model import get_data_model_types
from datamodel_code_generator.parser.jsonschema import JsonSchemaParser
from overrides import override


class MiniCPMFCHandler(OSSHandler):
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
        self.stop_token_ids = [2, 73440]
        self.skip_special_tokens = False
        self.model_name_huggingface = model_name

    @override
    def _format_prompt(self, messages, function):
        """
        "chat_template": "{%- macro json_to_python_type(param_name, json_spec) %}\n{%- set basic_type_map = {\n  'string': 'str',\n  'number': 'float',\n  'integer': 'int',\n  'boolean': 'bool',\n  'null': 'None'\n} %}\n\n{%- if json_spec.enum %}\n  {{- param_name|title }}\n{%- elif basic_type_map[json_spec.type] is defined %}\n  {{- basic_type_map[json_spec.type] }}\n{%- elif json_spec.type == 'array' %}\n  {{- 'List[' +  json_to_python_type(param_name, json_spec['items']) + ']' }}\n{%- elif json_spec.type == 'object' %}\n  {{- 'Dict[str, ' + json_to_python_type(param_name, json_spec.additionalProperties if json_spec.additionalProperties else 'Any') + ']' if not json_spec.properties else param_name|title }}\n{%- elif json_spec.type is iterable %}\n  {{- 'Union[' }}\n  {%- for t in json_spec.type %}\n    {{- json_to_python_type(param_name, {'type': t}) }}\n    {{- ', ' if not loop.last }}\n  {%- endfor %}\n  {{- ']' }}\n{%- else %}\n  {{- 'Any' }}\n{%- endif %}\n{%- endmacro %}\n\n{%- macro object_to_fields(json_spec, field_indent) %}\n  {%- set o_ns = namespace(f = caller()) %}\n  {%- for param_name, param_fields in json_spec.properties|items %}\n    {%- if param_fields.enum %}\n      {{- '\\n\\nclass ' + param_name|title + '(Enum):\\n' }}\n      {%- for enum_option in param_fields.enum %}\n        {{- '    enum_' + loop.index0|string + ' = ' + enum_option|tojson + '\\n' }}\n      {%- endfor %}\n    {%- elif param_fields.type == 'object' and param_fields.properties %}\n      {%- call object_to_fields(param_fields, '    ') %}\n        {{- '\\n\\nclass ' + param_name|title + '(BaseModel):\\n' }}\n      {%- endcall %}\n    {%- elif param_fields.type == 'array' and param_fields['items'] and param_fields['items'].type == 'object' and param_fields['items'].properties %}\n      {%- call object_to_fields(param_fields['items'], '    ') %}\n        {{- '\\n\\nclass ' + param_name|title + '(BaseModel):\\n' }}\n      {%- endcall %}\n    {%- endif %}\n    {%- set param_default = param_fields.default|tojson if param_fields.default is string else param_fields.default|string if param_fields.default is defined else 'None' %}\n    {%- set o_ns.f = o_ns.f + field_indent + param_name + ': ' %}\n    {%- set o_ns.f = o_ns.f + ('Optional[' + json_to_python_type(param_name, param_fields) + ']' if param_name not in json_spec.required else json_to_python_type(param_name, param_fields)) %}\n    {%- if not param_fields.title and not param_fields.description and not param_fields.pattern %}\n      {%- set o_ns.f = o_ns.f + (' = ' + param_default if param_name not in json_spec.required else '') %}\n    {%- else %}\n      {%- set o_ns.f = o_ns.f + (' = Field(...' if param_name in json_spec.required else ' = Field(' + param_default) %}\n      {%- set o_ns.f = o_ns.f + (', description=' + param_fields.description|tojson if param_fields.description else '') %}\n      {%- set o_ns.f = o_ns.f + (', regex=' + param_fields.pattern|tojson if param_fields.pattern else '') %}\n      {%- set o_ns.f = o_ns.f + (', title=' + param_fields.title|tojson if param_fields.title else '') %}\n      {%- set o_ns.f = o_ns.f + ')' %}\n    {%- endif %}\n    {%- set o_ns.f = o_ns.f + '\\n' %}\n  {%- endfor %}\n  {{- o_ns.f }}\n{%- endmacro %}\n\n{%- macro tool_parser(tools) %}\n{%- for tool in tools %}\n  {%- if tool.type is not defined or tool.type == 'function' %}\n    {%- if tool.function is defined %}\n      {%- set tool = tool.function %}\n    {%- endif %}\n    {%- set tool_params = tool.parameters if tool.parameters is defined else none %}\n    {%- call object_to_fields(tool_params, '        ') %}\n      {{- '\\n\\ndef ' + tool.name + '(' }}\n      {%- if tool_params %}\n        {%- for param_name, param_fields in tool_params.properties|items %}\n          {%- set param_default = param_fields.default|tojson if param_fields.default is string else param_fields.default|string if param_fields.default is defined else 'None' %}\n          {{- ', ' if loop.index0 != 0 }}\n          {{- param_name }}\n          {{- '=' + param_default if param_name not in tool_params.required }}\n        {%- endfor %}\n      {%- endif %}\n      {{- '):\\n    \"\"\"' }}\n      {{- tool.description }}\n      {{- '\\n\\n    Args:\\n' if tool_params else '\\n' }}\n    {%- endcall %}\n    {{- '    \"\"\"\\n' }}\n  {%- endif %}\n{%- endfor %}\n{%- endmacro %}\n\n{%- if messages[0]['role'] == 'system' %}\n  {%- set loop_messages = messages[1:] %}\n  {%- set system_message = messages[0]['content'] %}\n{%- else %}\n  {%- set loop_messages = messages %}\n  {%- set system_message = '' %}\n{%- endif %}\n{{- '<|im_start|>system\\n' + system_message if system_message or tools }}\n{%- if tools %}\n  {{- '\\n# Functions\\nHere is a list of functions that you can invoke:\\n```python\\nfrom enum import Enum\\nfrom typing import List, Dict, Optional\\nfrom pydantic import BaseModel, Field\\n\\n' }}\n  {{- tool_parser(tools) }}\n  {{- \"\\n```\\n\\n# Function Call Rule and Output Format\\n- If the user's question can be answered without calling any function, please answer the user's question directly. In this situation, you should return your thought and answer the user's question directly.\\n- If the user cannot be answered without calling any function, and the user does not provide enough information to call functions, please ask the user for more information. In this situation, you should return your thought and ask the user for more information.\\n- If the user's question cannot be answered without calling any function, and the user has provided enough information to call functions to solve it, you should call the functions. In this situation, the assistant should return your thought and call the functions.\\n- Use default parameters unless the user has specified otherwise.\\n- You should answer in the following format:\\n\\n<|thought_start|>\\n{explain why the user's question can be answered without calling a function or why you should ask the user for more information or why you should call one or more functions and your plan to solve the user's question.}\\n<|thought_end|>\\n<|tool_call_start|>\\n```python\\nfunc1(params_name=params_value, params_name2=params_value2...)\\nfunc2(params)\\n```\\n<|tool_call_end|>\\n{answer the user's question directly or ask the user for more information}\" }}\n{%- endif %}\n{{- '<|im_end|>\\n' if system_message or tools }}\n{%- for message in loop_messages %}\n  {%- set content = message.content %}\n  {%- if message.role == 'assistant' and message.tool_calls %}\n    {{- '<|im_start|>' + message.role + '\\n' }}\n    {{- '<|thought_start|>\\n' + message.thought + '\\n<|thought_end|>\\n' if message.thought }}\n    {{- '<|tool_call_start|>\\n```python\\n' }}\n    {%- for tool_call in message.tool_calls %}\n      {%- if tool_call.function is defined %}\n        {%- set tool_call = tool_call.function %}\n      {%- endif %}\n      {{- tool_call.name + '(' }}\n      {%- if tool_call.arguments is defined and tool_call.arguments|length > 0 %}\n        {%- for param_name, param_value in tool_call.arguments|items %}\n          {{- param_name + '=' + param_value|tojson }}\n          {{- ',' if not loop.last }}\n        {%- endfor %}\n      {%- endif %}\n      {{- ')\\n' }}\n    {%- endfor %}\n    {{- '```\\n<|tool_call_end|>\\n' }}\n    {{- content if content and not content.startswith('<|tool_call_start|>') }}\n    {{- '<|im_end|>\\n' }}\n  {%- elif message.role == 'assistant' and message.thought %}\n    {{- '<|im_start|>' + message.role + '\\n' + '<|thought_start|>\\n' + message.thought + '\\n<|thought_end|>\\n' + content + '<|im_end|>\\n' }}\n  {%- else %}\n    {{- '<|im_start|>' + message.role + '\\n' + content + '<|im_end|>\\n' }}\n  {%- endif %}\n{%- endfor %}\n\n{%- if add_generation_prompt %}\n  {{- '<|im_start|>assistant\\n' }}\n{%- endif %}"
        """
        tools = convert_to_tool(function, GORILLA_TO_OPENAPI, self.model_style)

        formated_messages = minicpm_input_format(
            messages=messages, tools=tools, model_name=self.model_name
        )
        formatted_prompt = ""
        for message in formated_messages:
            formatted_prompt += (
                f"<|im_start|>{message['role']}\n{message['content']}<|im_end|>\n"
            )

        formatted_prompt += "<|im_start|>assistant\n"
        return formatted_prompt

    @override
    def _pre_query_processing_prompting(self, test_entry: dict) -> dict:
        functions: list = test_entry["function"]

        # MiniCPM use its own system prompt in FC mode

        return {"message": [], "function": functions}

    @override
    def decode_ast(self, result, language, has_tool_call_tag):
        msg = fc2dict(result)
        if (
            "tool_calls" in msg
            and msg["tool_calls"] is not None
            and len(msg["tool_calls"]) > 0
        ):
            return [
                {tool_call["name"]: tool_call["arguments"]}
                for tool_call in msg["tool_calls"]
            ]
        else:
            return msg["content"]

    @override
    def decode_execute(self, result, has_tool_call_tag):
        msg = fc2dict(result)
        if (
            "tool_calls" in msg
            and msg["tool_calls"] is not None
            and len(msg["tool_calls"]) > 0
        ):
            execution_list = []
            for tool_call in msg["tool_calls"]:
                func_name = tool_call["name"]
                args_str = ", ".join(
                    f"{k}={repr(v)}" for k, v in tool_call["arguments"].items()
                )
                execution_list.append(f"{func_name}({args_str})")
            return execution_list
        else:
            return []


def message_format(msg, system_suffix="", user_prefix=""):
    if "thought" in msg and msg["thought"] is not None and len(msg["thought"]) > 0:
        thought_prefix = f"<|thought_start|>\n{msg['thought']}\n<|thought_end|>\n"
    else:
        thought_prefix = ""
    if msg["role"] == "assistant":
        content = msg.get("content", "")
        if content is None:
            content = ""
        if (
            "tool_calls" in msg
            and msg["tool_calls"] is not None
            and len(msg["tool_calls"]) > 0
        ):

            def add_quotes(variable):
                if isinstance(variable, str):
                    return repr(variable)
                else:
                    return str(variable)

            tool_calls = []
            for tool_call in msg["tool_calls"]:
                if tool_call is None:
                    continue
                tool_name = tool_call["name"]
                if "arguments" not in tool_call or tool_call["arguments"] is None:
                    continue
                if isinstance(tool_call["arguments"], str):
                    try:
                        tool_call["arguments"] = json.loads(tool_call["arguments"])
                    except:
                        continue
                args = ",".join(
                    [k + "=" + add_quotes(v) for k, v in tool_call["arguments"].items()]
                )
                tool_calls.append(f"{tool_name}({args})")

            content = (
                thought_prefix
                + "<|tool_call_start|>\n```python\n"
                + "\n".join(tool_calls).strip()
                + "\n```\n<|tool_call_end|>\n"
                + content
            )
            msg["content"] = content
        else:
            content = thought_prefix + content
            msg["content"] = content
    elif msg["role"] == "user":
        msg["content"] = user_prefix + "\n" + msg["content"]
    elif msg["role"] == "system":
        msg["content"] = msg["content"] + "\n" + system_suffix
    msg["content"] = msg["content"].strip()
    return msg


def jsonschema_to_code(jsonschema: dict) -> str:
    input_text = json.dumps(jsonschema)
    if datamodel_code_generator.get_version() < "0.26.2":
        from datamodel_code_generator.format import PythonVersion

        data_model_types = get_data_model_types(
            DataModelType.PydanticBaseModel,
            target_python_version=PythonVersion.PY_310,
        )
    else:
        from datamodel_code_generator.format import DatetimeClassType, PythonVersion

        data_model_types = get_data_model_types(
            DataModelType.PydanticBaseModel,
            target_python_version=PythonVersion.PY_310,
            target_datetime_class=DatetimeClassType.Datetime,
        )
    parser = JsonSchemaParser(
        source=input_text,
        data_model_type=data_model_types.data_model,
        data_model_root_type=data_model_types.root_model,
        data_model_field_type=data_model_types.field_model,
        data_type_manager_type=data_model_types.data_type_manager,
        target_python_version=PythonVersion.PY_311,
        dump_resolve_reference_action=data_model_types.dump_resolve_reference_action,
        field_constraints=True,
    )
    results = parser.parse()
    return results


def transform_function(function: dict):
    """turn json format of function into signature"""
    params, default_params = [], []
    for prop_name, prop in function["parameters"]["properties"].items():
        if "default" in prop:
            default_params.append(f'{prop_name}={repr(prop["default"])}')
        elif prop_name not in function["parameters"].get("required", []):
            default_params.append(f"{prop_name}={repr(None)}")
        else:
            params.append(prop_name)
    ps = ", ".join(params + default_params)
    res = "def {f_name}({ps}):\n".format(f_name=function["name"], ps=ps)
    f_des = function.get("description", "")
    content = jsonschema_to_code(function["parameters"])
    if "class" in content:
        i = content.index("class")
        content = content[i:]
    classes, args = content.split("class Model(BaseModel):", 1)
    lint_msg = f'    """\n    {f_des}\n    Args:\n{args}\n    """\n'
    res += lint_msg
    if len(classes) > 0:
        res = classes + res
    return res


def minicpm_input_format(
    messages: List[Dict],
    tools: List[Dict],
    add_to_system=True,
    model_name="openbmb/MiniCPM3-4B",
):
    """
    Process the input messages, global_arguments, tools, tool_choice,
        and convert it into a input string.
    The global arguments and tools can not be both empty.
    parameters:
        messages: List[Dict]
            the input messages
            For example:
        tools: List[Dict]
            the tools list you can use
            For example:
    """
    if tools is not None and len(tools) > 0:
        header = "from enum import Enum\nfrom typing import List, Dict, Optional\nfrom pydantic import BaseModel, Field\n\n"
        tools_string = header
        for tool in tools:
            try:
                tools_string += "\n\n" + transform_function(tool)
            except:
                pass
                # print(traceback.format_exc())
        tools_template = """# Functions
Here is a list of functions that you can invoke:
```python
{tools}
```

# Function Call Rule and Output Format
- If the user's question can be answered without calling any function, please answer the user's question directly. In this situation, you should return your thought and answer the user's question directly.
- If the user cannot be answered without calling any function, and the user does not provide enough information to call functions, please ask the user for more information. In this situation, you should return your thought and ask the user for more information.
- If the user's question cannot be answered without calling any function, and the user has provided enough information to call functions to solve it, you should call the functions. In this situation, the assistant should return your thought and call the functions.
- Use default parameters unless the user has specified otherwise.
- You should answer in the following format:

<|thought_start|>
{{explain why the user's question can be answered without calling a function or why you should ask the user for more information or why you should call one or more functions and your plan to solve the user's question.}}
<|thought_end|>
<|tool_call_start|>
```python
func1(params_name=params_value, params_name2=params_value2...)
func2(params)
```
<|tool_call_end|>
{{answer the user's question directly or ask the user for more information}}
"""
        tools_string = tools_template.format(tools=tools_string).strip()
    else:
        tools_string = ""

    if add_to_system:
        if len(messages) > 0 and messages[0]["role"] != "system":
            messages.insert(0, {"role": "system", "content": ""})
        return [
            message_format(msg, system_suffix=tools_string, user_prefix="")
            for msg in messages
        ]
    else:
        return [
            message_format(msg, system_suffix="", user_prefix=tools_string)
            for msg in messages
        ]


def convert_function_call_to_json(string):
    try:
        tool_calls = []
        x = ast.parse(string)
        for tool in x.body:
            function_name = tool.value.func.id
            function_args = {}
            for kw in tool.value.keywords:
                function_args[kw.arg] = ast.literal_eval(kw.value)
            this_one = {"name": function_name, "arguments": function_args}
            tool_calls.append(this_one)
        return tool_calls
    except Exception:
        return []


def fc2dict(
    sequence: str,
    tool_call_start="<|tool_call_start|>",
    tool_call_end="<|tool_call_end|>",
    thought_start="<|thought_start|>",
    thought_end="<|thought_end|>",
):
    if thought_end in sequence and thought_start in sequence:
        thought_string, sequence = sequence.rsplit(thought_end, 1)
        thought_string = thought_string.split(thought_start, 1)[1]
    else:
        thought_string = ""
    if tool_call_start in sequence and tool_call_end in sequence:
        tool_call_string, content = sequence.rsplit(tool_call_end, 1)
        tool_call_string = tool_call_string.split(tool_call_start, 1)[1]
        try:
            tool_calls = []
            tool_call_string = tool_call_string.strip()
            if tool_call_string.startswith("```"):
                tool_call_string = tool_call_string.lstrip("```").strip()
                if tool_call_string.startswith("python"):
                    tool_call_string = tool_call_string.lstrip("python").strip()
            if tool_call_string.endswith("```"):
                tool_call_string = tool_call_string.rstrip("```").strip()

            parsed = ast.parse(tool_call_string)

            for elem in parsed.body:
                assert isinstance(elem.value, ast.Call)
                calls = resolve_ast_call(elem.value)

                for func_name, func_args in calls.items():

                    this_one = {"name": func_name, "arguments": func_args}
                    tool_calls.append(this_one)

            return {
                "content": content.strip(),
                "tool_calls": tool_calls,
                "role": "assistant",
            }
        except:
            return {
                "content": content.strip(),
                "role": "assistant",
                "thought": thought_string,
            }
    else:
        return {
            "content": sequence.strip(),
            "role": "assistant",
            "thought": thought_string,
        }
