"""Berkeley Function-Calling Leaderboard public API."""

from importlib import import_module

__version__ = "1.0.0"
_EXPORTS = {
    "ArgumentValue": ("benchmarks.bfcl.types", "ArgumentValue"),
    "BFCLCategory": ("benchmarks.bfcl.types", "BFCLCategory"),
    "BFCLConfig": ("benchmarks.bfcl.types", "BFCLConfig"),
    "BFCLLanguage": ("benchmarks.bfcl.types", "BFCLLanguage"),
    "BFCLMetrics": ("benchmarks.bfcl.types", "BFCLMetrics"),
    "BFCLResult": ("benchmarks.bfcl.types", "BFCLResult"),
    "BFCLTestCase": ("benchmarks.bfcl.types", "BFCLTestCase"),
    "BFCLBenchmarkResults": ("benchmarks.bfcl.types", "BFCLBenchmarkResults"),
    "BaselineScore": ("benchmarks.bfcl.types", "BaselineScore"),
    "CategoryMetrics": ("benchmarks.bfcl.types", "CategoryMetrics"),
    "EvaluationType": ("benchmarks.bfcl.types", "EvaluationType"),
    "FunctionCall": ("benchmarks.bfcl.types", "FunctionCall"),
    "FunctionDefinition": ("benchmarks.bfcl.types", "FunctionDefinition"),
    "FunctionParameter": ("benchmarks.bfcl.types", "FunctionParameter"),
    "ResultDetails": ("benchmarks.bfcl.types", "ResultDetails"),
    "LEADERBOARD_SCORES": ("benchmarks.bfcl.types", "LEADERBOARD_SCORES"),
    "BFCLDataset": ("benchmarks.bfcl.dataset", "BFCLDataset"),
    "FunctionCallParser": ("benchmarks.bfcl.parser", "FunctionCallParser"),
    "BFCLPluginFactory": ("benchmarks.bfcl.plugin", "BFCLPluginFactory"),
    "FunctionCallCapture": ("benchmarks.bfcl.plugin", "FunctionCallCapture"),
    "create_function_action": ("benchmarks.bfcl.plugin", "create_function_action"),
    "generate_function_schema": ("benchmarks.bfcl.plugin", "generate_function_schema"),
    "generate_openai_tools_format": (
        "benchmarks.bfcl.plugin",
        "generate_openai_tools_format",
    ),
    "get_call_capture": ("benchmarks.bfcl.plugin", "get_call_capture"),
    "BFCLAgent": ("benchmarks.bfcl.agent", "BFCLAgent"),
    "MockBFCLAgent": ("benchmarks.bfcl.agent", "MockBFCLAgent"),
    "ASTEvaluator": ("benchmarks.bfcl.evaluators", "ASTEvaluator"),
    "ExecutionEvaluator": ("benchmarks.bfcl.evaluators", "ExecutionEvaluator"),
    "RelevanceEvaluator": ("benchmarks.bfcl.evaluators", "RelevanceEvaluator"),
    "BFCLRunner": ("benchmarks.bfcl.runner", "BFCLRunner"),
    "run_bfcl_benchmark": ("benchmarks.bfcl.runner", "run_bfcl_benchmark"),
    "MetricsCalculator": ("benchmarks.bfcl.metrics", "MetricsCalculator"),
    "BFCLReporter": ("benchmarks.bfcl.reporting", "BFCLReporter"),
    "print_results": ("benchmarks.bfcl.reporting", "print_results"),
    "provider_safe_tools": ("benchmarks.bfcl.protocol", "provider_safe_tools"),
    "coerce_arguments": ("benchmarks.bfcl.protocol", "coerce_arguments"),
    "call_from_record": ("benchmarks.bfcl.protocol", "call_from_record"),
    "iter_call_records": ("benchmarks.bfcl.protocol", "iter_call_records"),
    "provider_safe_tool_name": ("benchmarks.bfcl.protocol", "provider_safe_tool_name"),
    "restore_original_call_names": (
        "benchmarks.bfcl.protocol",
        "restore_original_call_names",
    ),
}
__all__ = ["__version__", *_EXPORTS]


def __getattr__(name):
    if name not in _EXPORTS:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    module, symbol = _EXPORTS[name]
    value = getattr(import_module(module), symbol)
    globals()[name] = value
    return value
