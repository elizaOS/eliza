import json
from copy import deepcopy

from bfcl_eval._llm_response_generation import parse_test_category_argument
from bfcl_eval.constants.eval_config import UTILS_PATH
from bfcl_eval.utils import (
    write_list_of_dicts_to_file,
    load_dataset_entry,
    load_ground_truth_entry,
)
from bfcl_eval.eval_checker.multi_turn_eval.multi_turn_utils import (
    STATELESS_CLASSES,
    execute_multi_turn_func_call,
)

test_categories_total = parse_test_category_argument(["multi_turn"])

for test_category in test_categories_total:
    dataset_data = load_dataset_entry(test_category)
    ground_truth_data = load_ground_truth_entry(test_category)

    result = []
    for ground_truth_entry, test_entry in zip(ground_truth_data, dataset_data):
        all_inference_log = []
        result.append({"id": test_entry["id"], "ground_truth_log": all_inference_log})

        initial_config: dict = test_entry["initial_config"]
        involved_classes: list = test_entry["involved_classes"]
        test_entry_id: str = test_entry["id"]
        test_category: str = test_entry_id.rsplit("_", 1)[0]

        _, involved_instances = execute_multi_turn_func_call(
            [],
            initial_config,
            involved_classes,
            "ground_truth_conversation",  # the model_name is not important here, could use any string
            test_entry_id,
            long_context=("long_context" in test_category or "composite" in test_category),
            is_evaL_run=False,
        )

        state_log = []
        for class_name, class_instance in involved_instances.items():
            if class_name in STATELESS_CLASSES:
                continue
            class_instance = deepcopy(class_instance)  # Avoid modification in future turns
            state_log.append(
                {
                    "role": "state_info",
                    "class_name": class_name,
                    "content": {
                        key: value
                        for key, value in vars(class_instance).items()
                        if not key.startswith("_")
                    },
                }
            )
        all_inference_log.append(state_log)

        for single_turn_query, single_turn_ground_truth in zip(
            test_entry["question"], ground_truth_entry["ground_truth"]
        ):
            current_turn_inference_log: list[dict] = [
                {"begin_of_turn_query": single_turn_query}
            ]

            execution_results, involved_instances = execute_multi_turn_func_call(
                single_turn_ground_truth,
                initial_config,
                involved_classes,
                "ground_truth_conversation",  # the model_name is not important here, could use any string
                test_entry_id,
                long_context=(
                    "long_context" in test_category or "composite" in test_category
                ),
                is_evaL_run=False,
            )

            for ground_truth, execution_result in zip(
                single_turn_ground_truth, execution_results
            ):
                try:
                    execution_result_copy = json.loads(execution_result)
                except Exception as e:
                    execution_result_copy = execution_result
                    pass

                if (
                    # Backend function returns an error
                    type(execution_result_copy) == dict
                    and "error" in execution_result_copy
                ) or (
                    # Error during the `eval` phase
                    type(execution_result_copy) == str
                    and "Error during execution: " in execution_result_copy
                ):
                    print("------")
                    print(test_entry["id"])
                    print(execution_result)
                    # raise Exception("Ground truth should not have error in execution")

                current_turn_inference_log.append(
                    {"role": "assistant", "content": ground_truth}
                )
                current_turn_inference_log.append(
                    {
                        "role": "tool",
                        "content": execution_result,
                    }
                )

            all_inference_log.append(current_turn_inference_log)

            state_log = []
            for class_name, class_instance in involved_instances.items():
                if class_name in STATELESS_CLASSES:
                    continue
                class_instance = deepcopy(
                    class_instance
                )  # Avoid modification in future turns
                state_log.append(
                    {
                        "role": "state_info",
                        "class_name": class_name,
                        "content": {
                            key: value
                            for key, value in vars(class_instance).items()
                            if not key.startswith("_")
                        },
                    }
                )
            all_inference_log.append(state_log)

    write_list_of_dicts_to_file(
        f"{test_category}_conversation.json",
        result,
        UTILS_PATH / "ground_truth_conversation",
    )
