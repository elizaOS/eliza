"""Controller Enums
Centralized management of all controller-related enumeration values
"""

from enum import Enum

class ControllerState(str, Enum):
    """Controller state definitions"""
    INIT = "INIT"                    # Project initiation phase
    GET_ACTION = "GET_ACTION"        # Get next action
    EXECUTE_ACTION = "EXECUTE_ACTION"  # Action execution phase
    QUALITY_CHECK = "QUALITY_CHECK"  # Quality gate check
    PLAN = "PLAN"                    # Re-planning phase
    SUPPLEMENT = "SUPPLEMENT"        # Data supplementation phase
    FINAL_CHECK = "FINAL_CHECK"      # Final quality check phase
    DONE = "DONE"                    # Task completion, haven't figured out how to handle done state yet


class SubtaskStatus(str, Enum):
    """Subtask status"""
    PENDING = "pending"      # In progress
    READY = "ready"          # Ready to execute
    FULFILLED = "fulfilled"  # Completed
    REJECTED = "rejected"    # Rejected
    STALE = "stale"          # Stale


class ExecStatus(str, Enum):
    """Execution status"""
    PENDING = "pending"      # Pending
    EXECUTED = "executed"    # Executed
    TIMEOUT = "timeout"      # Timeout
    BLOCKED = "blocked"      # Blocked
    ERROR = "error"          # Error
    SKIPPED = "skipped"      # Skipped (no hardware/code execution)


class GateDecision(str, Enum):
    """Quality gate decision"""
    GATE_DONE = "gate_done"           # Quality check passed
    GATE_FAIL = "gate_fail"           # Quality check failed
    GATE_SUPPLEMENT = "gate_supplement"  # Need to supplement data
    GATE_CONTINUE = "gate_continue"   # Continue execution


class GateTrigger(str, Enum):
    """Quality gate trigger conditions"""
    MANUAL = "manual"       # Manual trigger
    TIMEOUT = "timeout"     # Timeout trigger
    ERROR = "error"         # Error trigger
    PERIODIC_CHECK = "periodic_check"  # Periodic check
    WORKER_STALE = "worker_stale"      # Worker stale
    WORKER_SUCCESS = "worker_success"  # Worker success
    FINAL_CHECK = "final_check"        # Final check

class WorkerDecision(str, Enum):
    """Worker decision"""
    WORKER_DONE = "worker_done"           # Subtask completed
    CANNOT_EXECUTE = "worker_fail"           # Subtask failed
    SUPPLEMENT = "worker_supplement"  # Need to supplement data
    STALE_PROGRESS = "worker_stale_progress"   # Need quality check
    GENERATE_ACTION = "worker_generate_action"  # Generate action

class WorkerTrigger(str, Enum):
    """Worker trigger conditions"""
    MANUAL = "manual"       # Manual trigger



class TaskStatus(str, Enum):
    """Task status"""
    CREATED = "created"      # Created
    PENDING = "pending"      # Pending
    ON_HOLD = "on_hold"     # On hold
    FULFILLED = "fulfilled"  # Completed
    REJECTED = "rejected"    # Rejected
    CANCELLED = "cancelled"  # Cancelled


class WorkerStatus(str, Enum):
    """Worker status"""
    IDLE = "idle"           # Idle
    BUSY = "busy"           # Busy
    ERROR = "error"         # Error
    OFFLINE = "offline"     # Offline


class EvaluatorStatus(str, Enum):
    """Evaluator status"""
    IDLE = "idle"           # Idle
    EVALUATING = "evaluating"  # Evaluating
    ERROR = "error"         # Error
    OFFLINE = "offline"     # Offline


class ManagerStatus(str, Enum):
    """Manager status"""
    IDLE = "idle"           # Idle
    PLANNING = "planning"   # Planning
    SUPPLEMENTING = "supplementing"  # Supplementing data
    ERROR = "error"         # Error
    OFFLINE = "offline"     # Offline


class EventType(str, Enum):
    """Event type"""
    INFO = "info"           # Information
    WARNING = "warning"     # Warning
    ERROR = "error"         # Error
    SUCCESS = "success"     # Success
    STATE_SWITCH = "state_switch"  # State switch
    STATUS_CHANGE = "status_change"  # Status change 

class TriggerRole(str, Enum):
    """Trigger role"""
    CONTROLLER = "controller" # controller
    WORKER_GET_ACTION = "worker_get_action" # Worker
    EVALUATOR_QUALITY_CHECK = "evaluator_quality_check" # Evaluator
    EVALUATOR_FINAL_CHECK = "evaluator_final_check" # Evaluator
    MANAGER_REPLAN = "manager_replan" # Manager
    MANAGER_SUPPLEMENT = "manager_supplement" # Manager
    EXECUTOR_EXECUTE_ACTION = "executor_execute_action" # Executor
    HARDWARE_EXECUTE_ACTION = "hardware_execute_action" # Hardware

class TriggerCode(str, Enum):
    """Trigger code enumeration"""
    
    # Rule validation related
    RULE_QUALITY_CHECK_STEPS = "rule_quality_check_steps" # controller -> evaluator: quality_check
    RULE_QUALITY_CHECK_REPEATED_ACTIONS = "rule_quality_check_repeated_actions"  # controller -> evaluator: quality_check
    RULE_REPLAN_LONG_EXECUTION = "rule_replan_long_execution"       # controller -> manager: replan
    
    # Task status rule related
    RULE_MAX_STATE_SWITCHES_REACHED = "rule_max_state_switches_reached"  # controller -> controller: done
    RULE_PLAN_NUMBER_EXCEEDED = "rule_plan_number_exceeded"              # controller -> controller: done
    RULE_STATE_SWITCH_COUNT_EXCEEDED = "rule_state_switch_count_exceeded"  # controller -> controller: done
    RULE_TASK_COMPLETED = "rule_task_completed"                          # controller -> controller: done
    RULE_TASK_RUNTIME_EXCEEDED = "rule_task_runtime_exceeded"            # controller -> controller: done
    
    # State handling related - INIT state
    SUBTASK_READY = "subtask_ready" # INIT -> worker: get_action
    NO_SUBTASKS = "no_subtasks" # INIT -> manager: replan
    INIT_ERROR = "init_error" # INIT -> manager: replan
    
    # State handling related - GET_ACTION state
    NO_CURRENT_SUBTASK_ID = "no_current_subtask_id" # worker: get_action | executor: execute_action | evaluator: quality_check -> INIT
    SUBTASK_NOT_FOUND = "subtask_not_found" # worker: get_action | executor: execute_action -> INIT
    WORKER_SUCCESS = "worker_success" # worker: get_action -> evaluator: quality_check
    WORK_CANNOT_EXECUTE = "work_cannot_execute" # worker: get_action -> manager: replan
    WORKER_STALE_PROGRESS = "worker_stale_progress" # worker: get_action -> evaluator: quality_check
    WORKER_SUPPLEMENT = "worker_supplement" # worker: get_action -> manager: supplement
    WORKER_GENERATE_ACTION = "worker_generate_action" # worker: get_action -> executor
    NO_WORKER_DECISION = "no_worker_decision" # worker: get_action -> manager: replan
    GET_ACTION_ERROR = "get_action_error" # worker: get_action -> manager: replan
    
    # State handling related - EXECUTE_ACTION state
    EXECUTION_ERROR = "execution_error" # executor: execute_action -> worker: get_action
    COMMAND_COMPLETED = "command_completed" # executor: execute_action -> worker: get_action
    NO_COMMAND = "no_command" # executor: execute_action -> worker: get_action
    
    # State handling related - QUALITY_CHECK state
    ALL_SUBTASKS_COMPLETED = "all_subtasks_completed" # evaluator: quality_check -> evaluator: final_check
    QUALITY_CHECK_PASSED = "quality_check_passed" # # evaluator: quality_check -> worker: get_action
    QUALITY_CHECK_FAILED = "quality_check_failed" # evaluator: quality_check -> manager: replan
    QUALITY_CHECK_SUPPLEMENT = "quality_check_supplement" # evaluator: quality_check -> manager: supplement
    QUALITY_CHECK_EXECUTE_ACTION = "quality_check_execute_action" # evaluator: quality_check -> executor: execute_action
    QUALITY_CHECK_ERROR = "quality_check_error" # evaluator: quality_check -> manager: replan
    
    # State handling related - PLAN state
    SUBTASK_READY_AFTER_PLAN = "subtask_ready_after_plan" # manager: replan -> worker: get_action
    PLAN_ERROR = "plan_error" # manager: replan -> INIT
    
    # State handling related - SUPPLEMENT state
    SUPPLEMENT_COMPLETED = "supplement_completed" # manager: supplement -> manager: replan
    SUPPLEMENT_ERROR = "supplement_error" # manager: supplement -> manager: replan
 
    # State handling related - FINAL_CHECK state
    FINAL_CHECK_ERROR = "final_check_error" # evaluator: final_check -> controller: done
    FINAL_CHECK_PENDING = "final_check_pending" # evaluator: final_check -> worker: get_action
    FINAL_CHECK_PASSED = "final_check_passed" # evaluator: final_check -> controller: done
    FINAL_CHECK_FAILED = "final_check_failed" # evaluator: final_check -> manager: replan
    TASK_IMPOSSIBLE = "task_impossible" # evaluator: final_check -> controller: done (task rejected)

    # Error recovery related
    UNKNOWN_STATE = "unknown_state" # unknown -> INIT
    ERROR_RECOVERY = "error_recovery" # unknown -> INIT
    
# Trigger code dictionary classified by module
class TRIGGER_CODE_BY_MODULE:
    # Manager replan related trigger codes
    MANAGER_REPLAN_CODES = {
        "work_cannot_execute": TriggerCode.WORK_CANNOT_EXECUTE.value,
        "quality_check_failed": TriggerCode.QUALITY_CHECK_FAILED.value,
        "no_worker_decision": TriggerCode.NO_WORKER_DECISION.value,
        "get_action_error": TriggerCode.GET_ACTION_ERROR.value,
        "quality_check_error": TriggerCode.QUALITY_CHECK_ERROR.value,
        "final_check_failed": TriggerCode.FINAL_CHECK_FAILED.value,
        "rule_replan_long_execution": TriggerCode.RULE_REPLAN_LONG_EXECUTION.value,
        "no_subtasks": TriggerCode.NO_SUBTASKS.value,
        "init_error": TriggerCode.INIT_ERROR.value,
        "supplement_completed": TriggerCode.SUPPLEMENT_COMPLETED.value,
        "supplement_error": TriggerCode.SUPPLEMENT_ERROR.value,
    }
    
    # Manager supplement related trigger codes
    MANAGER_SUPPLEMENT_CODES = {
        "worker_supplement": TriggerCode.WORKER_SUPPLEMENT.value,
        "quality_check_supplement": TriggerCode.QUALITY_CHECK_SUPPLEMENT.value,
    }
    
    # Worker get_action related trigger codes
    WORKER_GET_ACTION_CODES = {
        "subtask_ready": TriggerCode.SUBTASK_READY.value,
        "execution_error": TriggerCode.EXECUTION_ERROR.value,
        "command_completed": TriggerCode.COMMAND_COMPLETED.value,
        "no_command": TriggerCode.NO_COMMAND.value,
        "quality_check_passed": TriggerCode.QUALITY_CHECK_PASSED.value,
        "subtask_ready_after_plan": TriggerCode.SUBTASK_READY_AFTER_PLAN.value,
        "final_check_pending": TriggerCode.FINAL_CHECK_PENDING.value,
    }
    
    # Evaluator quality_check related trigger codes
    EVALUATOR_QUALITY_CHECK_CODES = {
        "rule_quality_check_steps": TriggerCode.RULE_QUALITY_CHECK_STEPS.value,
        "rule_quality_check_repeated_actions": TriggerCode.RULE_QUALITY_CHECK_REPEATED_ACTIONS.value,
        "worker_success": TriggerCode.WORKER_SUCCESS.value,
        "worker_stale_progress": TriggerCode.WORKER_STALE_PROGRESS.value,
    }
    
    # Evaluator final_check related trigger codes
    EVALUATOR_FINAL_CHECK_CODES = {
        "all_subtasks_completed": TriggerCode.ALL_SUBTASKS_COMPLETED.value,
    }
    
    # Executor execute_action related trigger codes
    EXECUTOR_EXECUTE_ACTION_CODES = {
        "worker_generate_action": TriggerCode.WORKER_GENERATE_ACTION.value,
        "quality_check_execute_action": TriggerCode.QUALITY_CHECK_EXECUTE_ACTION.value,
    }
    
    # INIT state related trigger codes
    INIT_STATE_CODES = {
        "no_current_subtask_id": TriggerCode.NO_CURRENT_SUBTASK_ID.value,
        "subtask_not_found": TriggerCode.SUBTASK_NOT_FOUND.value,
        "plan_error": TriggerCode.PLAN_ERROR.value,
        "unknown_state": TriggerCode.UNKNOWN_STATE.value,
        "error_recovery": TriggerCode.ERROR_RECOVERY.value,
    }
    
    # DONE state related trigger codes
    DONE_STATE_CODES = {
        "rule_max_state_switches_reached": TriggerCode.RULE_MAX_STATE_SWITCHES_REACHED.value,
        "rule_plan_number_exceeded": TriggerCode.RULE_PLAN_NUMBER_EXCEEDED.value,
        "rule_state_switch_count_exceeded": TriggerCode.RULE_STATE_SWITCH_COUNT_EXCEEDED.value,
        "rule_task_completed": TriggerCode.RULE_TASK_COMPLETED.value,
        "rule_task_runtime_exceeded": TriggerCode.RULE_TASK_RUNTIME_EXCEEDED.value,
        "final_check_error": TriggerCode.FINAL_CHECK_ERROR.value,
        "final_check_passed": TriggerCode.FINAL_CHECK_PASSED.value,
        "task_impossible": TriggerCode.TASK_IMPOSSIBLE.value,
    }