import re

#### Main functions ####


def agentic_checker(model_response: str, possible_answer_list: list[str]) -> dict:
    """
    Check if one of the possible answers is contained in the model response, ignoring case, whitespace and ",./-_*^" punctuation.
    """
    standardized_possible_answer_list = [
        standardize_string(possible_answer) for possible_answer in possible_answer_list
    ]
    # Sometimes the model response is a list of one string
    if type(model_response) is list:
        model_response = model_response[0]
    if type(model_response) is not str:
        model_response = str(model_response)

    standardized_model_response = standardize_string(model_response)

    for possible_answer in standardized_possible_answer_list:
        if re.search(rf"\b{re.escape(possible_answer)}\b", standardized_model_response):
            return {"valid": True, "error": []}

    return {
        "valid": False,
        "error_message": f"None of the expected answers were found in the model response.",
        "error_type": "agentic:answer_not_found",
        "details": {
            "model_response": model_response,
            "possible_answers": possible_answer_list,
            "standardized_model_response": standardized_model_response,
            "standardized_possible_answers": standardized_possible_answer_list,
        },
    }


#### Helper functions ####


def standardize_string(input_string: str):
    """
    This function standardizes the string by removing all the whitespace, ",./-_*^()" punctuation, and converting it to lowercase
    It will also convert all the single quotes to double quotes
    This is used to compare the model output with the possible answers
    We don't want to punish model for answer like April 1, 2024 vs April 1,2024, vs April 1 2024
    """
    regex_string = r"[\,\.\/\-\_\*\^\(\)]"
    return re.sub(regex_string, "", input_string).lower().replace("'", '"')
