import json
import os
import re
from typing import Any

from bfcl_eval.model_handler.api_inference.openai_completion import (
    OpenAICompletionsHandler,
)
from bfcl_eval.constants.enums import ModelStyle
from openai import OpenAI


class MiningHandler(OpenAICompletionsHandler):
    def __init__(
        self,
        model_name,
        temperature,
        registry_name,
        is_fc_model,
        **kwargs,
    ) -> None:
        super().__init__(model_name, temperature, registry_name, is_fc_model, **kwargs)
        self.model_style = ModelStyle.OPENAI_COMPLETIONS
        self.client = OpenAI(
            base_url= os.getenv("MINING_BASE_URL"),
            api_key=os.getenv("MINING_API_KEY"),
        )

    def decode_ast(self, result, language, has_tool_call_tag):
        decoded_output = []
        for invoked_function in result:
            name = invoked_function["name"]
            params = invoked_function["arguments"]
            decoded_output.append({name: params})
        return decoded_output

    def decode_execute(self, result, has_tool_call_tag):
        too_call_format = []
        for tool_call in result:
            if isinstance(tool_call, dict):
                name = tool_call.get("name", "")
                arguments = tool_call.get("arguments", {})
                args_str = ", ".join(
                    [f"{key}={repr(value)}" for key, value in arguments.items()]
                )
                too_call_format.append(f"{name}({args_str})")
        return too_call_format

    #### Prompting methods ####

    def _pre_query_processing_prompting(self, test_entry: dict) -> dict:
        functions: list = test_entry["function"]
        test_category: str = test_entry["id"].rsplit("_", 1)[0]

        test_entry["question"][0] = self.mining_system_prompt_pre_processing_chat_model(
            test_entry["question"][0], functions, test_category
        )
        return {"message": []}

    def _parse_query_response_prompting(self, api_response: Any) -> dict:
        match = re.search(r'<tool_calls>\n(.*?)\n</tool_calls>', api_response.choices[0].message.content, re.DOTALL)
        tool_calls = api_response.choices[0].message.content
        if match:
           tool_calls =  match.group(1).strip()
        try:
            # tool_calls = tool_calls.replace("'",'"')
            tool_calls = json.loads(tool_calls)
        except:
            pass
        message = api_response.choices[0].message
        return {
            "model_responses": tool_calls,
            "model_responses_message_for_chat_history": message,
            "input_token": api_response.usage.prompt_tokens,
            "output_token": api_response.usage.completion_tokens,
        }

    def mining_system_prompt_pre_processing_chat_model(self,prompts, function_docs, test_category):
        system_pre = """You are a function calling AI model.  
You are provided with function signatures within <tools></tools> XML tags.  
You may call one or more functions to assist with the user query.  
Don't make assumptions about what values to plug into functions.


Here are the available tools:  
<tools>  
{}  
</tools>
"""

        system_suffix = """Use the following pydantic model json schema for each tool call you will make:  
{"title": "FunctionCalls", "type": "array", "properties": {"arguments": {"title": "Arguments", "type": "object"}, "name": {"title": "Name", "type": "string"}}, "required": ["arguments", "name"]}

# Output Format & Constraints

At each turn, you should try your best to complete the user's request in the current turn.

**Reasoning:**  
You FIRST think about the reasoning process as an internal monologue, and then provide the final response. The reasoning MUST be enclosed within <think></think> tags.

**Function Calls:**  
- If you need to call any functions, output function calls within <tool_calls></tool_calls> tags.  
- The entire content inside <tool_calls></tool_calls> MUST be a valid JSON array, where each item is a JSON object with "name" and "arguments" as specified by the schema.  
- NEVER output <tool_calls> and <answer> tags at the same time; only one should appear per turn.  
- Do NOT call tools if the question can be answered directly.

**Final Answer:**  
- If the question can be fully answered based on current information (without tools), use <answer></answer> tags.  
- Inside <answer></answer>, provide only a short, precise answer to the question (not lengthy explanations).  
- Even if you do not know the answer, output your answer inside <answer></answer> as a JSON:  
  - {'answer': "I do not know", "context": "I do not know"}  
  - If you cannot answer the question at all, output: {"answer": "I cannot answer this question", "context": "A short reason explaining why this question cannot be answered"}  

**General Constraints:**  
- At each turn, output ONLY ONE of: <tool_calls></tool_calls> OR <answer></answer> (never both).  
- If you selected <answer></answer>, you MUST NOT propose another tool call even if the question is not answerable.  
- All outputs must strictly follow the above format.  
- Do not insert any additional explanation or commentary outside the specified tags.  
- When using <tool_calls></tool_calls>, the JSON array must not be empty and must strictly conform to the schema above.  
- Be careful not to misuse double quotes in the output json format.  
- Tool Invocation Priority: During intermediate steps, if the final answer cannot yet be derived, you must continue invoking tools until sufficient information is obtained.  

**Final Step Rule:**  
- For multi-step reasoning tasks (e.g., web-search), the FINAL step MUST always end with an <answer> block.  
- Once you output <answer>, you must never output <tool_calls> again.  
- Even if the answer is uncertain or incomplete, you must still provide <answer> in the required format.  

**Double-check Requirement:**  
- Before producing the final <answer>, the model must perform a Double-Check step: re-verify all calculations step-by-step, validate factual claims or flag uncertainty, ensure logical consistency and completeness, and confirm the output follows the required format, then provide the corrected and validated final answer.  

**Dynamic Plan Update:**  
- During double-check, if issues or inconsistencies are found, you must update the plan in <think> and continue invoking tools until the problem is resolved, only then output the final answer.

**Attention**
If no suitable function is found, just respond with XML tags as follows,output your answer inside <answer></answer> as a JSON, don't use <tool_calls></tool_calls>
At any time, make sure that the <think></think> tag contains enough thoughts.

**Example:**

<think>
{reasoning process here}
</think>
<tool_calls>
[{...}, {...}]
</tool_calls>

OR

<think>
{reasoning process here}
</think>
<answer>
{"answer": "...", "context": "..."}
</answer>
"""

        assert type(prompts) == list

        system_prompt = system_pre.format(function_docs)+system_suffix

        # System prompt must be in the first position
        # If the question comes with a system prompt, append its content at the end of the chat template.
        if prompts[0]["role"] == "system":
            prompts[0]["content"] = system_prompt + "\n\n" + prompts[0]["content"]
        # Otherwise, use the system prompt template to create a new system prompt.
        else:
            prompts.insert(
                0,
                {"role": "system", "content": system_prompt},
            )

        return prompts
