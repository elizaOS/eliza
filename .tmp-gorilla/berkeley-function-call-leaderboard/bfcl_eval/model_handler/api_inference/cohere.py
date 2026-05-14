import ast
import json
import os
import time
from typing import Any

import cohere
from bfcl_eval.model_handler.base_handler import BaseHandler
from bfcl_eval.constants.type_mappings import GORILLA_TO_OPENAPI
from bfcl_eval.constants.enums import ModelStyle
from bfcl_eval.model_handler.utils import (
    convert_to_tool,
    retry_with_backoff,
    extract_system_prompt,
)
from tenacity.stop import stop_after_attempt


class CohereHandler(BaseHandler):
    client: cohere.ClientV2

    def __init__(
        self,
        model_name,
        temperature,
        registry_name,
        is_fc_model,
        **kwargs,
    ) -> None:
        super().__init__(model_name, temperature, registry_name, is_fc_model, **kwargs)
        self.model_style = ModelStyle.COHERE
        self.is_fc_model = True
        self.client = cohere.ClientV2(api_key=os.getenv("COHERE_API_KEY"))

    def decode_ast(self, result, language, has_tool_call_tag):
        decoded_output = []
        if isinstance(result, list):
            for tool_call in result:
                name = tool_call["tool_name"]
                params = tool_call["parameters"]
                decoded_output.append({name: params})
        return decoded_output

    def decode_execute(self, result, has_tool_call_tag):
        execution_list = []
        if isinstance(result, list):
            for tool_call in result:
                parameter_key_value_list = []
                for parameter_name, parameter_value in tool_call["parameters"].items():
                    parameter_key_value_list.append(
                        "{}={}".format(parameter_name, repr(parameter_value))
                    )
                execution_list.append(
                    "{}({})".format(
                        tool_call["tool_name"], ",".join(parameter_key_value_list)
                    )
                )
        return execution_list

    #### FC methods ####

    def _query_FC(self, inference_data: dict):
        if system_message := inference_data.get("system_message"):
            system_turn = [
                cohere.SystemChatMessageV2(
                    role="system",
                    content=system_message,
                )
            ]
        else:
            system_turn = []
        all_chat_turns = system_turn + inference_data["chat_turns"]

        response, latency = self.generate_with_backoff(
            messages=all_chat_turns,
            tools=[load_cohere_tool(tool=tool) for tool in inference_data["tools"]],
        )

        model_tool_calls = []
        chat_turn_to_append = cohere.AssistantChatMessageV2(role="assistant")
        response_message = response.message
        if response_message.tool_calls:
            chat_turn_to_append.tool_calls = response_message.tool_calls
            for tool_call in response_message.tool_calls:
                model_tool_calls.append(
                    {
                        "tool_name": tool_call.function.name,
                        "parameters": json.loads(tool_call.function.arguments),
                    }
                )
        if response_message.tool_plan:
            chat_turn_to_append.tool_plan = response_message.tool_plan
        if response_message.content:
            if chat_turn_to_append.content is None:
                chat_turn_to_append.content = []

            for msg in response_message.content:
                if hasattr(msg, "thinking"):
                    chat_turn_to_append.content.append(
                        cohere.ThinkingAssistantMessageV2ContentItem(thinking=msg.thinking)
                    )
                else:
                    chat_turn_to_append.content.append(
                        cohere.TextAssistantMessageV2ContentItem(text=msg.text)
                    )
        if response_message.citations:
            chat_turn_to_append.citations = response_message.citations
        inference_data["chat_turns"].append(chat_turn_to_append)

        input_token: float | None = None
        output_token: float | None = None
        if response.usage and response.usage.billed_units:
            input_token = response.usage.billed_units.input_tokens
            output_token = response.usage.billed_units.output_tokens

        metadata = {
            "model_responses": (
                chat_turn_to_append.content if chat_turn_to_append.content else None
            ),
            "tool_calls": model_tool_calls,
            "chat_history": [],
            "input_token": input_token or 0,
            "output_token": output_token or 0,
        }
        return metadata, latency

    @retry_with_backoff(error_type=Exception, stop=stop_after_attempt(5), reraise=True)
    def generate_with_backoff(
        self,
        messages: list,
        tools: list[cohere.types.ToolV2]
    ) -> tuple[cohere.v2.types.V2ChatResponse, float]:
        start_time = time.time()
        api_response = self.client.chat(
            model=self.model_name.replace("-FC", ""),
            messages=messages,
            tools=tools,
            citation_options=cohere.CitationOptions(mode="OFF"),
            temperature=self.temperature,
        )
        end_time = time.time()

        return api_response, end_time - start_time

    def _pre_query_processing_FC(self, inference_data: dict, test_entry: dict) -> dict:
        turns = []
        for turn_idx, turn in enumerate(test_entry["question"]):
            if turn_idx == 0:  # we only extract system message from the first turn
                system_message = extract_system_prompt(turn)
                if system_message:
                    inference_data["system_message"] = (
                        system_message  # we log system message if necessary
                    )
            if len(turn) > 0:
                turns.append(preprocess_chat_turns(turn))
            else:
                turns.append(
                    []
                )  # for miss_func categories, the turn to supplement function will be empty
        assert len(turns) == len(test_entry["question"])
        test_entry["question"] = turns
        return inference_data

    def _compile_tools(self, inference_data: dict, test_entry: dict) -> dict:
        functions: list = test_entry["function"]

        tools = convert_to_tool(functions, GORILLA_TO_OPENAPI, self.model_style)
        inference_data["tools"] = tools

        return inference_data

    def _parse_query_response_FC(self, api_response: Any) -> dict:
        reasoning_content = ""

        if len(api_response["tool_calls"]) > 0:  # non empty tool call list
            model_responses = api_response[
                "tool_calls"
            ]  # list: {"tool_name": , "parameters"}
        else:
            if isinstance(api_response["model_responses"], list):
                model_responses = []
                for item in api_response["model_responses"]:
                    if isinstance(item, cohere.types.ThinkingAssistantMessageV2ContentItem):
                        reasoning_content += item.thinking
                        continue
                    elif isinstance(item, cohere.types.TextAssistantMessageV2ContentItem):
                        model_responses.append(item.text)
                    else:
                        model_responses.append(item)
                model_responses = "\n".join(model_responses)
            else:
                model_responses = api_response["model_responses"]

        return {
            "model_responses": model_responses,
            "reasoning_content": reasoning_content or None,
            "tool_calls": api_response["tool_calls"],
            "chat_history": api_response["chat_history"],
            "input_token": api_response["input_token"],
            "output_token": api_response["output_token"],
        }

    def add_first_turn_message_FC(
        self, inference_data: dict, first_turn_message: list[dict]
    ) -> dict:
        chat_turns = []
        for message in first_turn_message:
            message_role = message["role"]
            assert message_role in [
                "user",
                "assistant",
            ], "message role must be in ['user', 'assistant']"
            if message_role == "user":
                chat_turns.append(
                    cohere.UserChatMessageV2(role="user", content=message["content"])
                )
            else:
                chat_turns.append(
                    cohere.AssistantChatMessageV2(
                        role="assistant",
                        content=message["content"],
                    )
                )
        inference_data["chat_turns"] = chat_turns
        inference_data["raw_prompt"] = []
        inference_data["raw_completion"] = []
        return inference_data

    def _add_next_turn_user_message_FC(
        self, inference_data: dict, user_message: list[dict]
    ) -> dict:
        assert "chat_turns" in inference_data, "expected chat_turns to be present"
        for message in user_message:
            message_role = message["role"]
            if message_role == "user":
                inference_data["chat_turns"].append(
                    cohere.UserChatMessageV2(role="user", content=message["content"])
                )
            elif message_role == "assistant":
                inference_data["chat_turns"].append(
                    cohere.AssistantChatMessageV2(
                        role="assistant",
                        content=message["content"],
                    )
                )
            else:
                raise Exception(f"Role {message_role} is undefined!")
        if inference_data["chat_turns"][-1].role != "user":
            # if last turn is not user turn - we suffixing a user turn at the end of the conversation history
            inference_data["chat_turns"].append(
                cohere.UserChatMessageV2(role="user", content="")
            )
        return inference_data

    def _add_assistant_message_FC(
        self, inference_data: dict, model_response_data: dict
    ) -> dict:
        # Cohere has all the messages in the chat history already, so no need to add anything here
        return inference_data

    def _add_execution_results_FC(
        self, inference_data: dict, execution_results: list[str], model_response_data: dict
    ) -> dict:
        if execution_results:
            # non-empty execution_results, the last turn of inference_data["chat_turns"] must be a tool use turn
            # otherwise, do nothing
            assert (
                inference_data["chat_turns"][-1].role == "assistant"
            ), "last turn must be tool use turn and from the assistant"
            assert inference_data["chat_turns"][
                -1
            ].tool_calls, "last turn must have tool calls"
            assert len(inference_data["chat_turns"][-1].tool_calls) == len(
                execution_results
            ), "Number of execution result must match number of tool calls from last turn!"
            tool_call_messages = []
            for tool_call, execution_result in zip(
                inference_data["chat_turns"][-1].tool_calls, execution_results
            ):
                tool_call_id = tool_call.id
                try:
                    tool_execution_result = ast.literal_eval(execution_result)
                except:
                    tool_execution_result = execution_result
                if isinstance(tool_execution_result, dict):
                    if "id" in tool_execution_result:
                        tool_execution_result["ID"] = tool_execution_result["id"]
                        del tool_execution_result["id"]
                    result_to_render = json.dumps(tool_execution_result)
                else:
                    result_to_render = execution_result
                one_tool_call_output = cohere.ToolChatMessageV2(
                    tool_call_id=tool_call_id,
                    content=[
                        cohere.TextToolContent(type="text", text=result_to_render),
                    ],
                )
                tool_call_messages.append(one_tool_call_output)
            inference_data["chat_turns"].extend(tool_call_messages)
        return inference_data


def preprocess_chat_turns(all_messages: list[dict]) -> list[dict]:
    processed_messages: list[dict] = []
    for message in all_messages:
        processed_messages.append(message)
    return processed_messages


def load_cohere_tool(tool: dict):
    function = tool["function"]
    return cohere.ToolV2(
        type="function",
        function=cohere.ToolV2Function(
            name=function["name"],
            description=function["description"],
            parameters=function["parameters"],
        ),
    )
