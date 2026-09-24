"""This file contains various formatting checks used to reprompt an agent for correctly formatted responses."""
from typing import List
import json
import yaml
import re
from mm_agents.os_symphony.utils.common_utils import (
    extract_agent_functions,
    parse_code_from_string,
    split_thinking_response,
)


single_action_check = (
    lambda response: len(extract_agent_functions(parse_code_from_string(response))) == 1
)
single_action_error_msg = (
    "Incorrect code: There must be a single agent action in the code response."
)
SINGLE_ACTION_FORMATTER = lambda response: (
    single_action_check(response),
    single_action_error_msg,
)


def code_valid_check(tool_config, response):
    code = parse_code_from_string(response)
    print(f'[code_valid_check] parsed code is: {code}')

    # check if the action is pre-defined
    with open(tool_config, 'r', encoding='utf-8') as f:
        config = yaml.safe_load(f)
    valid_methods = set(config['tools'].keys())

    pattern = r"^agent\.(\w+)\(.*\)$"
    
    match = re.match(pattern, code.strip(), re.DOTALL)
    
    if match:
        method_name = match.group(1)
        print(f'[code_valid_check]: method is {method_name}')
        if method_name in valid_methods:
            return True
        else:
            return False
    else:
        return False


code_valid_error_msg = "Incorrect code: The agent action must be a SINGLE and VALID function and use valid parameters from the docstring list."
CODE_VALID_FORMATTER = lambda tool_config, response: (
    code_valid_check(tool_config, response),
    code_valid_error_msg,
)

thoughts_answer_tag_check = lambda response: split_thinking_response(response)[1] != ""
thoughts_answer_tag_error_msg = "Incorrect response: The response must contain both <thoughts>...</thoughts> and <answer>...</answer> tags."
THOUGHTS_ANSWER_TAG_FORMATTER = lambda response: (
    thoughts_answer_tag_check(response),
    thoughts_answer_tag_error_msg,
)

integer_answer_check = (
    lambda response: split_thinking_response(response)[0].strip().isdigit()
)
integer_answer_error_msg = (
    "Incorrect response: The <answer>...</answer> tag must contain a single integer."
)
INTEGER_ANSWER_FORMATTER = lambda response: (
    integer_answer_check(response),
    integer_answer_error_msg,
)


def json_answer_check(response: str, required_fields: List[str]) -> bool:
    """
    一个只返回 True/False 的检查函数。
    """
    try:
        answer_str = parse_code_from_string(response)
        
        if len(answer_str) == 0:
            return False

        data = json.loads(answer_str)

        if not isinstance(data, dict):
            return False

        if set(required_fields) - set(data.keys()):
            return False
        
        return True
        
    except Exception:
        return False


json_answer_error_msg = (
    "Incorrect response: The (Answer) part must contain a valid JSON object that includes ALL required keys and need to be wrapped by ```json and ```"
)


JSON_ANSWER_FORMATTER = lambda response, required_fields: (
    json_answer_check(required_fields, response),
    json_answer_error_msg,
)
