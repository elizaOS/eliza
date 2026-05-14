import json
import re


def parse_json_function_call(source_code):
    json_match = re.search(r"\[\s*{.*?}\s*(?:,\s*{.*?}\s*)*\]", source_code, re.DOTALL)
    if json_match:
        source_code = json_match.group(0)

    try:
        json_dict = json.loads(source_code)
    except json.JSONDecodeError as e:
        return []

    function_calls = []
    for function_call in json_dict:
        if isinstance(function_call, dict):
            function_name = function_call["function"]
            arguments = function_call["parameters"]
            function_calls.append({function_name: arguments})
    return function_calls
