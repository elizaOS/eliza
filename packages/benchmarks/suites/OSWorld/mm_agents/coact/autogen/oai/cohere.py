# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0
#
# Portions derived from  https://github.com/microsoft/autogen are under the MIT License.
# SPDX-License-Identifier: MIT
"""Create an OpenAI-compatible client using Cohere's API.

Example:
    ```python
    llm_config={
        "config_list": [{
            "api_type": "cohere",
            "model": "command-r-plus",
            "api_key": os.environ.get("COHERE_API_KEY")
            "client_name": "autogen-cohere", # Optional parameter
            }
    ]}

    agent = autogen.AssistantAgent("my_agent", llm_config=llm_config)
    ```

Install Cohere's python library using: pip install --upgrade cohere

Resources:
- https://docs.cohere.com/reference/chat
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
import warnings
from typing import Any, Literal, Optional, Type

from pydantic import BaseModel, Field

from autogen.oai.client_utils import FormatterProtocol, logging_formatter, validate_parameter

from ..import_utils import optional_import_block, require_optional_import
from ..llm_config import LLMConfigEntry, register_llm_config
from .oai_models import ChatCompletion, ChatCompletionMessage, ChatCompletionMessageToolCall, Choice, CompletionUsage

with optional_import_block():
    from cohere import ClientV2 as CohereV2
    from cohere.types import ToolResult

logger = logging.getLogger(__name__)
if not logger.handlers:
    # Add the console handler.
    _ch = logging.StreamHandler(stream=sys.stdout)
    _ch.setFormatter(logging_formatter)
    logger.addHandler(_ch)


COHERE_PRICING_1K = {
    "command-r-plus": (0.003, 0.015),
    "command-r": (0.0005, 0.0015),
    "command-nightly": (0.00025, 0.00125),
    "command": (0.015, 0.075),
    "command-light": (0.008, 0.024),
    "command-light-nightly": (0.008, 0.024),
}


@register_llm_config
class CohereLLMConfigEntry(LLMConfigEntry):
    api_type: Literal["cohere"] = "cohere"
    temperature: float = Field(default=0.3, ge=0)
    max_tokens: Optional[int] = Field(default=None, ge=0)
    k: int = Field(default=0, ge=0, le=500)
    p: float = Field(default=0.75, ge=0.01, le=0.99)
    seed: Optional[int] = None
    frequency_penalty: float = Field(default=0, ge=0, le=1)
    presence_penalty: float = Field(default=0, ge=0, le=1)
    client_name: Optional[str] = None
    strict_tools: bool = False
    stream: bool = False
    tool_choice: Optional[Literal["NONE", "REQUIRED"]] = None

    def create_client(self):
        raise NotImplementedError("CohereLLMConfigEntry.create_client is not implemented.")


class CohereClient:
    """Client for Cohere's API."""

    def __init__(self, **kwargs):
        """Requires api_key or environment variable to be set

        Args:
            **kwargs: The keyword arguments to pass to the Cohere API.
        """
        # Ensure we have the api_key upon instantiation
        self.api_key = kwargs.get("api_key")
        if not self.api_key:
            self.api_key = os.getenv("COHERE_API_KEY")

        assert self.api_key, (
            "Please include the api_key in your config list entry for Cohere or set the COHERE_API_KEY env variable."
        )

        # Store the response format, if provided (for structured outputs)
        self._response_format: Optional[Type[BaseModel]] = None

    def message_retrieval(self, response) -> list:
        """Retrieve and return a list of strings or a list of Choice.Message from the response.

        NOTE: if a list of Choice.Message is returned, it currently needs to contain the fields of OpenAI's ChatCompletion Message object,
        since that is expected for function or tool calling in the rest of the codebase at the moment, unless a custom agent is being used.
        """
        return [choice.message for choice in response.choices]

    def cost(self, response) -> float:
        return response.cost

    @staticmethod
    def get_usage(response) -> dict:
        """Return usage summary of the response using RESPONSE_USAGE_KEYS."""
        # ...  # pragma: no cover
        return {
            "prompt_tokens": response.usage.prompt_tokens,
            "completion_tokens": response.usage.completion_tokens,
            "total_tokens": response.usage.total_tokens,
            "cost": response.cost,
            "model": response.model,
        }

    def parse_params(self, params: dict[str, Any]) -> dict[str, Any]:
        """Loads the parameters for Cohere API from the passed in parameters and returns a validated set. Checks types, ranges, and sets defaults"""
        cohere_params = {}

        # Check that we have what we need to use Cohere's API
        # We won't enforce the available models as they are likely to change
        cohere_params["model"] = params.get("model")
        assert cohere_params["model"], (
            "Please specify the 'model' in your config list entry to nominate the Cohere model to use."
        )

        # Handle structured output response format from Pydantic model
        if "response_format" in params and params["response_format"] is not None:
            self._response_format = params.get("response_format")

            response_format = params["response_format"]

            # Check if it's a Pydantic model
            if hasattr(response_format, "model_json_schema"):
                # Get the JSON schema from the Pydantic model
                schema = response_format.model_json_schema()

                def resolve_ref(ref: str, defs: dict) -> dict:
                    """Resolve a $ref to its actual schema definition"""
                    # Extract the definition name from "#/$defs/Name"
                    def_name = ref.split("/")[-1]
                    return defs[def_name]

                def ensure_type_fields(obj: dict, defs: dict) -> dict:
                    """Recursively ensure all objects in the schema have a type and properties field"""
                    if isinstance(obj, dict):
                        # If it has a $ref, replace it with the actual definition
                        if "$ref" in obj:
                            ref_def = resolve_ref(obj["$ref"], defs)
                            # Merge the reference definition with any existing fields
                            obj = {**ref_def, **obj}
                            # Remove the $ref as we've replaced it
                            del obj["$ref"]

                        # Process each value recursively
                        return {
                            k: ensure_type_fields(v, defs) if isinstance(v, (dict, list)) else v for k, v in obj.items()
                        }
                    elif isinstance(obj, list):
                        return [ensure_type_fields(item, defs) for item in obj]
                    return obj

                # Make a copy of $defs before processing
                defs = schema.get("$defs", {})

                # Process the schema
                processed_schema = ensure_type_fields(schema, defs)

                cohere_params["response_format"] = {"type": "json_object", "json_schema": processed_schema}
            else:
                raise ValueError("response_format must be a Pydantic BaseModel")

        # Handle strict tools parameter for structured outputs with tools
        if "tools" in params:
            cohere_params["strict_tools"] = validate_parameter(params, "strict_tools", bool, False, False, None, None)

        # Validate allowed Cohere parameters
        # https://docs.cohere.com/reference/chat
        if "temperature" in params:
            cohere_params["temperature"] = validate_parameter(
                params, "temperature", (int, float), False, 0.3, (0, None), None
            )

        if "max_tokens" in params:
            cohere_params["max_tokens"] = validate_parameter(params, "max_tokens", int, True, None, (0, None), None)

        if "k" in params:
            cohere_params["k"] = validate_parameter(params, "k", int, False, 0, (0, 500), None)

        if "p" in params:
            cohere_params["p"] = validate_parameter(params, "p", (int, float), False, 0.75, (0.01, 0.99), None)

        if "seed" in params:
            cohere_params["seed"] = validate_parameter(params, "seed", int, True, None, None, None)

        if "frequency_penalty" in params:
            cohere_params["frequency_penalty"] = validate_parameter(
                params, "frequency_penalty", (int, float), True, 0, (0, 1), None
            )

        if "presence_penalty" in params:
            cohere_params["presence_penalty"] = validate_parameter(
                params, "presence_penalty", (int, float), True, 0, (0, 1), None
            )

        if "tool_choice" in params:
            cohere_params["tool_choice"] = validate_parameter(
                params, "tool_choice", str, True, None, None, ["NONE", "REQUIRED"]
            )

        return cohere_params

    @require_optional_import("cohere", "cohere")
    def create(self, params: dict) -> ChatCompletion:
        messages = params.get("messages", [])
        client_name = params.get("client_name") or "AG2"
        cohere_tool_names = set()
        tool_calls_modified_ids = set()

        # Parse parameters to the Cohere API's parameters
        cohere_params = self.parse_params(params)

        cohere_params["messages"] = messages

        if "tools" in params:
            cohere_tool_names = set([tool["function"]["name"] for tool in params["tools"]])
            cohere_params["tools"] = params["tools"]

        # Strip out name
        for message in cohere_params["messages"]:
            message_name = message.pop("name", "")
            # Extract and prepend name to content or tool_plan if available
            message["content"] = (
                f"{message_name}: {(message.get('content') or message.get('tool_plan'))}"
                if message_name
                else (message.get("content") or message.get("tool_plan"))
            )

            # Handle tool calls
            if message.get("tool_calls") is not None and len(message["tool_calls"]) > 0:
                message["tool_plan"] = message.get("tool_plan", message["content"])
                del message["content"]  # Remove content as tool_plan is prioritized

                # If tool call name is missing or not recognized, modify role and content
                for tool_call in message["tool_calls"] or []:
                    if (not tool_call.get("function", {}).get("name")) or tool_call.get("function", {}).get(
                        "name"
                    ) not in cohere_tool_names:
                        message["role"] = "assistant"
                        message["content"] = f"{message.pop('tool_plan', '')}{str(message['tool_calls'])}"
                        tool_calls_modified_ids = tool_calls_modified_ids.union(
                            set([tool_call.get("id") for tool_call in message["tool_calls"]])
                        )
                        del message["tool_calls"]
                        break

            # Adjust role if message comes from a tool with a modified ID
            if message.get("role") == "tool":
                tool_id = message.get("tool_call_id")
                if tool_id in tool_calls_modified_ids:
                    message["role"] = "user"
                    del message["tool_call_id"]  # Remove the tool call ID

        # We use chat model by default
        client = CohereV2(api_key=self.api_key, client_name=client_name)

        # Token counts will be returned
        prompt_tokens = 0
        completion_tokens = 0
        total_tokens = 0

        # Stream if in parameters
        streaming = params.get("stream")
        cohere_finish = "stop"
        tool_calls = None
        ans = None
        if streaming:
            response = client.chat_stream(**cohere_params)
            # Streaming...
            ans = ""
            plan = ""
            prompt_tokens = 0
            completion_tokens = 0
            for chunk in response:
                if chunk.type == "content-delta":
                    ans = ans + chunk.delta.message.content.text
                elif chunk.type == "tool-plan-delta":
                    plan = plan + chunk.delta.message.tool_plan
                elif chunk.type == "tool-call-start":
                    cohere_finish = "tool_calls"

                    # Initialize a new tool call
                    tool_call = chunk.delta.message.tool_calls
                    current_tool = {
                        "id": tool_call.id,
                        "type": "function",
                        "function": {"name": tool_call.function.name, "arguments": ""},
                    }
                elif chunk.type == "tool-call-delta":
                    # Progressively build the arguments as they stream in
                    if current_tool is not None:
                        current_tool["function"]["arguments"] += chunk.delta.message.tool_calls.function.arguments
                elif chunk.type == "tool-call-end":
                    # Append the finished tool call to the list
                    if current_tool is not None:
                        if tool_calls is None:
                            tool_calls = []
                        tool_calls.append(ChatCompletionMessageToolCall(**current_tool))
                        current_tool = None
                elif chunk.type == "message-start":
                    response_id = chunk.id
                elif chunk.type == "message-end":
                    prompt_tokens = (
                        chunk.delta.usage.billed_units.input_tokens
                    )  # Note total (billed+non-billed) available with ...usage.tokens...
                    completion_tokens = chunk.delta.usage.billed_units.output_tokens

            total_tokens = prompt_tokens + completion_tokens
        else:
            response = client.chat(**cohere_params)

            if response.message.tool_calls is not None:
                ans = response.message.tool_plan
                cohere_finish = "tool_calls"
                tool_calls = []
                for tool_call in response.message.tool_calls:
                    # if parameters are null, clear them out (Cohere can return a string "null" if no parameter values)

                    tool_calls.append(
                        ChatCompletionMessageToolCall(
                            id=tool_call.id,
                            function={
                                "name": tool_call.function.name,
                                "arguments": (
                                    "" if tool_call.function.arguments is None else tool_call.function.arguments
                                ),
                            },
                            type="function",
                        )
                    )
            else:
                ans: str = response.message.content[0].text

            # Not using billed_units, but that may be better for cost purposes
            prompt_tokens = (
                response.usage.billed_units.input_tokens
            )  # Note total (billed+non-billed) available with ...usage.tokens...
            completion_tokens = response.usage.billed_units.output_tokens
            total_tokens = prompt_tokens + completion_tokens

            response_id = response.id

        # Clean up structured output if needed
        if self._response_format:
            # ans = clean_return_response_format(ans)
            try:
                parsed_response = self._convert_json_response(ans)
                ans = _format_json_response(parsed_response, ans)
            except ValueError as e:
                ans = str(e)

        # 3. convert output
        message = ChatCompletionMessage(
            role="assistant",
            content=ans,
            function_call=None,
            tool_calls=tool_calls,
        )
        choices = [Choice(finish_reason=cohere_finish, index=0, message=message)]

        response_oai = ChatCompletion(
            id=response_id,
            model=cohere_params["model"],
            created=int(time.time()),
            object="chat.completion",
            choices=choices,
            usage=CompletionUsage(
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
            ),
            cost=calculate_cohere_cost(prompt_tokens, completion_tokens, cohere_params["model"]),
        )

        return response_oai

    def _convert_json_response(self, response: str) -> Any:
        """Extract and validate JSON response from the output for structured outputs.
        Args:
            response (str): The response from the API.
        Returns:
            Any: The parsed JSON response.
        """
        if not self._response_format:
            return response

        try:
            # Parse JSON and validate against the Pydantic model
            json_data = json.loads(response)
            return self._response_format.model_validate(json_data)
        except Exception as e:
            raise ValueError(
                f"Failed to parse response as valid JSON matching the schema for Structured Output: {str(e)}"
            )


def _format_json_response(response: Any, original_answer: str) -> str:
    """Formats the JSON response for structured outputs using the format method if it exists."""
    return (
        response.format() if isinstance(response, FormatterProtocol) else clean_return_response_format(original_answer)
    )


def extract_to_cohere_tool_results(tool_call_id: str, content_output: str, all_tool_calls) -> list[dict[str, Any]]:
    temp_tool_results = []

    for tool_call in all_tool_calls:
        if tool_call["id"] == tool_call_id:
            call = {
                "name": tool_call["function"]["name"],
                "parameters": json.loads(
                    tool_call["function"]["arguments"] if tool_call["function"]["arguments"] != "" else "{}"
                ),
            }
            output = [{"value": content_output}]
            temp_tool_results.append(ToolResult(call=call, outputs=output))
    return temp_tool_results


def calculate_cohere_cost(input_tokens: int, output_tokens: int, model: str) -> float:
    """Calculate the cost of the completion using the Cohere pricing."""
    total = 0.0

    if model in COHERE_PRICING_1K:
        input_cost_per_k, output_cost_per_k = COHERE_PRICING_1K[model]
        input_cost = (input_tokens / 1000) * input_cost_per_k
        output_cost = (output_tokens / 1000) * output_cost_per_k
        total = input_cost + output_cost
    else:
        warnings.warn(f"Cost calculation not available for {model} model", UserWarning)

    return total


def clean_return_response_format(response_str: str) -> str:
    """Clean up the response string by parsing through json library."""
    # Parse the string to a JSON object to handle escapes
    data = json.loads(response_str)

    # Convert back to JSON string with minimal formatting
    return json.dumps(data)


class CohereError(Exception):
    """Base class for other Cohere exceptions"""

    pass


class CohereRateLimitError(CohereError):
    """Raised when rate limit is exceeded"""

    pass
