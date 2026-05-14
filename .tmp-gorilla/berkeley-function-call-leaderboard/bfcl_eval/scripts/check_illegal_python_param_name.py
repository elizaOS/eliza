from keyword import kwlist

from bfcl_eval._llm_response_generation import parse_test_category_argument
from bfcl_eval.constants.eval_config import POSSIBLE_ANSWER_PATH, PROMPT_PATH
from bfcl_eval.utils import (
    is_executable,
    is_java,
    is_js,
    is_relevance_or_irrelevance,
    load_file,
    write_list_of_dicts_to_file,
)

"""
This script checks for illegal function parameter names in Python.
Credit to Pan Yinxu (@Cppowboy) for the original idea and implementation
"""

entry_id_with_problem = set()
test_categories_total, test_filename_total = parse_test_category_argument(["single_turn"])

for test_category, file_path in zip(test_categories_total, test_filename_total):
    # We only care about Python test cases; Java and JavaScript test cases have different rules
    if is_java(test_category) or is_js(test_category):
        continue
    dataset_data = load_file(PROMPT_PATH / file_path)
    for test_entry in dataset_data:
        for function in test_entry["function"]:
            if "parameters" in function and "properties" in function["parameters"]:
                properties = {}
                for param_name, param_description in function["parameters"]["properties"].items():
                    if param_name in kwlist:
                        print("--------------------")
                        print(f"Illegal parameter name: {param_name}")
                        print(f"Entry ID: {test_entry['id']}")
                        print(f"Function: {function['name']}")

                        properties["_" + param_name] = param_description
                        entry_id_with_problem.add(test_entry["id"])
                    else:
                        properties[param_name] = param_description
                function["parameters"]["properties"] = properties
    write_list_of_dicts_to_file(file_path, dataset_data, subdir=PROMPT_PATH)

    if (
        is_executable(test_category)
        or is_relevance_or_irrelevance(test_category)
    ):
        continue

    ground_truth_data = load_file(POSSIBLE_ANSWER_PATH / file_path)
    for ground_truth_entry in ground_truth_data:
        for ground_truth in ground_truth_entry["ground_truth"]:
            ground_truth: dict
            assert len(ground_truth.keys()) == 1
            function_name = list(ground_truth.keys())[0]
            properties = {}
            for param_name, param_description in ground_truth[function_name].items():
                if param_name in kwlist:
                    print("--------------------")
                    print(f"Illegal parameter name: {param_name}")
                    print(f"Ground Truth ID: {ground_truth_entry['id']}")
                    print(f"Function: {function_name}")
                    properties["_" + param_name] = param_description
                    entry_id_with_problem.add(ground_truth_entry["id"])
                else:
                    properties[param_name] = param_description
            ground_truth[function_name] = properties
    write_list_of_dicts_to_file(file_path, ground_truth_data, subdir=POSSIBLE_ANSWER_PATH)

print("The following entries have illegal parameter names and has been fixed:")
print(entry_id_with_problem)
