import os
import time
from typing import Any

import boto3
from bfcl_eval.constants.type_mappings import GORILLA_TO_OPENAPI
from bfcl_eval.model_handler.base_handler import BaseHandler
from bfcl_eval.constants.enums import ModelStyle
from bfcl_eval.model_handler.utils import (
    combine_consecutive_user_prompts,
    convert_to_function_call,
    convert_to_tool,
    extract_system_prompt,
    retry_with_backoff,
)


class NovaHandler(BaseHandler):
    def __init__(
        self,
        model_name,
        temperature,
        registry_name,
        is_fc_model,
        **kwargs,
    ) -> None:
        super().__init__(model_name, temperature, registry_name, is_fc_model, **kwargs)
        self.model_style = ModelStyle.AMAZON
        self.is_fc_model = True
        _session = boto3.Session(
            profile_name=os.getenv("AWS_SSO_PROFILE_NAME"), region_name="us-east-1"
        )
        self.client = _session.client(service_name="bedrock-runtime")

    def decode_ast(self, result, language, has_tool_call_tag):
        if type(result) != list:
            raise ValueError(f"Model did not return a list of function calls: {result}")
        return result

    def decode_execute(self, result, has_tool_call_tag):
        if type(result) != list:
            raise ValueError(f"Model did not return a list of function calls: {result}")
        return convert_to_function_call(result)

    @retry_with_backoff(error_message_pattern=r".*\(ThrottlingException\).*")
    def generate_with_backoff(self, **kwargs):
        start_time = time.time()
        api_response = self.client.converse(**kwargs)
        end_time = time.time()

        return api_response, end_time - start_time

    #### FC methods ####

    def _query_FC(self, inference_data: dict):
        message: list[dict] = inference_data["message"]
        tools = inference_data["tools"]

        if "system_prompt" in inference_data:
            system_prompt = inference_data["system_prompt"]
        else:
            system_prompt = []

        inference_data["inference_input_log"] = {
            "message": repr(message),
            "tools": tools,
            "system_prompt": system_prompt,
        }

        kwargs = {
            "modelId": self.model_name,
            "messages": message,
            "system": system_prompt,
            "inferenceConfig": {"temperature": self.temperature},
        }
        if len(tools) > 0:
            kwargs["toolConfig"] = {"tools": tools}

        if "nova-2-lite" in self.model_name:
            kwargs["additionalModelRequestFields"] = {
                "reasoningConfig": {"type": "enabled", "maxReasoningEffort": "medium"}
            }

        return self.generate_with_backoff(**kwargs)

    def _pre_query_processing_FC(self, inference_data: dict, test_entry: dict) -> dict:
        for round_idx in range(len(test_entry["question"])):
            test_entry["question"][round_idx] = combine_consecutive_user_prompts(
                test_entry["question"][round_idx]
            )

        inference_data["message"] = []

        system_prompt = extract_system_prompt(test_entry["question"][0])
        if system_prompt:
            inference_data["system_prompt"] = [{"text": system_prompt}]

        return inference_data

    def _compile_tools(self, inference_data: dict, test_entry: dict) -> dict:
        functions: list = test_entry["function"]

        tools = convert_to_tool(functions, GORILLA_TO_OPENAPI, self.model_style)

        inference_data["tools"] = tools

        return inference_data

    def _parse_query_response_FC(self, api_response: Any) -> dict:
        model_responses_message_for_chat_history = api_response["output"]["message"]
        reasoning_content = ""

        text_parts = []
        tool_parts = []
        tool_call_ids = []
        for func_call in api_response["output"]["message"]["content"]:
            if "reasoningContent" in func_call:
                reasoning_content += func_call["reasoningContent"]["reasoningText"]["text"]

            elif "text" in func_call:
                text_parts.append(func_call["text"])

            elif "toolUse" in func_call:
                func_call = func_call["toolUse"]
                func_name = func_call["name"]
                func_args = func_call["input"]
                tool_parts.append({func_name: func_args})
                tool_call_ids.append(func_call["toolUseId"])

        return {
            "model_responses": tool_parts if tool_parts else text_parts,
            "model_responses_message_for_chat_history": model_responses_message_for_chat_history,
            "tool_call_ids": tool_call_ids,
            "reasoning_content": reasoning_content,
            "input_token": api_response["usage"]["inputTokens"],
            "output_token": api_response["usage"]["outputTokens"],
        }

    def add_first_turn_message_FC(
        self, inference_data: dict, first_turn_message: list[dict]
    ) -> dict:
        for message in first_turn_message:
            message["content"] = [{"text": message["content"]}]
        inference_data["message"].extend(first_turn_message)
        return inference_data

    def _add_next_turn_user_message_FC(
        self, inference_data: dict, user_message: list[dict]
    ) -> dict:
        for message in user_message:
            message["content"] = [{"text": message["content"]}]
        inference_data["message"].extend(user_message)
        return inference_data

    def _add_assistant_message_FC(
        self, inference_data: dict, model_response_data: dict
    ) -> dict:
        inference_data["message"].append(
            model_response_data["model_responses_message_for_chat_history"]
        )
        return inference_data

    def _add_execution_results_FC(
        self,
        inference_data: dict,
        execution_results: list[str],
        model_response_data: dict,
    ) -> dict:
        # Nova use the `user` role for the tool result message
        tool_message = {
            "role": "user",
            "content": [],
        }
        for execution_result, tool_call_id in zip(
            execution_results, model_response_data["tool_call_ids"]
        ):
            tool_message["content"].append(
                {
                    "toolResult": {
                        "toolUseId": tool_call_id,
                        # Nova models supports json or text content
                        # Our pipeline force execution results to be text for all models
                        # So we will just use text here to be consistent
                        "content": [{"text": execution_result}],
                    }
                }
            )

        inference_data["message"].append(tool_message)

        return inference_data
