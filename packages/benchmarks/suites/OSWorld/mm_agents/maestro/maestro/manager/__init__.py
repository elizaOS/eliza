"""
Manager module for GUI-Agent architecture
Provides task planning, decomposition, and resource allocation functionality
"""

from .plan import PlanningHandler, PlanningScenario, PlanningResult
from .supplement import SupplementHandler
from .planning_helpers import (
    get_planning_context, get_trigger_code_specific_context,
    generate_planning_prompt, generate_trigger_specific_guidance
)
from .utils import (
    enhance_subtasks, generate_dag, topological_sort,
    get_failed_subtasks_info, get_failure_reasons, get_history_subtasks_info,
    get_pending_subtasks_info, count_subtasks_from_info, get_current_failed_subtask,
    get_quality_check_failure_info, get_final_check_failure_info,
    get_execution_time_info, get_supplement_info
)

__all__ = [
    # Planning
    'PlanningHandler',
    'PlanningScenario', 
    'PlanningResult',
    
    # Planning Helpers
    'get_planning_context',
    'get_trigger_code_specific_context', 
    'generate_planning_prompt',
    'generate_trigger_specific_guidance',
    
    # Supplement
    'SupplementHandler',
    
    # Utilities
    'enhance_subtasks',
    'generate_dag',
    'topological_sort',
    'get_failed_subtasks_info',
    'get_failure_reasons',
    'get_history_subtasks_info',
    'get_pending_subtasks_info',
    'count_subtasks_from_info',
    'get_current_failed_subtask',
    'get_quality_check_failure_info',
    'get_final_check_failure_info',
    'get_execution_time_info',
    'get_supplement_info'
]
