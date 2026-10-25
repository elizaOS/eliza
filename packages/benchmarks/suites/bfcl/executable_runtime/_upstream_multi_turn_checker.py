from bfcl_eval.eval_checker.multi_turn_eval.multi_turn_utils import (
    execute_multi_turn_func_call,
    is_empty_execute_response,
)

#### Main functions ####


def multi_turn_checker(
    multi_turn_model_result_list_decoded: list[list[list[str]]],
    multi_turn_ground_truth_list: list[list[str]],
    test_entry: dict,
    test_category: str,
    model_name: str,
) -> dict:
    """
    The main function that checks the correctness of the model's function call execution.
    """

    initial_config: dict = test_entry["initial_config"]
    involved_classes: list = test_entry["involved_classes"]
    test_entry_id: str = test_entry["id"]
    test_category: str = test_entry_id.rsplit("_", 1)[0]
    execution_results: list[dict] = []
    all_turn_model_execution_results: list[str] = []

    # First execute all the function calls
    for turn_index, single_turn_ground_truth_list in enumerate(
        multi_turn_ground_truth_list
    ):
        single_turn_model_response_list = multi_turn_model_result_list_decoded[turn_index]

        # Note that we combine all the sub-step results into a single list, for easier comparison
        single_turn_model_execution_results = []
        single_turn_model_execution_results_uncombined = []
        single_turn_ground_truth_execution_results = []
        model_instances = {}  # Will be overwritten in the for loop
        single_step_model_execution_results = []  # Will be overwritten in the for loop
    
        for single_step_model_response in single_turn_model_response_list:
            single_step_model_execution_results, model_instances = (
                execute_multi_turn_func_call(
                    func_call_list=single_step_model_response,
                    initial_config=initial_config,
                    involved_classes=involved_classes,
                    model_name=model_name,
                    test_entry_id=test_entry_id,
                    long_context=(
                        "long_context" in test_category or "composite" in test_category
                    ),
                    is_evaL_run=True,
                )
            )
            single_turn_model_execution_results.extend(single_step_model_execution_results)
            single_turn_model_execution_results_uncombined.append(single_step_model_execution_results)

        # Execute the ground truth function calls
        single_turn_ground_truth_execution_results, ground_truth_instances = (
            execute_multi_turn_func_call(
                func_call_list=single_turn_ground_truth_list,
                initial_config=initial_config,
                involved_classes=involved_classes,
                model_name=model_name + "_ground_truth",
                test_entry_id=test_entry_id,
                long_context=(
                    "long_context" in test_category or "composite" in test_category
                ),
                is_evaL_run=True,
            )
        )

        all_turn_model_execution_results.extend(single_turn_model_execution_results)
        execution_results.append(
            {
                "model": single_turn_model_execution_results_uncombined,
                "ground_truth": single_turn_ground_truth_execution_results,
            }
        )

        # If the ground truth list is not empty, then the model response list should not be empty
        if len(single_turn_ground_truth_list) > 0:
            if not single_turn_model_response_list or is_empty_execute_response(
                single_turn_model_response_list
            ):
                return {
                    "valid": False,
                    "error_message": f"Model response list is empty for turn {turn_index}",
                    "error_type": "multi_turn:empty_turn_model_response",
                    "details": {
                        "execution_result": execution_results,
                    },
                }

        # If the ground truth list is empty, this is the turn where the model should eventually fail to achieve the user request.
        # The actual check for irrelevance is done in the multi_turn_irrelevance_checker function
        # Note: If the model outputs any function call in this turn, we will still execute it so that the state check at the next turn is accurate.
        if not single_turn_ground_truth_list:
            continue

        ## Check after each turn ##
        assert len(model_instances) == len(
            ground_truth_instances
        ), f"Model instances and ground truth instances do not match in length for turn {turn_index}. Model instances: {len(model_instances)}, Ground truth instances: {len(ground_truth_instances)}"
        assert set(model_instances.keys()) == set(ground_truth_instances.keys())

        # Check the state of the instances
        state_check_result = state_checker(model_instances, ground_truth_instances)
        if not state_check_result["valid"]:
            state_check_result["execution_result"] = execution_results
            return state_check_result

        # Check the response of the function calls
        # We use the all_turn_model_execution_results to accomodate the situation where the model invokes a function in a previous turn, and thus don't need to invoke it again in the current turn.
        response_check_result = response_checker(
            all_turn_model_execution_results,
            single_turn_ground_truth_execution_results,
            turn_index,
        )
        if not response_check_result["valid"]:
            return response_check_result

        # # Check the method invoke order
        # method_invoke_order_check_result = method_invoke_order_checker(
        #     model_instances, ground_truth_instances
        # )
        # if not method_invoke_order_check_result["valid"]:
        #     return method_invoke_order_check_result

    return {"valid": True}


def multi_turn_irrelevance_checker(
    multi_turn_model_result_list_decoded: list[list[list[str]]],
    multi_turn_ground_truth_list: list[list[str]],
) -> dict:
    """
    Check if the model's output are irrelevant when it should be.
    It should be empty when the ground truth is a empty list for that turn.
    """
    for turn_index, single_turn_ground_truth_list in enumerate(
        multi_turn_ground_truth_list
    ):
        single_turn_model_response_list = multi_turn_model_result_list_decoded[turn_index]
        if len(single_turn_ground_truth_list) == 0:
            if is_empty_execute_response(single_turn_model_response_list):
                continue
            else:
                return {
                    "valid": False,
                    "error_message": f"Model outputs valid function calls when it should not for turn {turn_index}.",
                    "error_type": "multi_turn:irrelevance_error:decoder_success",
                    "details": {
                        "model response decoded": single_turn_model_response_list,
                    },
                }
    return {"valid": True}


#### Sub-Chekcers ####


def state_checker(model_instances: dict, ground_truth_instances: dict):
    """
    Checks if, after executing the function calls, the model_instance has the same state (defined by the attributes) as the ground_truth_instance.
    It checks if every instance in the model_instances has the same attributes as their corresponding instance (of the same class) from ground_truth_instances.
    """
    for class_name, ground_truth_instance in ground_truth_instances.items():
        model_instance = model_instances[class_name]
        valid, differences = _compare_instances(model_instance, ground_truth_instance)

        if not valid:
            model_instance_attributes = {
                key: value
                for key, value in vars(model_instance).items()
                if not key.startswith("_")
            }
            ground_truth_instance_attributes = {
                key: value
                for key, value in vars(ground_truth_instance).items()
                if not key.startswith("_")
            }
            # Format the error message for better readability
            return {
                "valid": False,
                "error_message": f"Model instance for {class_name} does not match the state with ground truth instance.",
                "error_type": "multi_turn:instance_state_mismatch",
                "details": {
                    "differences": differences,
                    "model_instance_state": model_instance_attributes,
                    "ground_truth_instance_state": ground_truth_instance_attributes,
                },
            }

    return {"valid": True}


def response_checker(
    model_response_list: list, ground_truth_response_list: list, turn_index: int
):
    """
    Checks if the model_response is a subsequence of the ground_truth_response.
    Each list contains the response of the function calls executed in that single turn.
    """
    # We don't need to enforce the order of the responses, because many entries have parallel operations, and so the model can execute them in any order.
    is_subsequence, missing_items = _is_subsequence_unordered(
        ground_truth_response_list, model_response_list
    )
    if not is_subsequence:
        return {
            "valid": False,
            "error_message": f"Model response execution results so far does not contain all the ground truth response execution results for turn {turn_index}.",
            "error_type": "multi_turn:execution_response_mismatch",
            "details": {
                "missing_items": missing_items,
                "model_response (including all previous turns)": model_response_list,
                "ground_truth_response (only the current turn)": ground_truth_response_list,
            },
        }

    return {"valid": True}


def method_invoke_order_checker(model_instances: dict, ground_truth_instances: dict):
    """
    Checks if the model_instance called the same order of methods as the ground_truth_instance.
    model_instance can call additional methods, but not skip any method that the ground_truth_instance called.

    Note: Currently, this functions only checks for the method names and not the arguments.
    """
    for class_name, ground_truth_instance in ground_truth_instances.items():
        model_instance = model_instances[class_name]

        # The get_method_called method is added by the LoggingMeta metaclass automatically
        model_invoke_order = model_instance.get_method_called()
        ground_truth_invoke_order = ground_truth_instance.get_method_called()

        # Extract the method names
        model_invoke_order = [method_call["method"] for method_call in model_invoke_order]
        ground_truth_invoke_order = [
            method_call["method"] for method_call in ground_truth_invoke_order
        ]

        is_subsequence, missing_items = _is_subsequence(
            ground_truth_invoke_order, model_invoke_order
        )
        if not is_subsequence:
            return {
                "valid": False,
                "error_message": f"Model instance for {class_name} does not match the method invoke order with ground truth instance. Missing items: {missing_items}",
                "error_type": "multi_turn:method_invoke_order_mismatch",
            }

    return {"valid": True}


#### Helper functions ####


def _compare_instances(model_obect, ground_truth_object):
    """
    Checks if the model_object has the same attributes as the ground_truth_object. They are instances of the same class.
    """
    assert type(model_obect) == type(
        ground_truth_object
    ), "Objects are not of the same type."
    differences = {}
    valid = True
    for attr_name in vars(ground_truth_object):
        # We don't check for private attributes
        if attr_name.startswith("_"):
            continue
        model_attr = getattr(model_obect, attr_name)
        ground_truth_attr = getattr(ground_truth_object, attr_name)

        if model_attr != ground_truth_attr:
            valid = False
            differences[attr_name] = {"model": model_attr, "ground_truth": ground_truth_attr}

    return valid, differences


def _is_subsequence(list1, list2) -> tuple[bool, list]:
    """
    Checks if list1 is a subsequence of list2, i.e., all elements of list1 are present in list2 in the same order.
    Also returns the elements of list1 that are not present in list2.
    """
    # Convert list2 to an iterator to ensure that the elements are consumed only once.
    iter_list2 = iter(list2)
    return all(item in iter_list2 for item in list1), [
        item for item in list1 if item not in list2
    ]


def _is_subsequence_unordered(list1, list2) -> tuple[bool, list]:
    """
    Checks if all elements of list1 are present in list2, regardless of order.
    Also returns the elements of list1 that are not present in list2.
    """
    # Copy list2 to avoid modifying the original list during checks
    list2_copy = list2[:]
    
    # Check each item in list1 to see if it exists in list2_copy
    missing_elements = []
    for item in list1:
        try:
            # Attempt to remove one occurrence of `item` from list2_copy to handle duplicates
            list2_copy.remove(item)
        except ValueError:
            # If item is not found, add it to missing_elements
            missing_elements.append(item)
    
    # If there are missing elements, list1 is not a subsequence of list2
    is_subsequence = len(missing_elements) == 0
    return is_subsequence, missing_elements
