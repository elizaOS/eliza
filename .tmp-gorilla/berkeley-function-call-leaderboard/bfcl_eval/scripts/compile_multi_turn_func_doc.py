import importlib
import inspect
import json

from _compile_helper import function_to_json
from bfcl_eval.constants.eval_config import MULTI_TURN_FUNC_DOC_PATH

CLASS_FILE_PATH_MAPPING = {
    "GorillaFileSystem": "bfcl_eval.eval_checker.multi_turn_eval.func_source_code.gorilla_file_system",
    "MathAPI": "bfcl_eval.eval_checker.multi_turn_eval.func_source_code.math_api",
    "MessageAPI": "bfcl_eval.eval_checker.multi_turn_eval.func_source_code.message_api",
    "TwitterAPI": "bfcl_eval.eval_checker.multi_turn_eval.func_source_code.posting_api",
    "TicketAPI": "bfcl_eval.eval_checker.multi_turn_eval.func_source_code.ticket_api",
    "TradingBot": "bfcl_eval.eval_checker.multi_turn_eval.func_source_code.trading_bot",
    "TravelAPI": "bfcl_eval.eval_checker.multi_turn_eval.func_source_code.travel_booking",
    "VehicleControlAPI": "bfcl_eval.eval_checker.multi_turn_eval.func_source_code.vehicle_control",
    # "WebSearchAPI": "bfcl_eval.eval_checker.multi_turn_eval.func_source_code.web_search",  # WebSearchAPI function doc is manually written
    "MemoryAPI_kv": "bfcl_eval.eval_checker.multi_turn_eval.func_source_code.memory_kv",
    "MemoryAPI_vector": "bfcl_eval.eval_checker.multi_turn_eval.func_source_code.memory_vector",
    "MemoryAPI_rec_sum": "bfcl_eval.eval_checker.multi_turn_eval.func_source_code.memory_rec_sum",
}


class_method_name_mapping = {}
for class_name in CLASS_FILE_PATH_MAPPING.keys():
    module_name = CLASS_FILE_PATH_MAPPING[class_name]
    module = importlib.import_module(module_name)
    class_ = getattr(module, class_name)
    class_instance = class_()
    api_description = class_instance._api_description
    # Retrieve all method names and map them to the instance
    for method_name, method in inspect.getmembers(
        class_instance, predicate=inspect.ismethod
    ):
        # Skip private methods
        if method_name.startswith("_"):
            continue
        if class_name not in class_method_name_mapping:
            class_method_name_mapping[class_name] = {}
        # class_method_name_mapping[class_name][method_name] = method
        class_method_name_mapping[class_name][method_name] = json.loads(function_to_json(method))
        class_method_name_mapping[class_name][method_name]["description"] = api_description + " Tool description: " + class_method_name_mapping[class_name][method_name]["description"]
        class_method_name_mapping[class_name][method_name] = json.dumps(class_method_name_mapping[class_name][method_name])
# Store the methods one json file per class
for class_name, file_name in CLASS_FILE_PATH_MAPPING.items():

    with open(MULTI_TURN_FUNC_DOC_PATH / f"{file_name.rsplit('.')[-1]}.json", "w") as f:
        for method_name, method_json in class_method_name_mapping[class_name].items():
            f.write(method_json)
            f.write("\n")
