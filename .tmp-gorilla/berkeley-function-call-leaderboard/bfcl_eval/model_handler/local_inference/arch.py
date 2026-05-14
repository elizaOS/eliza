import json
import re
from typing import Any

from bfcl_eval.model_handler.local_inference.base_oss_handler import OSSHandler
from bfcl_eval.model_handler.utils import convert_to_function_call
from overrides import override


class ArchHandler(OSSHandler):
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
        self.is_fc_model = True

    @override
    def decode_ast(self, result, language, has_tool_call_tag):
        # The input is already a list of dictionaries, so no need to decode
        # `[{func1:{param1:val1,...}},{func2:{param2:val2,...}}]`
        if type(result) != list or any(type(item) != dict for item in result):
            raise ValueError(f"Model did not return a list of function calls: {result}")
        return result

    @override
    def decode_execute(self, result, has_tool_call_tag):
        if type(result) != list or any(type(item) != dict for item in result):
            raise ValueError(f"Model did not return a list of function calls: {result}")
        return convert_to_function_call(result)

    @override
    def _format_prompt(self, messages, function):
        """
        "chat_template":
        {%- if tools %}
            {{- '<|im_start|>system\n' }}
            {%- if messages[0]['role'] == 'system' %}
                {{- messages[0]['content'] }}
            {%- else %}
                {{- 'You are a helpful assistant designed to assist with the user query by making one or more function calls if needed.' }}
            {%- endif %}
            {{- "\n\n# Tools\n\nYou may call one or more functions to assist with the user query.\n\nYou are provided with function signatures within <tools></tools> XML tags:\n<tools>" }}
            {%- for tool in tools %}
                {{- "\n" }}
                {{- tool | tojson }}
            {%- endfor %}
            {{- "\n</tools>\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n<tool_call>\n{\"name\": <function-name>, \"arguments\": <args-json-object>}\n</tool_call><|im_end|>\n" }}
        {%- else %}
            {%- if messages[0]['role'] == 'system' %}
                {{- '<|im_start|>system\n' + messages[0]['content'] + '<|im_end|>\n' }}
            {%- else %}
                {{- '<|im_start|>system\nYou are a helpful assistant designed to assist with the user query by making one or more function calls if needed.<|im_end|>\n' }}
            {%- endif %}
        {%- endif %}
        {%- for message in messages %}
            {%- if (message.role == "user") or (message.role == "system" and not loop.first) or (message.role == "assistant" and not message.tool_calls) %}
                {{- '<|im_start|>' + message.role + '\n' + message.content + '<|im_end|>' + '\n' }}
            {%- elif message.role == "assistant" %}
                {{- '<|im_start|>' + message.role }}
                {%- if message.content %}
                    {{- '\n' + message.content }}
                {%- endif %}
                {%- for tool_call in message.tool_calls %}
                    {%- if tool_call.function is defined %}
                        {%- set tool_call = tool_call.function %}
                    {%- endif %}
                    {{- '\n<tool_call>\n{"name": "' }}
                    {{- tool_call.name }}
                    {{- '", "arguments": ' }}
                    {{- tool_call.arguments | tojson }}
                    {{- '}\n</tool_call>' }}
                {%- endfor %}
                {{- '<|im_end|>\n' }}
            {%- elif message.role == "tool" %}
                {%- if (loop.index0 == 0) or (messages[loop.index0 - 1].role != "tool") %}
                    {{- '<|im_start|>user' }}
                {%- endif %}
                {{- '\n<tool_response>\n' }}
                {{- message.content }}
                {{- '\n</tool_response>' }}
                {%- if loop.last or (messages[loop.index0 + 1].role != "tool") %}
                    {{- '<|im_end|>\n' }}
                {%- endif %}
            {%- endif %}
        {%- endfor %}
        {%- if add_generation_prompt %}
            {{- '<|im_start|>assistant\n' }}
        {%- endif %}
        """
        formatted_prompt = ""

        if messages[0]["role"] == "system":
            system_prompt = messages[0]["content"]
        else:
            system_prompt = "You are a helpful assistant designed to assist with the user query by making one or more function calls if needed."

        if len(function) > 0:
            formatted_prompt += "<|im_start|>system\n"
            formatted_prompt += system_prompt
            formatted_prompt += "\n\n# Tools\n\nYou may call one or more functions to assist with the user query.\n\nYou are provided with function signatures within <tools></tools> XML tags:\n<tools>"
            for tool in function:
                formatted_prompt += f"\n{json.dumps(tool)}"
            formatted_prompt += '\n</tools>\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call><|im_end|>\n'
        else:
            formatted_prompt += f"<|im_start|>system\n{system_prompt}<|im_end|>\n"

        for idx, message in enumerate(messages):
            role = message["role"]
            content = message["content"]
            tool_calls = message.get(
                "tool_calls", []
            )  # tool calls is only present for assistant messages

            if (
                role == "user"
                or (role == "system" and idx != 0)
                or (role == "assistant" and not tool_calls)
            ):
                formatted_prompt += f"<|im_start|>{role}\n{content}<|im_end|>\n"
            elif role == "assistant":
                formatted_prompt += f"<|im_start|>{role}"
                if content:
                    formatted_prompt += f"\n{content}"
                for tool_call in tool_calls:
                    if "function" in tool_call:
                        tool_call = tool_call["function"]
                    tool_name = tool_call.get("name", "")
                    arguments = tool_call.get("arguments", {})
                    formatted_prompt += f'\n<tool_call>\n{{"name": "{tool_name}", "arguments": {json.dumps(arguments)}}}\n</tool_call>'
                formatted_prompt += "<|im_end|>\n"
            elif role == "tool":
                if idx == 0 or messages[idx - 1]["role"] != "tool":
                    formatted_prompt += "<|im_start|>user"
                formatted_prompt += f"\n<tool_response>\n{content}\n</tool_response>"
                if idx == len(messages) - 1 or messages[idx + 1]["role"] != "tool":
                    formatted_prompt += "<|im_end|>\n"

        formatted_prompt += "<|im_start|>assistant\n"

        return formatted_prompt

    @override
    def _pre_query_processing_prompting(self, test_entry: dict) -> dict:
        functions: list = test_entry["function"]

        # FC models use its own system prompt, so no need to add any message

        return {"message": [], "function": functions}

    @override
    def _parse_query_response_prompting(self, api_response: Any) -> dict:
        model_responses = api_response.choices[0].text
        extracted_tool_calls = self.extract_tool_calls(model_responses)

        if len(extracted_tool_calls) > 0:
            model_responses_message_for_chat_history = {
                "role": "assistant",
                "content": None,
                "tool_calls": extracted_tool_calls,
            }
            model_responses = []
            for item in extracted_tool_calls:
                # Handle the situation: ['{"name": "random_forest.train", "arguments": {"n_estimators": 100, "max_depth": 5, "data": my_data}}']
                if type(item) == str:
                    item = eval(item)
                model_responses.append({item["name"]: item["arguments"]})

        else:
            model_responses_message_for_chat_history = {
                "role": "assistant",
                "content": api_response.choices[0].text,
            }

        return {
            "model_responses": model_responses,
            "model_responses_message_for_chat_history": model_responses_message_for_chat_history,
            "input_token": api_response.usage.prompt_tokens,
            "output_token": api_response.usage.completion_tokens,
        }

    @override
    def _add_assistant_message_prompting(
        self, inference_data: dict, model_response_data: dict
    ) -> dict:
        inference_data["message"].append(
            model_response_data["model_responses_message_for_chat_history"],
        )
        return inference_data

    @staticmethod
    def extract_tool_calls(input_string):
        pattern = r"<tool_call>\n(.*?)\n</tool_call>"
        matches = re.findall(pattern, input_string, re.DOTALL)

        # Process matches into a list of dictionaries
        result = []
        for match in matches:
            try:
                match = json.loads(match)
            except Exception as e:
                pass
            result.append(match)
        return result
