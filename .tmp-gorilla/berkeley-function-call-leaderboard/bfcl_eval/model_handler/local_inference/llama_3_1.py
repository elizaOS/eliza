import json

from bfcl_eval.model_handler.local_inference.base_oss_handler import OSSHandler
from overrides import override


class LlamaHandler_3_1(OSSHandler):
    """
    Handler for Llama 3.1 series models in function calling mode.
    Per their model card, function calling is handled in the same way as
    the Hugging Face chat template suggests.
    https://www.llama.com/docs/model-cards-and-prompt-formats/llama3_1/#json-based-tool-calling
    
    For all other Llama models, see the LlamaHandler class.
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
        self.model_name_huggingface = model_name.replace("-FC", "")

    @override
    def _format_prompt(self, messages, function):
        """
        "bos_token": "<|begin_of_text|>",
        "chat_template":
        {{- bos_token }}
        {%- if custom_tools is defined %}
            {%- set tools = custom_tools %}
        {%- endif %}
        {%- if not tools_in_user_message is defined %}
            {%- set tools_in_user_message = true %}
        {%- endif %}
        {%- if not date_string is defined %}
            {%- set date_string = "26 Jul 2024" %}
        {%- endif %}
        {%- if not tools is defined %}
            {%- set tools = none %}
        {%- endif %}

        {#- This block extracts the system message, so we can slot it into the right place. #}
        {%- if messages[0]['role'] == 'system' %}
            {%- set system_message = messages[0]['content']|trim %}
            {%- set messages = messages[1:] %}
        {%- else %}
            {%- set system_message = "" %}
        {%- endif %}

        {#- System message + builtin tools #}
        {{- "<|start_header_id|>system<|end_header_id|>\n\n" }}
        {%- if builtin_tools is defined or tools is not none %}
            {{- "Environment: ipython\n" }}
        {%- endif %}
        {%- if builtin_tools is defined %}
            {{- "Tools: " + builtin_tools | reject('equalto', 'code_interpreter') | join(", ") + "\n\n"}}
        {%- endif %}
        {{- "Cutting Knowledge Date: December 2023\n" }}
        {{- "Today Date: " + date_string + "\n\n" }}
        {%- if tools is not none and not tools_in_user_message %}
            {{- "You have access to the following functions. To call a function, please respond with JSON for a function call." }}
            {{- 'Respond in the format {"name": function name, "parameters": dictionary of argument name and its value}.' }}
            {{- "Do not use variables.\n\n" }}
            {%- for t in tools %}
                {{- t | tojson(indent=4) }}
                {{- "\n\n" }}
            {%- endfor %}
        {%- endif %}
        {{- system_message }}
        {{- "<|eot_id|>" }}

        {#- Custom tools are passed in a user message with some extra guidance #}
        {%- if tools_in_user_message and not tools is none %}
            {#- Extract the first user message so we can plug it in here #}
            {%- if messages | length != 0 %}
                {%- set first_user_message = messages[0]['content']|trim %}
                {%- set messages = messages[1:] %}
            {%- else %}
                {{- raise_exception("Cannot put tools in the first user message when there's no first user message!") }}
        {%- endif %}
            {{- '<|start_header_id|>user<|end_header_id|>\n\n' -}}
            {{- "Given the following functions, please respond with a JSON for a function call " }}
            {{- "with its proper arguments that best answers the given prompt.\n\n" }}
            {{- 'Respond in the format {"name": function name, "parameters": dictionary of argument name and its value}.' }}
            {{- "Do not use variables.\n\n" }}
            {%- for t in tools %}
                {{- t | tojson(indent=4) }}
                {{- "\n\n" }}
            {%- endfor %}
            {{- first_user_message + "<|eot_id|>"}}
        {%- endif %}

        {%- for message in messages %}
            {%- if not (message.role == 'ipython' or message.role == 'tool' or 'tool_calls' in message) %}
                {{- '<|start_header_id|>' + message['role'] + '<|end_header_id|>\n\n'+ message['content'] | trim + '<|eot_id|>' }}
            {%- elif 'tool_calls' in message %}
                {%- if not message.tool_calls|length == 1 %}
                    {{- raise_exception("This model only supports single tool-calls at once!") }}
                {%- endif %}
                {%- set tool_call = message.tool_calls[0].function %}
                {%- if builtin_tools is defined and tool_call.name in builtin_tools %}
                    {{- '<|start_header_id|>assistant<|end_header_id|>\n\n' -}}
                    {{- "<|python_tag|>" + tool_call.name + ".call(" }}
                    {%- for arg_name, arg_val in tool_call.arguments | items %}
                        {{- arg_name + '="' + arg_val + '"' }}
                        {%- if not loop.last %}
                            {{- ", " }}
                        {%- endif %}
                        {%- endfor %}
                    {{- ")" }}
                {%- else  %}
                    {{- '<|start_header_id|>assistant<|end_header_id|>\n\n' -}}
                    {{- '{"name": "' + tool_call.name + '", ' }}
                    {{- '"parameters": ' }}
                    {{- tool_call.arguments | tojson }}
                    {{- "}" }}
                {%- endif %}
                {%- if builtin_tools is defined %}
                    {#- This means we're in ipython mode #}
                    {{- "<|eom_id|>" }}
                    {#- This means we're in ipython mode #}
                    {{- "<|eom_id|>" }}
                    {{- "<|eom_id|>" }}
                {%- else %}
                    {{- "<|eot_id|>" }}
                {%- endif %}
            {%- elif message.role == "tool" or message.role == "ipython" %}
                {{- "<|start_header_id|>ipython<|end_header_id|>\n\n" }}
                {%- if message.content is mapping or message.content is iterable %}
                    {{- message.content | tojson }}
                {%- else %}
                    {{- message.content }}
                {%- endif %}
                {{- "<|eot_id|>" }}
            {%- endif %}
        {%- endfor %}
        {%- if add_generation_prompt %}
            {{- '<|start_header_id|>assistant<|end_header_id|>\n\n' }}
        {%- endif %}
        """
        formatted_prompt = "<|begin_of_text|>"

        system_message = ""
        remaining_messages = messages
        if messages[0]["role"] == "system":
            system_message = messages[0]["content"].strip()
            remaining_messages = messages[1:]

        formatted_prompt += "<|start_header_id|>system<|end_header_id|>\n\n"
        formatted_prompt += "Environment: ipython\n"
        formatted_prompt += "Cutting Knowledge Date: December 2023\n"
        formatted_prompt += "Today Date: 26 Jul 2024\n\n"
        formatted_prompt += system_message + "<|eot_id|>"

        # Llama pass in custom tools in first user message
        is_first_user_message = True
        for message in remaining_messages:
            if message["role"] == "user" and is_first_user_message:
                is_first_user_message = False
                formatted_prompt += "<|start_header_id|>user<|end_header_id|>\n\n"
                formatted_prompt += "Given the following functions, please respond with a JSON for a function call "
                formatted_prompt += (
                    "with its proper arguments that best answers the given prompt.\n\n"
                )
                formatted_prompt += 'Respond in the format {"name": function name, "parameters": dictionary of argument name and its value}.'
                formatted_prompt += "Do not use variables.\n\n"
                for func in function:
                    formatted_prompt += json.dumps(func, indent=4) + "\n\n"
                formatted_prompt += f"{message['content'].strip()}<|eot_id|>"

            elif message["role"] == "tool":
                formatted_prompt += "<|start_header_id|>ipython<|end_header_id|>\n\n"
                if isinstance(message["content"], (dict, list)):
                    formatted_prompt += json.dumps(message["content"])
                else:
                    formatted_prompt += message["content"]
                formatted_prompt += "<|eot_id|>"

            else:
                formatted_prompt += f"<|start_header_id|>{message['role']}<|end_header_id|>\n\n{message['content'].strip()}<|eot_id|>"

        formatted_prompt += "<|start_header_id|>assistant<|end_header_id|>\n\n"

        return formatted_prompt

    @override
    def decode_ast(self, result, language, has_tool_call_tag):
        result = result.replace("<|python_tag|>", "")
        # Llama sometimes separates the function calls with `;` and sometimes with `,`
        if ";" in result:
            """
            "<|python_tag|>{\"name\": \"calc_binomial_probability\", \"parameters\": {\"n\": \"10\", \"k\": \"3\", \"p\": \"0\"}}; {\"name\": \"calc_binomial_probability\", \"parameters\": {\"n\": \"15\", \"k\": \"5\", \"p\": \"0\"}}; {\"name\": \"calc_binomial_probability\", \"parameters\": {\"n\": \"20\", \"k\": \"7\", \"p\": \"0\"}}"
            """
            function_calls = result.split(";")
            function_calls = [json.loads(func_call) for func_call in function_calls]
        else:
            """
            "[\n    {\"name\": \"calculate_permutations\", \"parameters\": {\"n\": \"20\", \"k\": \"5\"}},\n    {\"name\": \"calculate_permutations\", \"parameters\": {\"n\": \"12\", \"k\": \"5\"}},\n    {\"name\": \"calculate_permutations\", \"parameters\": {\"n\": \"10\", \"k\": \"3\"}}\n]"
            """
            function_calls = eval(result)
            if type(function_calls) == dict:
                function_calls = [function_calls]

        decoded_output = []
        for func_call in function_calls:
            name = func_call["name"]
            params = func_call["parameters"]
            decoded_output.append({name: params})

        return decoded_output

    @override
    def decode_execute(self, result, has_tool_call_tag):
        result = result.replace("<|python_tag|>", "")
        # Llama sometimes separates the function calls with `;` and sometimes with `,`
        if ";" in result:
            function_calls = result.split(";")
            function_calls = [json.loads(func_call) for func_call in function_calls]
        else:
            function_calls = eval(result)
            if type(function_calls) == dict:
                function_calls = [function_calls]

        execution_list = []
        for func_call in function_calls:
            name = func_call["name"]
            params = func_call["parameters"]
            execution_list.append(
                f"{name}({','.join([f'{k}={repr(v)}' for k,v in params.items()])})"
            )

        return execution_list

    @override
    def _pre_query_processing_prompting(self, test_entry: dict) -> dict:
        functions: list = test_entry["function"]

        # Llama use its own system prompt

        return {"message": [], "function": functions}
