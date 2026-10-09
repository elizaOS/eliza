"""Berkeley Function-Calling Leaderboard public API."""

from importlib import import_module

__version__ = "1.0.0"
_EXPORTS = {
    "ArgumentValue": ("benchmarks.suites.bfcl.types", "ArgumentValue"),
    "BFCLCategory": ("benchmarks.suites.bfcl.types", "BFCLCategory"),
    "BFCLConfig": ("benchmarks.suites.bfcl.types", "BFCLConfig"),
    "BFCLLanguage": ("benchmarks.suites.bfcl.types", "BFCLLanguage"),
    "BFCLMetrics": ("benchmarks.suites.bfcl.types", "BFCLMetrics"),
    "BFCLResult": ("benchmarks.suites.bfcl.types", "BFCLResult"),
    "BFCLTestCase": ("benchmarks.suites.bfcl.types", "BFCLTestCase"),
    "BFCLBenchmarkResults": ("benchmarks.suites.bfcl.types", "BFCLBenchmarkResults"),
    "BaselineScore": ("benchmarks.suites.bfcl.types", "BaselineScore"),
    "CategoryMetrics": ("benchmarks.suites.bfcl.types", "CategoryMetrics"),
    "EvaluationType": ("benchmarks.suites.bfcl.types", "EvaluationType"),
    "FunctionCall": ("benchmarks.suites.bfcl.types", "FunctionCall"),
    "FunctionDefinition": ("benchmarks.suites.bfcl.types", "FunctionDefinition"),
    "FunctionParameter": ("benchmarks.suites.bfcl.types", "FunctionParameter"),
    "ResultDetails": ("benchmarks.suites.bfcl.types", "ResultDetails"),
    "LEADERBOARD_SCORES": ("benchmarks.suites.bfcl.types", "LEADERBOARD_SCORES"),
    "BFCLDataset": ("benchmarks.suites.bfcl.dataset", "BFCLDataset"),
    "FunctionCallParser": ("benchmarks.suites.bfcl.parser", "FunctionCallParser"),
    "BFCLPluginFactory": ("benchmarks.suites.bfcl.plugin", "BFCLPluginFactory"),
    "FunctionCallCapture": ("benchmarks.suites.bfcl.plugin", "FunctionCallCapture"),
    "create_function_action": ("benchmarks.suites.bfcl.plugin", "create_function_action"),
    "generate_function_schema": ("benchmarks.suites.bfcl.plugin", "generate_function_schema"),
    "generate_openai_tools_format": (
        "benchmarks.suites.bfcl.plugin",
        "generate_openai_tools_format",
    ),
    "get_call_capture": ("benchmarks.suites.bfcl.plugin", "get_call_capture"),
    "BFCLAgent": ("benchmarks.suites.bfcl.agent", "BFCLAgent"),
    "MockBFCLAgent": ("benchmarks.suites.bfcl.agent", "MockBFCLAgent"),
    "ASTEvaluator": ("benchmarks.suites.bfcl.evaluators", "ASTEvaluator"),
    "ExecutionEvaluator": ("benchmarks.suites.bfcl.evaluators", "ExecutionEvaluator"),
    "RelevanceEvaluator": ("benchmarks.suites.bfcl.evaluators", "RelevanceEvaluator"),
    "BFCLRunner": ("benchmarks.suites.bfcl.runner", "BFCLRunner"),
    "run_bfcl_benchmark": ("benchmarks.suites.bfcl.runner", "run_bfcl_benchmark"),
    "MetricsCalculator": ("benchmarks.suites.bfcl.metrics", "MetricsCalculator"),
    "BFCLReporter": ("benchmarks.suites.bfcl.reporting", "BFCLReporter"),
    "print_results": ("benchmarks.suites.bfcl.reporting", "print_results"),
    "provider_safe_tools": ("benchmarks.suites.bfcl.protocol", "provider_safe_tools"),
    "coerce_arguments": ("benchmarks.suites.bfcl.protocol", "coerce_arguments"),
    "call_from_record": ("benchmarks.suites.bfcl.protocol", "call_from_record"),
    "iter_call_records": ("benchmarks.suites.bfcl.protocol", "iter_call_records"),
    "provider_safe_tool_name": ("benchmarks.suites.bfcl.protocol", "provider_safe_tool_name"),
    "restore_original_call_names": (
        "benchmarks.suites.bfcl.protocol",
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
