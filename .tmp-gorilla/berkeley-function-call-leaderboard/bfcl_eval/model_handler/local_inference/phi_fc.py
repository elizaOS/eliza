import json
import re
from typing import Any

from bfcl_eval.model_handler.local_inference.base_oss_handler import OSSHandler
from bfcl_eval.model_handler.utils import convert_to_function_call
from overrides import override


class PhiFCHandler(OSSHandler):
    """
    This class implements a function-calling handler for the Microsoft Phi series of models.

    Specifically, this handler currently supports the following models:
    - microsoft/Phi-4-mini-instruct
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
        self.model_name_huggingface = model_name
        self.is_fc_model = True

    @override
    def _format_prompt(self, messages, function):
        """
        "bos_token": "<|endoftext|>",
        "chat_template":
        {% for message in messages %}
          {% if message['role'] == 'system' and 'tools' in message and message['tools'] is not none %}
            {{ '<|' + message['role'] + '|>' + message['content'] + '<|tool|>' + message['tools'] + '<|/tool|>' + '<|end|>' }}
          {% else %}
            {{ '<|' + message['role'] + '|>' + message['content'] + '<|end|>' }}
          {% endif %}
        {% endfor %}
        {% if add_generation_prompt %}
          {{ '<|assistant|>' }}
        {% else %}
          {{ eos_token }}
        {% endif %}
        """

        # Here's Microsoft's documentation on how the Phi-4-mini-instruct model expects tools to be provided to it:
        # Tool-enabled function-calling format
        #
        # # Tools
        # This format is used when the user wants the model to provide function calls based on the given tools.
        # The user should provide the available tools in the system prompt, wrapped by <|tool|> and <|/tool|> tokens.
        # The tools should be specified in JSON format, using a JSON dump structure. Example:
        #
        # <|system|>You are a helpful assistant with some tools.<|tool|>[{"name": "get_weather_updates", "description": "Fetches weather updates for a given city using the RapidAPI Weather API.", "parameters": {"city": {"description": "The name of the city for which to retrieve weather information.", "type": "str", "default": "London"}}}]<|/tool|><|end|><|user|>What is the weather like in Paris today?<|end|><|assistant|>
        #

        # sanity check
        system_messages = [msg for msg in messages if msg["role"] == "system"]
        assert 0 <= len(system_messages) <= 1

        # set the system message
        system_message = "You are a helpful assistant with some tools."
        if messages[0]["role"] == "system":
            system_message = messages[0]["content"]
            messages = messages[1:]

        # extract the tool contents
        tool_contents = ""
        for func in function:
            # microsoft documentation has no guidance on indentation
            tool_contents += json.dumps(func)
            tool_contents += "\n"

        # format the rest of the prompt
        formatted_prompt = (
            f"<|system|>{system_message}<|tool|>{tool_contents}<|/tool|><|end|>"
        )
        for msg in messages:
            role = msg["role"]
            content = msg["content"]
            formatted_prompt += f"<|{role}|>{content}<|end|>"

        # provide the generation prompt token
        formatted_prompt += "<|assistant|>"
        return formatted_prompt

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
    def _pre_query_processing_prompting(self, test_entry: dict) -> dict:
        functions: list = test_entry["function"]

        # FC models use its own system prompt, so no need to add any message
        return {"message": [], "function": functions}

    @override
    def _parse_query_response_prompting(self, api_response: Any) -> dict:
        """
        Parses the raw response from the model API to extract the result, input token count, and output token count.

        Args:
            api_response (any): The raw response from the model API.

        Returns:
            A dict containing the following elements:
                - model_responses (any): The parsed result that can be directly used as input to the decode method.
                - input_token (int): The number of tokens used in the input to the model.
                - output_token (int): The number of tokens generated by the model as output.
                - Any other metadata that is specific to the model.
        """
        model_responses_message_for_chat_history = api_response.choices[0].text
        model_responses = api_response.choices[0].text
        extracted_tool_calls = self._extract_tool_calls(model_responses)

        if (
            self._is_tool_call_response_format(extracted_tool_calls)
            and len(extracted_tool_calls) > 0
        ):
            model_responses = [
                {item["name"]: item["arguments"]} for item in extracted_tool_calls
            ]

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
        """
        Add assistant message to the chat history.
        """
        inference_data["message"].append(
            {
                "role": "assistant",
                "content": model_response_data["model_responses_message_for_chat_history"],
            }
        )
        return inference_data

    @staticmethod
    def _extract_tool_calls(input_string: str) -> list:
        """
        Given some input response, attempt to parse out the tool calls made by the model.

        Args:
            input_string (str): The model response

        Returns:
            (list) The matched objects that we were able to parse out
        """
        # Match the normal situation: <|tool_call|>[{\"name\": \"calculate_final_velocity\", \"arguments\": {\"height\": 150, \"initial_velocity\": 0}}]<|/tool_call|>
        pattern = r"<\|tool_call\|>(.*?)<\|/tool_call\|>"
        matches = re.findall(pattern, input_string, re.DOTALL)

        # Often the model will miss the `<|/tool_call|>`: <|tool_call|>[{\"name\": \"calculate_final_velocity\", \"arguments\": {\"height\": 150, \"initial_velocity\": 0}}]
        # Since `<|tool_call|>` is still present, we consider this a valid case
        if not matches:
            pattern = r"<\|tool_call\|>(.*?)(?:<\|/tool_call\|>)?$"
            matches = re.findall(pattern, input_string, re.DOTALL)

        # Process matches into a list of dictionaries
        result = []
        for match in matches:
            # For parallel tool call, Phi might not put them in a list: {\"name\": \"calculate_sales_tax\", \"arguments\": {\"purchase_amount\": 30.45, \"city\": \"Chicago\", \"state\": \"Illinois\"}}, {\"name\": \"calculate_sales_tax\", \"arguments\": {\"purchase_amount\": 52.33, \"city\": \"Sacramento\", \"state\": \"California\"}}, {\"name\": \"calculate_sales_tax\", \"arguments\": {\"purchase_amount\": 11.23, \"city\": \"Portland\", \"state\": \"Oregon\"}}
            if not match.startswith("[") and not match.endswith("]"):
                match = "[" + match + "]"

            try:
                match = json.loads(match)
            except json.JSONDecodeError:
                pass

            if type(match) is list:
                for item in match:
                    # Handle the situation: ['{"name": "random_forest.train", "arguments": {"n_estimators": 100, "max_depth": 5, "data": my_data}}']
                    if type(item) == str:
                        item = eval(item)
                    result.append(item)
            else:
                result.append(match)

        return result

    @staticmethod
    def _is_tool_call_response_format(input: list) -> bool:
        """
        This is a helper method to detect if the tool call extracted by `_extract_tool_calls` is actually a tool call.
        This is important because the model might return a dictionary that looks like a tool call, but is not. It sometimes returns the function document.
        For example,
        "<|tool_call|>{\"name\": \"streaming_services.shows_list_and_ratings\", \"arguments\": {\"streaming_service\": \"Netflix\", \"show_list\": [\"Friends\"], \"sort_by_rating\": false}, \"type\": \"dict\", \"description\": \"Get a list of shows and their ratings on Netflix.\"}"
        The dictionary will cause the downstream decoding pipeline error, so it's better to do a sanity check here.
        """
        if type(input) != list:
            return False

        for item in input:
            if type(item) != dict:
                return False
            if "name" not in item:
                return False
            if "arguments" not in item:
                return False
            if len(item) != 2:
                return False

        return True
