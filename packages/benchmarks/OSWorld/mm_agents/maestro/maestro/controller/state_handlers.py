"""State Handlers for Maestro Controller
Responsible for handling specific logic of various states
"""

import logging
from typing import Optional

from ..data_models import CommandData
from ..new_global_state import NewGlobalState
from ..enums import ControllerState, TaskStatus, SubtaskStatus, WorkerDecision, GateDecision, TriggerRole, TriggerCode
from ..new_manager import NewManager
from ..new_worker import NewWorker
from ..evaluator import Evaluator
from ..new_executor import NewExecutor

logger = logging.getLogger(__name__)


class StateHandlers:
    """State handler, responsible for handling specific logic of various states"""
    
    def __init__(self, 
            global_state: NewGlobalState, 
            manager: NewManager, 
            executor: NewExecutor, 
            tools_dict: dict, 
            platform: str, 
            enable_search: bool, 
            env_password: str = "osworld-public-evaluation",
            rule_engine=None
        ):
        self.global_state: NewGlobalState = global_state
        self.manager = manager
        self.executor = executor
        self.tools_dict = tools_dict
        self.platform = platform
        self.enable_search = enable_search
        self.env_password = env_password
        self.rule_engine = rule_engine
    
    def handle_init_state(self) -> tuple[ControllerState, TriggerRole, str, TriggerCode]:
        """Initialize state handling"""
        logger.info("Handling INIT state")
        self.global_state.set_task_objective(self.global_state.get_task().objective)

        try:
            # Check if there are pending subtasks
            task = self.global_state.get_task()
            pending_subtask_ids = task.pending_subtask_ids or []

            if pending_subtask_ids:
                # Have subtasks, set the first one as current subtask
                first_subtask_id = pending_subtask_ids[0]
                self.global_state.advance_to_next_subtask()
                # Update task status to pending
                self.global_state.update_task_status(TaskStatus.PENDING)
                logger.info(f"Set current subtask: {first_subtask_id}")
                return (ControllerState.GET_ACTION, TriggerRole.CONTROLLER, f"First subtask {first_subtask_id} ready", TriggerCode.SUBTASK_READY)
            else:
                # No subtasks, need to create
                logger.info("No subtasks available, switching to PLAN state")
                return (ControllerState.PLAN, TriggerRole.CONTROLLER, "No subtasks available, need planning", TriggerCode.NO_SUBTASKS)

        except Exception as e:
            logger.error(f"Error in INIT state: {e}")
            self.global_state.add_event("controller", "error", f"INIT state error: {str(e)}")
            return (ControllerState.PLAN, TriggerRole.CONTROLLER, f"INIT state error: {str(e)}", TriggerCode.INIT_ERROR)
    
    def handle_get_action_state(self) -> tuple[ControllerState, TriggerRole, str, TriggerCode]:
        """Get next action phase"""
        logger.info("Handling GET_ACTION state")
        current_subtask_id = self.global_state.get_task().current_subtask_id
        
        try:
            if not current_subtask_id:
                logger.warning("No current subtask ID, switching to INIT")
                return (ControllerState.INIT, TriggerRole.WORKER_GET_ACTION, "No current subtask ID in GET_ACTION state", TriggerCode.NO_CURRENT_SUBTASK_ID)

            # Check subtask status
            subtask = self.global_state.get_subtask(current_subtask_id)
            if not subtask:
                logger.warning(f"Subtask {current_subtask_id} not found, switching to INIT")
                return (ControllerState.INIT, TriggerRole.WORKER_GET_ACTION, f"Subtask {current_subtask_id} not found in GET_ACTION state", TriggerCode.SUBTASK_NOT_FOUND)

            # Check if current subtask indicates task is impossible
            if subtask.title == "Task Cannot Be Completed" or "cannot be completed" in subtask.title.lower():
                logger.info("Detected impossible task subtask, rejecting task")
                self.global_state.update_task_status(TaskStatus.REJECTED)
                return (ControllerState.DONE, TriggerRole.WORKER_GET_ACTION, "Task cannot be completed", TriggerCode.TASK_IMPOSSIBLE)

            # Handled uniformly by Worker: generate action/record decision/create command based on role
            worker_params = {
                "tools_dict": self.tools_dict,
                "global_state": self.global_state,
                "platform": self.platform,
                "enable_search": self.enable_search,
                "client_password": self.env_password
            }
            worker = NewWorker(**worker_params)
            worker.process_subtask_and_create_command()

            # Get worker decision
            worker_decision = self.global_state.get_subtask_worker_decision(current_subtask_id)

            if worker_decision:
                logger.info(f"Subtask {current_subtask_id} has worker_decision: {worker_decision}")

                # Check if command should be executed immediately
                command = self.global_state.get_current_command_for_subtask(current_subtask_id)
                if command and self.should_execute_immediately(command):
                    logger.info(f"Command {command.command_id} should be executed immediately")
                    self.executor.execute_current_action()

                # Switch states based on worker_decision
                if worker_decision == WorkerDecision.WORKER_DONE.value:
                    # Operation successful, enter quality check phase
                    logger.info(f"Worker decision is WORKER_DONE, switching to QUALITY_CHECK")
                    self.global_state.update_subtask_status(
                        current_subtask_id, SubtaskStatus.PENDING,
                        "Worker completed action, waiting for quality check")
                    return (ControllerState.QUALITY_CHECK, TriggerRole.WORKER_GET_ACTION, f"Worker decision success for subtask {current_subtask_id}", TriggerCode.WORKER_SUCCESS)
                    
                elif worker_decision == WorkerDecision.CANNOT_EXECUTE.value:
                    # Cannot execute, need replanning
                    logger.info(f"Worker decision is CANNOT_EXECUTE, switching to PLAN")
                    self.global_state.update_subtask_status(
                        current_subtask_id, SubtaskStatus.REJECTED,
                        "Worker cannot execute this subtask")
                    return (ControllerState.PLAN, TriggerRole.WORKER_GET_ACTION, f"Worker cannot execute subtask {current_subtask_id}", TriggerCode.WORK_CANNOT_EXECUTE)
                    
                elif worker_decision == WorkerDecision.STALE_PROGRESS.value:
                    # Progress stalled, enter quality check phase
                    logger.info(f"Worker decision is STALE_PROGRESS, switching to QUALITY_CHECK")
                    self.global_state.update_subtask_status(
                        current_subtask_id, SubtaskStatus.STALE,
                        "Worker progress stale, waiting for quality check")
                    return (ControllerState.QUALITY_CHECK, TriggerRole.WORKER_GET_ACTION, f"Worker progress stale for subtask {current_subtask_id}", TriggerCode.WORKER_STALE_PROGRESS)
                    
                elif worker_decision == WorkerDecision.SUPPLEMENT.value:
                    # Need supplementary materials
                    logger.info(f"Worker decision is SUPPLEMENT, switching to SUPPLEMENT")
                    self.global_state.update_subtask_status(
                        current_subtask_id, SubtaskStatus.REJECTED,
                        "Worker needs supplement, waiting for supplement")
                    return (ControllerState.SUPPLEMENT, TriggerRole.WORKER_GET_ACTION, f"Worker needs supplement for subtask {current_subtask_id}", TriggerCode.WORKER_SUPPLEMENT)
                    
                elif worker_decision == WorkerDecision.GENERATE_ACTION.value:
                    # Generated new action, execute action
                    logger.info(f"Worker decision is GENERATE_ACTION, switching to EXECUTE_ACTION")
                    self.global_state.update_subtask_status(
                        current_subtask_id, SubtaskStatus.PENDING,
                        "Worker generated action, waiting for execute")
                    return (ControllerState.EXECUTE_ACTION, TriggerRole.WORKER_GET_ACTION, f"Worker generated action for subtask {current_subtask_id}", TriggerCode.WORKER_GENERATE_ACTION)
                else:
                    # Unknown worker_decision, default switch to PLAN
                    logger.warning(f"Unknown worker_decision: {worker_decision}, switching to PLAN")
                    self.global_state.update_subtask_status(
                        current_subtask_id, SubtaskStatus.REJECTED,
                        f"Unknown worker_decision: {worker_decision}")
                    return (ControllerState.PLAN, TriggerRole.WORKER_GET_ACTION, f"Unknown worker_decision: {worker_decision}", TriggerCode.NO_WORKER_DECISION)
            else:
                # Error handling
                logger.info(f"Subtask {current_subtask_id} has no worker_decision, switching to PLAN")
                self.global_state.update_subtask_status(
                    current_subtask_id, SubtaskStatus.REJECTED,
                    "Worker has no worker_decision, switching to PLAN")
                return (ControllerState.PLAN, TriggerRole.WORKER_GET_ACTION, f"Subtask {current_subtask_id} has no worker_decision in GET_ACTION state", TriggerCode.NO_WORKER_DECISION)

        except Exception as e:
            logger.error(f"Error in GET_ACTION state: {e}")
            self.global_state.log_operation(
                "controller", "error", {"error": f"GET_ACTION state error: {str(e)}"})

            # Update subtask status to failed
            if current_subtask_id is not None:
                self.global_state.update_subtask_status(
                    current_subtask_id, SubtaskStatus.REJECTED,
                    "Worker has no worker_decision, switching to PLAN")
            return (ControllerState.PLAN, TriggerRole.WORKER_GET_ACTION, f"GET_ACTION state error: {str(e)}", TriggerCode.GET_ACTION_ERROR)
    
    def handle_execute_action_state(self) -> tuple[ControllerState, TriggerRole, str, TriggerCode]:
        """Execute action phase"""
        logger.info("Handling EXECUTE_ACTION state")

        try:
            current_subtask_id = self.global_state.get_task().current_subtask_id
            if not current_subtask_id:
                logger.warning("No current subtask ID in EXECUTE_ACTION state")
                return (ControllerState.INIT, TriggerRole.EXECUTOR_EXECUTE_ACTION, "No current subtask ID in EXECUTE_ACTION state", TriggerCode.NO_CURRENT_SUBTASK_ID)

            # Get current subtask
            subtask = self.global_state.get_subtask(current_subtask_id)
            if not subtask:
                logger.warning(f"Subtask {current_subtask_id} not found in EXECUTE_ACTION state")
                return (ControllerState.INIT, TriggerRole.EXECUTOR_EXECUTE_ACTION, f"Subtask {current_subtask_id} not found in EXECUTE_ACTION state", TriggerCode.SUBTASK_NOT_FOUND)

            # Check if command should be executed immediately
            command = self.global_state.get_current_command_for_subtask(current_subtask_id)
            if command and self.should_execute_immediately(command):
                logger.info(f"Command {command.command_id} has executed immediately, switching to GET_ACTION")
                return (ControllerState.GET_ACTION, TriggerRole.EXECUTOR_EXECUTE_ACTION, f"Command {command.command_id} has executed immediately", TriggerCode.COMMAND_COMPLETED)
            
            # use executor to execute action
            execution_result = self.executor.execute_current_action()
            if execution_result["success"]:
                logger.info(f"Action executed successfully for subtask {current_subtask_id} in {execution_result['execution_time']:.2f}s")
            else:
                # Execution failed, mark subtask as failed and switch to replanning state
                error_msg = execution_result.get("error_message", "Unknown execution error")
                logger.warning(f"Action execution failed for subtask {current_subtask_id}: {error_msg}")

                self.global_state.update_subtask_status(
                    current_subtask_id, SubtaskStatus.PENDING,
                    f"Action execution failed: {error_msg}")
                return (ControllerState.GET_ACTION, TriggerRole.EXECUTOR_EXECUTE_ACTION, f"Action execution failed: {error_msg}", TriggerCode.EXECUTION_ERROR)

            # Get screenshot Executor processing
            command = self.global_state.get_current_command_for_subtask(current_subtask_id)
            if command:
                # Check current subtask's assignee_role, if analyst, enter quality check directly after executing action
                subtask = self.global_state.get_subtask(current_subtask_id)
                if subtask and subtask.assignee_role == "analyst":
                    logger.info(f"Analyst subtask {current_subtask_id} action executed, switching to GET_ACTION")
                    # Update subtask status to continue normal flow
                    self.global_state.update_subtask_status(
                        current_subtask_id, SubtaskStatus.PENDING,
                        "Analyst action executed, continue to next action")
                    return (ControllerState.GET_ACTION, TriggerRole.EXECUTOR_EXECUTE_ACTION, f"Analyst action executed for subtask {current_subtask_id}", TriggerCode.COMMAND_COMPLETED)
                else:
                    # Non-analyst role, continue normal GET_ACTION flow
                    return (ControllerState.GET_ACTION, TriggerRole.EXECUTOR_EXECUTE_ACTION, f"{command.command_id} command completed", TriggerCode.COMMAND_COMPLETED)
            else:
                return (ControllerState.GET_ACTION, TriggerRole.EXECUTOR_EXECUTE_ACTION, "No command found in EXECUTE_ACTION state", TriggerCode.NO_COMMAND)

        except Exception as e:
            logger.error(f"Error in EXECUTE_ACTION state: {e}")
            self.global_state.add_event("controller", "error", f"EXECUTE_ACTION state error: {str(e)}")
            return (ControllerState.GET_ACTION, TriggerRole.EXECUTOR_EXECUTE_ACTION, f"EXECUTE_ACTION state error: {str(e)}", TriggerCode.EXECUTION_ERROR)
    
    def handle_quality_check_state(self) -> tuple[ControllerState, TriggerRole, str, TriggerCode]:
        """Quality gate check phase"""
        logger.info("Handling QUALITY_CHECK state")
        current_subtask_id = self.global_state.get_task().current_subtask_id
        
        try:
            if not current_subtask_id:
                logger.warning("No current subtask ID in QUALITY_CHECK state")
                return (ControllerState.INIT, TriggerRole.EVALUATOR_QUALITY_CHECK, "No current subtask ID in QUALITY_CHECK state", TriggerCode.NO_CURRENT_SUBTASK_ID)

            # Check if current subtask indicates task is impossible
            subtask = self.global_state.get_subtask(current_subtask_id)
            if subtask and (subtask.title == "Task Cannot Be Completed" or "cannot be completed" in subtask.title.lower()):
                logger.info("Detected impossible task subtask in quality check, rejecting task")
                self.global_state.update_task_status(TaskStatus.REJECTED)
                return (ControllerState.DONE, TriggerRole.EVALUATOR_QUALITY_CHECK, "Task cannot be completed", TriggerCode.TASK_IMPOSSIBLE)

            # Reset repeated action counter when entering quality check state
            # This ensures we don't immediately trigger another quality check for the same pattern
            if self.rule_engine:
                self.rule_engine.reset_repeated_action_counter()

            evaluator_params = {
                "global_state": self.global_state,
                "tools_dict": self.tools_dict
            }
            evaluator = Evaluator(**evaluator_params)

            # Wait for Evaluator to complete quality check
            evaluator.quality_check()

            # Check quality check results
            latest_gate = self.global_state.get_latest_gate_check_for_subtask(current_subtask_id)

            if latest_gate:
                decision = latest_gate.decision
                logger.info(f"Latest gate check decision for subtask {current_subtask_id}: {decision}")

                if decision == GateDecision.GATE_DONE.value:
                    # Quality check passed, subtask completed
                    self.global_state.update_subtask_status(
                        current_subtask_id, SubtaskStatus.FULFILLED,
                        "Quality check passed")
                    logger.info(f"Quality check passed for subtask {current_subtask_id}")

                    # Check if task is completed
                    task = self.global_state.get_task()
                    if not task.pending_subtask_ids:
                        # All subtasks completed
                        if not getattr(task, 'managerComplete', False):
                            logger.info("All subtasks completed, but manager incomplete, entering plan")
                            return (ControllerState.PLAN, TriggerRole.EVALUATOR_QUALITY_CHECK, "All subtasks completed, manager incomplete; entering plan", TriggerCode.FINAL_CHECK_FAILED)
                        logger.info("All subtasks completed, entering final check")
                        return (ControllerState.FINAL_CHECK, TriggerRole.EVALUATOR_QUALITY_CHECK, "All subtasks completed, entering final check", TriggerCode.ALL_SUBTASKS_COMPLETED)

                    # Still have pending subtasks, advance to next one
                    self.global_state.advance_to_next_subtask()
                    return (ControllerState.GET_ACTION, TriggerRole.EVALUATOR_QUALITY_CHECK, f"Quality check passed for subtask {current_subtask_id}", TriggerCode.QUALITY_CHECK_PASSED)
                    
                elif decision == GateDecision.GATE_FAIL.value:
                    logger.info(f"Quality check failed for subtask {current_subtask_id}")
                    # Update subtask status to failed
                    self.global_state.update_subtask_status(
                        current_subtask_id, SubtaskStatus.REJECTED,
                        "Quality check failed")
                    return (ControllerState.PLAN, TriggerRole.EVALUATOR_QUALITY_CHECK, f"Quality check failed for subtask {current_subtask_id}", TriggerCode.QUALITY_CHECK_FAILED)
                    
                elif decision == GateDecision.GATE_SUPPLEMENT.value:
                    # Need supplementary materials
                    logger.info(f"Quality check requires supplement for subtask {current_subtask_id}")
                    self.global_state.update_subtask_status(
                        current_subtask_id, SubtaskStatus.REJECTED,
                        "Quality check requires supplement")
                    return (ControllerState.SUPPLEMENT, TriggerRole.EVALUATOR_QUALITY_CHECK, f"Quality check requires supplement for subtask {current_subtask_id}", TriggerCode.QUALITY_CHECK_SUPPLEMENT)
                    
                elif decision == GateDecision.GATE_CONTINUE.value:
                    # execute_action
                    logger.info(f"Quality check requires execute action for subtask {current_subtask_id}")
                    self.global_state.update_subtask_status(
                        current_subtask_id, SubtaskStatus.PENDING,
                        "Quality check requires execute action")
                    return (ControllerState.EXECUTE_ACTION, TriggerRole.EVALUATOR_QUALITY_CHECK, f"Quality check requires execute action for subtask {current_subtask_id}", TriggerCode.QUALITY_CHECK_EXECUTE_ACTION)
                else:
                    # Unknown gate decision, default switch to PLAN
                    logger.warning(f"Unknown gate decision: {decision}, switching to PLAN")
                    self.global_state.update_subtask_status(
                        current_subtask_id, SubtaskStatus.REJECTED,
                        f"Unknown gate decision: {decision}")
                    return (ControllerState.PLAN, TriggerRole.EVALUATOR_QUALITY_CHECK, f"Unknown gate decision: {decision}", TriggerCode.QUALITY_CHECK_ERROR)
            else:
                # No quality check records, error
                logger.debug(f"No gate checks found for subtask {current_subtask_id}")
                return (ControllerState.PLAN, TriggerRole.EVALUATOR_QUALITY_CHECK, "Quality check error", TriggerCode.QUALITY_CHECK_ERROR)

        except Exception as e:
            logger.error(f"Error in QUALITY_CHECK state: {e}")
            self.global_state.add_event("controller", "error", f"QUALITY_CHECK state error: {str(e)}")
            if current_subtask_id is not None:
                self.global_state.update_subtask_status(
                    current_subtask_id, SubtaskStatus.REJECTED,
                    "Quality check error")
            return (ControllerState.PLAN, TriggerRole.EVALUATOR_QUALITY_CHECK, f"QUALITY_CHECK state error: {str(e)}", TriggerCode.QUALITY_CHECK_ERROR)
    
    def handle_plan_state(self) -> tuple[ControllerState, TriggerRole, str, TriggerCode]:
        """Replanning phase"""
        logger.info("Handling PLAN state")

        try:
            # Increment planning count
            self.global_state.increment_plan_num()
            logger.info(f"Plan number incremented to: {self.global_state.get_plan_num()}")
            
            # Call Manager for replanning
            self.manager.plan_task("replan")
            
            # Check new subtask list
            task = self.global_state.get_task()
            pending_subtask_ids = task.pending_subtask_ids or []

            if pending_subtask_ids:
                # Have subtasks, set the first one as current subtask
                first_subtask_id = pending_subtask_ids[0]
                self.global_state.advance_to_next_subtask()
                self.global_state.update_task_status(TaskStatus.PENDING)
                logger.info(f"Set current subtask: {first_subtask_id}")
                return (ControllerState.GET_ACTION, TriggerRole.MANAGER_REPLAN, f"First subtask {first_subtask_id} ready", TriggerCode.SUBTASK_READY_AFTER_PLAN)
            else:
                # No subtasks, task may not be completable
                logger.warning("No subtasks available, continuing to wait for planning")
                return (ControllerState.INIT, TriggerRole.MANAGER_REPLAN, "Plan error, no subtasks available", TriggerCode.PLAN_ERROR)

        except Exception as e:
            logger.error(f"Error in PLAN state: {e}")
            self.global_state.add_event("controller", "error", f"PLAN state error: {str(e)}")
            return (ControllerState.INIT, TriggerRole.MANAGER_REPLAN, f"PLAN state error: {str(e)}", TriggerCode.PLAN_ERROR)
    
    def handle_supplement_state(self) -> tuple[ControllerState, TriggerRole, str, TriggerCode]:
        """Material supplement phase"""
        logger.info("Handling SUPPLEMENT state")

        try:
            # Increment planning count (supplementing materials is also a planning behavior)
            self.global_state.increment_plan_num()
            logger.info(f"Plan number incremented to: {self.global_state.get_plan_num()} (supplement)")
            
            # Wait for Manager to supplement materials
            self.manager.plan_task("supplement")

            # If material supplement is completed, return to PLAN
            logger.info("Supplement state completed, returning to PLAN")
            return (ControllerState.PLAN, TriggerRole.MANAGER_SUPPLEMENT, "Supplement collection completed", TriggerCode.SUPPLEMENT_COMPLETED)

        except Exception as e:
            logger.error(f"Error in SUPPLEMENT state: {e}")
            self.global_state.add_event("controller", "error", f"SUPPLEMENT state error: {str(e)}")
            # current_subtask_id is not defined here, corrected to get current subtask_id
            current_subtask_id = self.global_state.get_task().current_subtask_id
            if current_subtask_id is not None:
                self.global_state.update_subtask_status(
                    current_subtask_id, SubtaskStatus.REJECTED,
                    "Supplement collection failed")
            return (ControllerState.PLAN, TriggerRole.MANAGER_SUPPLEMENT, f"SUPPLEMENT state error: {str(e)}", TriggerCode.SUPPLEMENT_ERROR)
    
    def handle_final_check_state(self) -> tuple[ControllerState, TriggerRole, str, TriggerCode]:
        """Final quality check phase"""
        logger.info("Handling FINAL_CHECK state")

        try:
            # Perform final quality check
            task = self.global_state.get_task()
            if not task:
                logger.error("No task found for final check")
                return (ControllerState.DONE, TriggerRole.EVALUATOR_FINAL_CHECK, "No task found", TriggerCode.FINAL_CHECK_ERROR)

            # Check if task is impossible by looking for "Task Cannot Be Completed" subtask
            all_subtasks = self.global_state.get_subtasks()
            for subtask in all_subtasks:
                if subtask.title == "Task Cannot Be Completed" or "cannot be completed" in subtask.title.lower():
                    logger.info("Detected impossible task, rejecting task")
                    self.global_state.update_task_status(TaskStatus.REJECTED)
                    return (ControllerState.DONE, TriggerRole.EVALUATOR_FINAL_CHECK, "Task cannot be completed", TriggerCode.TASK_IMPOSSIBLE)

            # Check if there are still pending subtasks
            if task.pending_subtask_ids and len(task.pending_subtask_ids) > 0:
                logger.info("Still have pending subtasks, switching to GET_ACTION")
                return (ControllerState.GET_ACTION, TriggerRole.EVALUATOR_FINAL_CHECK, "Still have pending subtasks", TriggerCode.FINAL_CHECK_PENDING)

            # All subtasks completed, perform final quality check
            logger.info("All subtasks completed, performing final quality check")
            
            # Here can call evaluator for final quality check
            evaluator_params = {
                "global_state": self.global_state,
                "tools_dict": self.tools_dict
            }
            evaluator = Evaluator(**evaluator_params)

            # Wait for Evaluator to complete quality check
            evaluator.quality_check()

            # Check quality check results
            gate_checks = self.global_state.get_gate_checks()
            latest_gate = None

            for gate in gate_checks:
                if not latest_gate or gate.created_at > latest_gate.created_at:
                    latest_gate = gate

            if latest_gate:
                decision = latest_gate.decision
                logger.info(f"Latest gate check decision for final check: {decision}")
                if decision == GateDecision.GATE_DONE.value:
                    # If quality check passes, mark task as completed
                    self.global_state.update_task_status(TaskStatus.FULFILLED)
                    logger.info("Final quality check passed, task fulfilled")
                    # Switch to DONE state
                    return (ControllerState.DONE, TriggerRole.EVALUATOR_FINAL_CHECK, "Final quality check passed", TriggerCode.FINAL_CHECK_PASSED)
                elif decision == GateDecision.GATE_FAIL.value:
                    # Final quality check failed
                    logger.info("Final quality check failed, task rejected")
                    # Switch to PLAN state
                    return (ControllerState.PLAN, TriggerRole.EVALUATOR_FINAL_CHECK, "Final quality check failed", TriggerCode.FINAL_CHECK_FAILED)
                    
            # Other states, continue waiting
            logger.info(f"Final quality check failed.")
            return (ControllerState.PLAN, TriggerRole.EVALUATOR_FINAL_CHECK, "Final quality check failed", TriggerCode.FINAL_CHECK_FAILED)
            
        except Exception as e:
            logger.error(f"Error in FINAL_CHECK state: {e}")
            self.global_state.add_event("controller", "error", f"FINAL_CHECK state error: {str(e)}")
            # Final quality check failed
            return (ControllerState.PLAN, TriggerRole.EVALUATOR_FINAL_CHECK, f"Final check failed: {str(e)}", TriggerCode.FINAL_CHECK_FAILED)
        

    def should_execute_immediately(self, command: CommandData) -> bool:
        """Decide whether a command should be executed immediately.
        Current heuristic: if action.type == 'memorize', do NOT execute immediately.
        Args:
            command: CommandData instance or plain dict representing a command
        Returns:
            True if should execute immediately, False otherwise
        """
        try:
            # Extract action dict from CommandData or dict
            if hasattr(command, "action"):
                action = getattr(command, "action", {}) or {}
            elif isinstance(command, dict):
                action = command.get("action", {}) or {}
            else:
                action = {}

            action_type = str(action.get("type", "")).strip().lower()
            if action_type == "memorize":
                return True
            return False
        except Exception:
            # Be conservative: if unsure, default to execute
            return False