import json

from bfcl_eval.model_handler.local_inference.base_oss_handler import OSSHandler
from overrides import override


class Falcon3FCHandler(OSSHandler):
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

    @override
    def _format_prompt(self, messages, function):
        """Format the prompt according to Falcon 3's chat template."""
        tokenizer = self.tokenizer
        formatted_prompt = tokenizer.apply_chat_template(
            messages,
            tools=function,
            tokenize=False,
            add_generation_prompt=True
        )
        return formatted_prompt

    @override
    def decode_ast(self, result, language, has_tool_call_tag):
        """Decode the model's response into AST format."""
        try:
            if "<tool_call>" not in result:
                raise ValueError(f"No <tool_call> found in the model's response: {result}")

            tool_calls_str = result.split("<tool_call>")[1].split("</tool_call>")[0].strip()

            if tool_calls_str.startswith("```") and tool_calls_str.endswith("```"):
                tool_calls_str = tool_calls_str.strip("```").strip()
                if tool_calls_str.startswith("json"):
                    tool_calls_str = tool_calls_str[4:].strip()

            tool_calls = json.loads(tool_calls_str)
            if not isinstance(tool_calls, list):
                tool_calls = [tool_calls]

            # Convert to required format
            decoded_output = []
            for tool_call in tool_calls:
                name = tool_call["name"]
                params = tool_call["arguments"]
                decoded_output.append({name: params})

            return decoded_output
        except (json.JSONDecodeError, KeyError, IndexError):
            raise ValueError(f"Failed to decode the model's response: {result}")

    @override
    def decode_execute(self, result, has_tool_call_tag):
        """Convert the model's response into executable function calls."""
        try:
            if "<tool_call>" not in result:
                raise ValueError(f"No <tool_call> found in the model's response: {result}")

            tool_calls_str = result.split("<tool_call>")[1].split("</tool_call>")[0].strip()

            if tool_calls_str.startswith("```") and tool_calls_str.endswith("```"):
                tool_calls_str = tool_calls_str.strip("```").strip()
                if tool_calls_str.startswith("json"):
                    tool_calls_str = tool_calls_str[4:].strip()

            tool_calls = json.loads(tool_calls_str)
            if not isinstance(tool_calls, list):
                tool_calls = [tool_calls]

            execution_list = []
            for tool_call in tool_calls:
                name = tool_call["name"]
                params = tool_call["arguments"]
                param_str = ",".join([f"{k}={repr(v)}" for k, v in params.items()])
                execution_list.append(f"{name}({param_str})")

            return execution_list
        except (json.JSONDecodeError, KeyError, IndexError):
            raise ValueError(f"Failed to decode the model's response: {result}")

    @override
    def _pre_query_processing_prompting(self, test_entry: dict) -> dict:
        """Pre-process the query before sending it to the model."""
        functions: list = test_entry["function"]

        return {"message": [], "function": functions}
