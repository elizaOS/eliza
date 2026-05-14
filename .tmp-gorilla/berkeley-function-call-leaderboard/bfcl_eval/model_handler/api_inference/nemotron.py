import os
import re

from bfcl_eval.model_handler.api_inference.openai_completion import (
    OpenAICompletionsHandler,
)
from bfcl_eval.model_handler.utils import (
    combine_consecutive_user_prompts,
    convert_system_prompt_into_user_prompt,
    default_decode_ast_prompting,
    default_decode_execute_prompting,
)
from openai import OpenAI
from overrides import override


class NemotronHandler(OpenAICompletionsHandler):
    """Handler for the LLaMA 3.1 Nemotron Ultra 253B v1 model.

    This handler extends NvidiaHandler to support the Nemotron model's XML-based
    function calling format. The model expects:
    - <TOOLCALL>[function_calls]</TOOLCALL> for function calls
    - <AVAILABLE_TOOLS>{functions}</AVAILABLE_TOOLS> for function documentation
    """

    def __init__(
        self,
        model_name,
        temperature,
        registry_name,
        is_fc_model,
        **kwargs,
    ) -> None:
        super().__init__(model_name, temperature, registry_name, is_fc_model, **kwargs)
        self.client = OpenAI(
            base_url="https://integrate.api.nvidia.com/v1",
            api_key=os.getenv("NVIDIA_API_KEY"),
        )

    # Although Nemotron is a FC model, its endpoint does not take in function docs, but instead have them as part of the system prompt.
    # So we use the _query_prompting method for FC inference.
    _query_FC = OpenAICompletionsHandler._query_prompting

    def _format_system_prompt(self, prompts, function_docs, test_category):
        """Format the system prompt in the Nemotron-specific XML format."""

        system_prompt_template = """You are an expert in composing functions. You are given a question and a set of possible functions.
Based on the question, you will need to make one or more function/tool calls to achieve the purpose.
If none of the function can be used, point it out. If the given question lacks the parameters required by the function,
also point it out. You should only return the function call in tools call sections.

If you decide to invoke any of the function(s), you MUST put it in the format of <TOOLCALL>[func_name1(params_name1=params_value1, params_name2=params_value2...), func_name2(params)]</TOOLCALL>

You SHOULD NOT include any other text in the response.
Here is a list of functions in JSON format that you can invoke.

<AVAILABLE_TOOLS>{functions}</AVAILABLE_TOOLS>

{user_prompt}"""

        # Extract the first user message content (if any) and remove it from the list.
        user_prompt = ""
        for idx, msg in enumerate(prompts):
            if msg["role"] == "user":
                user_prompt = msg["content"]
                # Delete the user message – it will be folded into the system prompt.
                prompts.pop(idx)
                break

        system_prompt = system_prompt_template.format(
            functions=function_docs, user_prompt=user_prompt
        )

        # Insert the system prompt at the beginning of the list.
        prompts.insert(0, {"role": "system", "content": system_prompt})

        return prompts

    @override
    def _pre_query_processing_FC(self, inference_data: dict, test_entry: dict) -> dict:
        """Process the input query and format it for the Nemotron model."""
        functions: list = test_entry["function"]
        test_category: str = test_entry["id"].rsplit("_", 1)[0]

        for round_idx in range(len(test_entry["question"])):
            test_entry["question"][round_idx] = convert_system_prompt_into_user_prompt(
                test_entry["question"][round_idx]
            )
            test_entry["question"][round_idx] = combine_consecutive_user_prompts(
                test_entry["question"][round_idx]
            )

        test_entry["question"][0] = self._format_system_prompt(
            test_entry["question"][0], functions, test_category
        )

        inference_data["message"] = []
        return inference_data

    @override
    def decode_ast(self, result, language, has_tool_call_tag):
        """Extract function calls from the Nemotron XML format."""
        # Extract content between TOOLCALL tags
        toolcall_match = re.search(r"<TOOLCALL>(.*?)</TOOLCALL>", result, re.DOTALL)
        if not toolcall_match:
            return []

        # Get the function call string
        func_call_str = toolcall_match.group(1)

        return default_decode_ast_prompting(func_call_str, language, has_tool_call_tag)

    @override
    def decode_execute(self, result, has_tool_call_tag):
        """Convert Nemotron response to executable function calls."""
        # Extract content between TOOLCALL tags
        toolcall_match = re.search(r"<TOOLCALL>(.*?)</TOOLCALL>", result, re.DOTALL)
        if not toolcall_match:
            return []

        # Get the function call string
        func_call_str = toolcall_match.group(1)

        return default_decode_execute_prompting(func_call_str, has_tool_call_tag)
