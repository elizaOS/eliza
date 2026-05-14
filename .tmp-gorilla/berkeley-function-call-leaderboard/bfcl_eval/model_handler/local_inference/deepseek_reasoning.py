from typing import Any

from bfcl_eval.model_handler.local_inference.base_oss_handler import OSSHandler
from bfcl_eval.model_handler.utils import (
    combine_consecutive_user_prompts,
    convert_system_prompt_into_user_prompt,
    system_prompt_pre_processing_chat_model,
)
from overrides import override


class DeepseekReasoningHandler(OSSHandler):
    """
    This is the local inference handler for the Deepseek reasoning model such as DeepSeek-R1.
    We DO also support the benchmark/inference for DeepSeek-R1 model through their official hosted API. The `api_inference/deepseek.py` file contains the implementation for the API inference handler.
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

    @override
    def _pre_query_processing_prompting(self, test_entry: dict) -> dict:
        functions: list = test_entry["function"]
        test_entry_id: str = test_entry["id"]

        # Deepseek R1 currently don't have native function calling support, so we still need the system prompt
        test_entry["question"][0] = system_prompt_pre_processing_chat_model(
            test_entry["question"][0], functions, test_entry_id
        )

        # Per https://huggingface.co/deepseek-ai/DeepSeek-R1#usage-recommendations
        # Avoid adding a system prompt; all instructions should be contained within the user prompt.
        for round_idx in range(len(test_entry["question"])):
            test_entry["question"][round_idx] = convert_system_prompt_into_user_prompt(
                test_entry["question"][round_idx]
            )
            test_entry["question"][round_idx] = combine_consecutive_user_prompts(
                test_entry["question"][round_idx]
            )

        return {"message": [], "function": functions}

    @override
    def _format_prompt(self, messages, function):
        """
        "bos_token": {
            "__type": "AddedToken",
            "content": "<｜begin▁of▁sentence｜>",
            "lstrip": false,
            "normalized": true,
            "rstrip": false,
            "single_word": false
        },
        "chat_template": "{% if not add_generation_prompt is defined %}{% set add_generation_prompt = false %}{% endif %}{% set ns = namespace(is_first=false, is_tool=false, is_output_first=true, system_prompt='', is_first_sp=true) %}{%- for message in messages %}{%- if message['role'] == 'system' %}{%- if ns.is_first_sp %}{% set ns.system_prompt = ns.system_prompt + message['content'] %}{% set ns.is_first_sp = false %}{%- else %}{% set ns.system_prompt = ns.system_prompt + '\\n\\n' + message['content'] %}{%- endif %}{%- endif %}{%- endfor %}{{ bos_token }}{{ ns.system_prompt }}{%- for message in messages %}{%- if message['role'] == 'user' %}{%- set ns.is_tool = false -%}{{'<｜User｜>' + message['content']}}{%- endif %}{%- if message['role'] == 'assistant' and 'tool_calls' in message %}{%- set ns.is_tool = false -%}{%- for tool in message['tool_calls'] %}{%- if not ns.is_first %}{%- if message['content'] is none %}{{'<｜Assistant｜><｜tool▁calls▁begin｜><｜tool▁call▁begin｜>' + tool['type'] + '<｜tool▁sep｜>' + tool['function']['name'] + '\\n' + '```json' + '\\n' + tool['function']['arguments'] + '\\n' + '```' + '<｜tool▁call▁end｜>'}}{%- else %}{{'<｜Assistant｜>' + message['content'] + '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>' + tool['type'] + '<｜tool▁sep｜>' + tool['function']['name'] + '\\n' + '```json' + '\\n' + tool['function']['arguments'] + '\\n' + '```' + '<｜tool▁call▁end｜>'}}{%- endif %}{%- set ns.is_first = true -%}{%- else %}{{'\\n' + '<｜tool▁call▁begin｜>' + tool['type'] + '<｜tool▁sep｜>' + tool['function']['name'] + '\\n' + '```json' + '\\n' + tool['function']['arguments'] + '\\n' + '```' + '<｜tool▁call▁end｜>'}}{%- endif %}{%- endfor %}{{'<｜tool▁calls▁end｜><｜end▁of▁sentence｜>'}}{%- endif %}{%- if message['role'] == 'assistant' and 'tool_calls' not in message %}{%- if ns.is_tool %}{{'<｜tool▁outputs▁end｜>' + message['content'] + '<｜end▁of▁sentence｜>'}}{%- set ns.is_tool = false -%}{%- else %}{% set content = message['content'] %}{% if '</think>' in content %}{% set content = content.split('</think>')[-1] %}{% endif %}{{'<｜Assistant｜>' + content + '<｜end▁of▁sentence｜>'}}{%- endif %}{%- endif %}{%- if message['role'] == 'tool' %}{%- set ns.is_tool = true -%}{%- if ns.is_output_first %}{{'<｜tool▁outputs▁begin｜><｜tool▁output▁begin｜>' + message['content'] + '<｜tool▁output▁end｜>'}}{%- set ns.is_output_first = false %}{%- else %}{{'<｜tool▁output▁begin｜>' + message['content'] + '<｜tool▁output▁end｜>'}}{%- endif %}{%- endif %}{%- endfor -%}{% if ns.is_tool %}{{'<｜tool▁outputs▁end｜>'}}{% endif %}{% if add_generation_prompt and not ns.is_tool %}{{'<｜Assistant｜><think>\\n'}}{% endif %}"
        """
        bos_token = "<｜begin▁of▁sentence｜>"

        is_first = False
        is_tool = False
        is_output_first = True
        is_first_sp = True

        formatted_prompt = bos_token

        # Process system messages
        for message in messages:
            if message["role"] == "system":
                if is_first_sp:
                    formatted_prompt += message["content"]
                    is_first_sp = False
                else:
                    formatted_prompt += f"\n\n{message['content']}"

        # Process remaining messages
        for message in messages:
            if message["role"] == "user":
                is_tool = False
                formatted_prompt += f"<｜User｜>{message['content']}"

            elif message["role"] == "assistant" and "tool_calls" in message:
                is_tool = False
                for tool in message["tool_calls"]:
                    if not is_first:
                        if message.get("content") is None:
                            formatted_prompt += f"<｜Assistant｜><｜tool▁calls▁begin｜><｜tool▁call▁begin｜>{tool['type']}<｜tool▁sep｜>{tool['function']['name']}\n```json\n{tool['function']['arguments']}\n```<｜tool▁call▁end｜>"
                        else:
                            formatted_prompt += f"<｜Assistant｜>{message['content']}<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>{tool['type']}<｜tool▁sep｜>{tool['function']['name']}\n```json\n{tool['function']['arguments']}\n```<｜tool▁call▁end｜>"
                        is_first = True
                    else:
                        formatted_prompt += f"\n<｜tool▁call▁begin｜>{tool['type']}<｜tool▁sep｜>{tool['function']['name']}\n```json\n{tool['function']['arguments']}\n```<｜tool▁call▁end｜>"
                formatted_prompt += "<｜tool▁calls▁end｜><｜end▁of▁sentence｜>"

            elif message["role"] == "assistant" and "tool_calls" not in message:
                if is_tool:
                    formatted_prompt += (
                        f"<｜tool▁outputs▁end｜>{message['content']}<｜end▁of▁sentence｜>"
                    )
                    is_tool = False
                else:
                    content = message["content"]
                    if "</think>" in content:
                        content = content.split("</think>")[-1]
                    formatted_prompt += f"<｜Assistant｜>{content}<｜end▁of▁sentence｜>"

            elif message["role"] == "tool":
                is_tool = True
                if is_output_first:
                    formatted_prompt += f"<｜tool▁outputs▁begin｜><｜tool▁output▁begin｜>{message['content']}<｜tool▁output▁end｜>"
                    is_output_first = False
                else:
                    formatted_prompt += (
                        f"<｜tool▁output▁begin｜>{message['content']}<｜tool▁output▁end｜>"
                    )

        if is_tool:
            formatted_prompt += "<｜tool▁outputs▁end｜>"

        if not is_tool:
            formatted_prompt += "<｜Assistant｜><think>\n"

        return formatted_prompt

    @override
    def _add_execution_results_prompting(
        self, inference_data: dict, execution_results: list[str], model_response_data: dict
    ) -> dict:
        # Deepseek don't take the tool role; so we use the user role to send the tool output
        tool_message = {
            "role": "user",
            "content": [],
        }
        for execution_result, decoded_model_response in zip(
            execution_results, model_response_data["model_responses_decoded"]
        ):
            tool_message["content"].append(
                {
                    "role": "tool",
                    "name": decoded_model_response,
                    "content": execution_result,
                }
            )

        inference_data["message"].append(tool_message)

        return inference_data

    @override
    def _parse_query_response_prompting(self, api_response: Any) -> dict:
        model_response = api_response.choices[0].text
        reasoning_content = ""
        if "</think>" in model_response:
            model_response = model_response.split("</think>")[-1]
            reasoning_content = model_response.split("</think>")[0]

        return {
            "model_responses": model_response,
            "reasoning_content": reasoning_content,
            "model_responses_message_for_chat_history": api_response.choices[0].text,
            "input_token": api_response.usage.prompt_tokens,
            "output_token": api_response.usage.completion_tokens,
        }

    @override
    def _add_assistant_message_prompting(
        self, inference_data: dict, model_response_data: dict
    ) -> dict:
        inference_data["message"].append(
            {
                "role": "assistant",
                "content": model_response_data["model_responses_message_for_chat_history"],
            }
        )
        return inference_data
