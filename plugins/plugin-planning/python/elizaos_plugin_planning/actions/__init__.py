"""
Planning plugin actions module.
"""

from elizaos_plugin_planning.actions.analyze_input import AnalyzeInputAction
from elizaos_plugin_planning.actions.process_analysis import ProcessAnalysisAction
from elizaos_plugin_planning.actions.execute_final import ExecuteFinalAction
from elizaos_plugin_planning.actions.create_plan import CreatePlanAction

__all__ = [
    "AnalyzeInputAction",
    "ProcessAnalysisAction",
    "ExecuteFinalAction",
    "CreatePlanAction",
]


def get_planning_action_names() -> list[str]:
    """Get all planning plugin action names."""
    return ["ANALYZE_INPUT", "PROCESS_ANALYSIS", "EXECUTE_FINAL", "CREATE_PLAN"]
