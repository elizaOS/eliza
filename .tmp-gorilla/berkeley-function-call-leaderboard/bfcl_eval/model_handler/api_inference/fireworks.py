import os
import time
from typing import Any

from bfcl_eval.model_handler.api_inference.openai_completion import (
    OpenAICompletionsHandler,
)
from bfcl_eval.constants.enums import ModelStyle
from openai import OpenAI


class FireworksHandler(OpenAICompletionsHandler):
    def __init__(
        self,
        model_name,
        temperature,
        registry_name,
        is_fc_model,
        **kwargs,
    ) -> None:
        super().__init__(model_name, temperature, registry_name, is_fc_model, **kwargs)
        self.model_style = ModelStyle.FIREWORK_AI

        self.client = OpenAI(
            base_url="https://api.fireworks.ai/inference/v1",
            api_key=os.getenv("FIREWORKS_API_KEY"),
        )

    #### FC methods ####

    def _query_FC(self, inference_data: dict):
        message: list[dict] = inference_data["message"]
        tools = inference_data["tools"]
        inference_data["inference_input_log"] = {"message": message, "tools": tools}

        start_time = time.time()
        if len(tools) > 0:
            api_response = self.client.chat.completions.create(
                messages=message,
                model=self.model_name,
                temperature=self.temperature,
                tools=tools,
            )
        else:
            api_response = self.client.chat.completions.create(
                messages=message,
                model=self.model_name,
                temperature=self.temperature,
            )
        end_time = time.time()

        return api_response, end_time - start_time

    def _pre_query_processing_FC(self, inference_data: dict, test_entry: dict) -> dict:
        return super()._pre_query_processing_FC(inference_data, test_entry)

    def _compile_tools(self, inference_data: dict, test_entry: dict) -> dict:
        return super()._compile_tools(inference_data, test_entry)

    def _parse_query_response_FC(self, api_response: Any) -> dict:
        try:
            model_responses = [
                {func_call.function.name: func_call.function.arguments}
                for func_call in api_response.choices[0].message.tool_calls
            ]
            tool_calls = [
                tool_call.model_dump()
                for tool_call in api_response.choices[0].message.tool_calls
            ]
        except:
            model_responses = api_response.choices[0].message.content
            tool_calls = []

        return {
            "model_responses": model_responses,
            "model_responses_message_for_chat_history": tool_calls,
            "input_token": api_response.usage.prompt_tokens,
            "output_token": api_response.usage.completion_tokens,
        }

    def add_first_turn_message_FC(
        self, inference_data: dict, first_turn_message: list[dict]
    ) -> dict:
        return super().add_first_turn_message_FC(inference_data, first_turn_message)

    def _add_next_turn_user_message_FC(
        self, inference_data: dict, user_message: list[dict]
    ) -> dict:
        return super()._add_next_turn_user_message_FC(inference_data, user_message)

    def _add_assistant_message_FC(
        self, inference_data: dict, model_response_data: dict
    ) -> dict:
        inference_data["message"].append(
            {
                "role": "assistant",
                "content": "",
                "tool_calls": model_response_data[
                    "model_responses_message_for_chat_history"
                ],
            }
        )
        return inference_data

    def _add_execution_results_FC(
        self, inference_data: dict, execution_results: list[str], model_response_data: dict
    ) -> dict:
        # Fireworks don’t support parallel and nested function calling, but we still support the code logic here for future use
        for execution_result in execution_results:
            tool_message = {
                "role": "tool",
                "content": execution_result,
            }
            inference_data["message"].append(tool_message)

        return inference_data
