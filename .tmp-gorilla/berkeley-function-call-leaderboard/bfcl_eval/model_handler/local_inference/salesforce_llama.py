import json

from bfcl_eval.model_handler.local_inference.base_oss_handler import OSSHandler
from overrides import override


class SalesforceLlamaHandler(OSSHandler):
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
    def _format_prompt(self, messages, function):
        formatted_prompt = "<|begin_of_text|>"

        system_message = "You are a helpful assistant that can use tools. You are developed by Salesforce xLAM team."
        remaining_messages = messages
        if messages[0]["role"] == "system":
            system_message = messages[0]["content"].strip()
            remaining_messages = messages[1:]

        # Format system message with tool instructions
        formatted_prompt += "<|start_header_id|>system<|end_header_id|>\n\n"
        formatted_prompt += system_message + "\n"
        formatted_prompt += "You have access to a set of tools. When using tools, make calls in a single JSON array: \n\n"
        formatted_prompt += '[{"name": "tool_call_name", "arguments": {"arg1": "value1", "arg2": "value2"}}, ... (additional parallel tool calls as needed)]\n\n'
        formatted_prompt += "If no tool is suitable, state that explicitly. If the user's input lacks required parameters, ask for clarification. "
        formatted_prompt += "Do not interpret or respond until tool results are returned. Once they are available, process them or make additional calls if needed. "
        formatted_prompt += "For tasks that don't require tools, such as casual conversation or general advice, respond directly in plain text. The available tools are:\n\n"

        for func in function:
            formatted_prompt += json.dumps(func, indent=4) + "\n\n"
        formatted_prompt += "<|eot_id|>"

        # Format conversation messages
        for message in remaining_messages:
            if message["role"] == "tool":
                formatted_prompt += "<|start_header_id|>ipython<|end_header_id|>\n\n"
                if isinstance(message["content"], (dict, list)):
                    formatted_prompt += json.dumps(message["content"])
                else:
                    formatted_prompt += message["content"]
                formatted_prompt += "<|eot_id|>"
            elif "tool_calls" in message and message["tool_calls"]:
                formatted_prompt += "<|start_header_id|>assistant<|end_header_id|>\n\n"
                tool_calls = []
                for tool_call in message["tool_calls"]:
                    tool_calls.append(
                        {
                            "name": tool_call["function"]["name"],
                            "arguments": json.loads(tool_call["function"]["arguments"]),
                        }
                    )
                formatted_prompt += json.dumps(tool_calls) + "<|eot_id|>"
            else:
                formatted_prompt += f"<|start_header_id|>{message['role']}<|end_header_id|>\n\n{message['content'].strip()}<|eot_id|>"

        formatted_prompt += "<|start_header_id|>assistant<|end_header_id|>\n\n"
        return formatted_prompt

    @override
    def decode_ast(self, result, language, has_tool_call_tag):
        try:
            # Parse the JSON array of function calls
            function_calls = json.loads(result)
            if not isinstance(function_calls, list):
                function_calls = [function_calls]
        except json.JSONDecodeError:
            # Fallback for semicolon-separated format
            function_calls = [json.loads(call.strip()) for call in result.split(";")]

        decoded_output = []
        for func_call in function_calls:
            name = func_call["name"]
            arguments = func_call["arguments"]
            decoded_output.append({name: arguments})

        return decoded_output

    @override
    def decode_execute(self, result, has_tool_call_tag):
        try:
            function_calls = json.loads(result)
            if not isinstance(function_calls, list):
                function_calls = [function_calls]
        except json.JSONDecodeError:
            function_calls = [json.loads(call.strip()) for call in result.split(";")]

        execution_list = []
        for func_call in function_calls:
            name = func_call["name"]
            arguments = func_call["arguments"]
            execution_list.append(
                f"{name}({','.join([f'{k}={repr(v)}' for k,v in arguments.items()])})"
            )

        return execution_list

    @override
    def _pre_query_processing_prompting(self, test_entry: dict) -> dict:
        functions: list = test_entry["function"]

        # override the default bfcl system prompt, xLAM uses its own system prompt
        return {"message": [], "function": functions}
