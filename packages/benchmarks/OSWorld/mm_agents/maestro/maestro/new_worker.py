"""
New Worker Module for GUI-Agent Architecture (agents3)
- Provides an Operator role that integrates action planning (LLM) and visual grounding
- Produces Action dicts compatible with agents3 `Action.py` and `hardware_interface.py`
- Uses `NewGlobalState` for observations and event logging

This implementation merges the essential behaviors of the legacy `worker.py` and `grounding.py` into a
single, concise Operator that is easy to invoke from the Controller.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional
from desktop_env.desktop_env import DesktopEnv

from .new_global_state import NewGlobalState
from .data_models import create_command_data
from .enums import WorkerDecision

from .sub_worker.technician import Technician
from .sub_worker.analyst import Analyst
from .sub_worker.operator import Operator

logger = logging.getLogger(__name__)


class NewWorker:
    """Worker facade exposing specialized roles.

    Provides access to:
    - Operator: GUI interface operations with visual grounding
    - Technician: System-level operations via terminal commands
    - Analyst: Data analysis and recommendations
    """

    def __init__(
        self,
        tools_dict: Dict[str, Any],
        global_state: NewGlobalState,
        platform: str = "Windows",
        enable_search: bool = False,
        client_password: str = "osworld-public-evaluation",
        screen_size: List[int] = [1920, 1080],
    ) -> None:
        self.operator = Operator(
            tools_dict=tools_dict,
            global_state=global_state,
            platform=platform,
            enable_search=enable_search,
            screen_size=screen_size,
            client_password=client_password,
        )
        
        self.technician = Technician(
            tools_dict=tools_dict,
            global_state=global_state,
            platform=platform,
            client_password=client_password,
        )
            
        self.analyst = Analyst(
            tools_dict=tools_dict,
            global_state=global_state,
            platform=platform,
            enable_search=enable_search,
        )
        self._global_state = global_state
        self._tools_dict = tools_dict
        self._platform = platform

    def _normalize_action_for_outcome(self, outcome: str, raw_action: Optional[Dict[str, Any]], message: str) -> Dict[str, Any]:
        """Normalize action dict based on outcome for unified commands schema."""
        action: Dict[str, Any] = {}
        if outcome == WorkerDecision.STALE_PROGRESS.value:
            # Represent stale as an action with optional candidate_action
            action = {"type": "Stale"}
            if raw_action:
                action["candidate_action"] = raw_action
            return action
        if outcome == WorkerDecision.CANNOT_EXECUTE.value:
            # Keep historical style: empty action
            return {}
        if outcome == WorkerDecision.SUPPLEMENT.value:
            return {"type": "Supplement", "message": message or "."}
        if outcome == WorkerDecision.WORKER_DONE.value:
            return {"type": "Done", "message": message or ""}
        # GENERATE_ACTION or others: keep raw action
        return raw_action or {}

    def process_subtask_and_create_command(self) -> Optional[str]:
        """Route to the right role, create command/decision if applicable, and return worker_decision string.
        Returns one of WorkerDecision values or None on no-op/error.
        """
        subtask_id = self._global_state.get_task().current_subtask_id
        subtask = self._global_state.get_subtask(subtask_id) #type: ignore
        if not subtask:
            logging.warning(f"Worker: subtask {subtask_id} not found")
            return None

        # Get current trigger_code to adjust processing logic
        current_trigger_code = self._get_current_trigger_code()
        logger.info(f"Worker processing subtask {subtask_id} with trigger_code: {current_trigger_code}")

        role = (subtask.assignee_role or "operator").lower()
        try:
            if role == "operator":
                res = self.operator.generate_next_action(
                    subtask=subtask.to_dict(),  # type: ignore
                    trigger_code=current_trigger_code
                )
                outcome = (res.get("outcome") or "").strip()
                raw_action = res.get("action")
                action_plan = res.get("action_plan", "")
                screenshot_analysis = res.get("screenshot_analysis", "")
                message = res.get("message", "")
                
                normalized_action = self._normalize_action_for_outcome(outcome, raw_action, message)

                # Create command with complete information
                cmd = create_command_data(
                    command_id="", 
                    task_id=self._global_state.task_id, 
                    action=normalized_action, 
                    subtask_id=subtask_id,
                    assignee_role=subtask.assignee_role or "operator"
                )
                command_id = self._global_state.add_command(cmd)
                
                pre_screenshot_analysis = screenshot_analysis
                pre_screenshot_id = self._global_state.get_screenshot_id()

                # Update command with all fields including message and reason_text
                self._global_state.update_command_fields(
                    command_id,
                    assignee_role=subtask.assignee_role or "operator",
                    action=normalized_action,
                    pre_screenshot_id=pre_screenshot_id,
                    pre_screenshot_analysis=pre_screenshot_analysis,
                    message=message,
                    reason_text=message,
                )

                # Update worker decision based on outcome
                if outcome == WorkerDecision.GENERATE_ACTION.value and raw_action:
                    self._global_state.update_command_worker_decision(command_id, WorkerDecision.GENERATE_ACTION.value)
                elif outcome == WorkerDecision.WORKER_DONE.value:
                    self._global_state.update_command_worker_decision(command_id, WorkerDecision.WORKER_DONE.value)
                elif outcome == WorkerDecision.SUPPLEMENT.value:
                    self._global_state.update_command_worker_decision(command_id, WorkerDecision.SUPPLEMENT.value)
                elif outcome == WorkerDecision.CANNOT_EXECUTE.value:
                    self._global_state.update_command_worker_decision(command_id, WorkerDecision.CANNOT_EXECUTE.value)
                elif outcome == WorkerDecision.STALE_PROGRESS.value:
                    self._global_state.update_command_worker_decision(command_id, WorkerDecision.STALE_PROGRESS.value)

            if role == "technician":
                res = self.technician.execute_task(
                    subtask=subtask.to_dict(),  # type: ignore
                    trigger_code=current_trigger_code
                )
                outcome = (res.get("outcome") or "").strip()
                raw_action = res.get("action")
                screenshot_analysis = res.get("screenshot_analysis", "")
                message = res.get("message", "")
                
                normalized_action = self._normalize_action_for_outcome(outcome, raw_action, message)
                
                # Create command with complete information
                cmd = create_command_data(
                    command_id="", 
                    task_id=self._global_state.task_id, 
                    action=normalized_action, 
                    subtask_id=subtask_id,
                    assignee_role=subtask.assignee_role or "technician"
                )
                command_id = self._global_state.add_command(cmd)
                
                pre_screenshot_analysis = screenshot_analysis
                pre_screenshot_id = self._global_state.get_screenshot_id()

                # Update command with all fields including message and reason_text
                self._global_state.update_command_fields(
                    command_id,
                    assignee_role=subtask.assignee_role or "technician",
                    action=normalized_action,
                    pre_screenshot_id=pre_screenshot_id,
                    pre_screenshot_analysis=pre_screenshot_analysis,
                    message=message,
                    reason_text=message,
                )

                # Update worker decision based on outcome
                if outcome == WorkerDecision.GENERATE_ACTION.value and raw_action:
                    self._global_state.update_command_worker_decision(command_id, WorkerDecision.GENERATE_ACTION.value)
                elif outcome == WorkerDecision.WORKER_DONE.value:
                    self._global_state.update_command_worker_decision(command_id, WorkerDecision.WORKER_DONE.value)
                elif outcome == WorkerDecision.STALE_PROGRESS.value:
                    self._global_state.update_command_worker_decision(command_id, WorkerDecision.STALE_PROGRESS.value)
                elif outcome == WorkerDecision.SUPPLEMENT.value:
                    self._global_state.update_command_worker_decision(command_id, WorkerDecision.SUPPLEMENT.value)
                elif outcome == WorkerDecision.CANNOT_EXECUTE.value:
                    self._global_state.update_command_worker_decision(command_id, WorkerDecision.CANNOT_EXECUTE.value)

            if role == "analyst":
                # Get artifacts content for analysis
                artifacts_content = self._global_state.get_artifacts()
                
                # Check if there are memorize-related artifacts that need analysis
                if "memorize" in artifacts_content.lower() or "information" in artifacts_content.lower():
                    # If there is memorize content, use specialized memorize analysis type
                    res = self.analyst.analyze_task(
                        subtask=subtask.to_dict(), 
                        analysis_type="memorize_analysis",
                        guidance=artifacts_content
                    )
                else:
                    # General analysis
                    res = self.analyst.analyze_task(
                        subtask=subtask.to_dict(), 
                        analysis_type="general"
                    )
                
                outcome = (res.get("outcome") or "").strip()
                analysis = res.get("analysis", "")
                recommendations = res.get("recommendations", [])
                message = res.get("message", "")
                
                # For analyst, keep action payload for artifacts, but still carry reason_text
                normalized_action = {"analysis": analysis, "recommendations": recommendations}
                if outcome == WorkerDecision.WORKER_DONE.value:
                    # When analyst decides the subtask is done, convert to a Done action
                    normalized_action = {"type": "Done", "message": message or ""}
                
                # Create command with complete information
                cmd = create_command_data(
                    command_id="", 
                    task_id=self._global_state.task_id, 
                    action=normalized_action, 
                    subtask_id=subtask_id,
                    assignee_role=subtask.assignee_role or "analyst"
                )
                command_id = self._global_state.add_command(cmd)
                
                pre_screenshot_analysis = ""
                pre_screenshot_id = self._global_state.get_screenshot_id()

                # Update command with all fields
                self._global_state.update_command_fields(
                    command_id,
                    assignee_role=subtask.assignee_role or "analyst",
                    action=normalized_action,
                    pre_screenshot_id=pre_screenshot_id,
                    pre_screenshot_analysis=pre_screenshot_analysis,
                    reason_text=message,
                )
                
                if outcome == WorkerDecision.GENERATE_ACTION.value:
                    self._global_state.update_command_worker_decision(command_id, WorkerDecision.GENERATE_ACTION.value)
                    return WorkerDecision.GENERATE_ACTION.value
                elif outcome == WorkerDecision.STALE_PROGRESS.value:
                    self._global_state.update_command_worker_decision(command_id, WorkerDecision.STALE_PROGRESS.value)
                    return WorkerDecision.STALE_PROGRESS.value
                elif outcome == WorkerDecision.WORKER_DONE.value:
                    self._global_state.update_command_worker_decision(command_id, WorkerDecision.WORKER_DONE.value)
                    return WorkerDecision.WORKER_DONE.value
                else:
                    self._global_state.update_command_worker_decision(command_id, WorkerDecision.CANNOT_EXECUTE.value)
                    return WorkerDecision.CANNOT_EXECUTE.value

            return WorkerDecision.CANNOT_EXECUTE.value
        except Exception as e:
            logging.error(f"Worker: error processing subtask {subtask_id}: {e}")
            return WorkerDecision.CANNOT_EXECUTE.value

    def _get_current_trigger_code(self) -> str:
        """Get current trigger_code"""
        try:
            controller_state = self._global_state.get_controller_state()
            return controller_state.get("trigger_code", "")
        except Exception as e:
            logger.warning(f"Failed to get current trigger_code: {e}")
            return ""


# Export friendly alias
Worker = NewWorker