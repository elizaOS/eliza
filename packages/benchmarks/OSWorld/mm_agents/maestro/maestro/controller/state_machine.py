"""State Machine for Maestro Controller
Responsible for state switching and process control
"""

import time
import logging
from typing import Dict, Any

from .rule_engine import RuleEngine
from .state_handlers import StateHandlers
from ..new_global_state import NewGlobalState
from ..enums import ControllerState, TriggerRole

logger = logging.getLogger(__name__)


class StateMachine:
    """State machine, responsible for state switching and process control"""
    
    def __init__(self, 
        global_state: NewGlobalState, 
        rule_engine: RuleEngine, 
        state_handlers: StateHandlers
    ):
        self.global_state = global_state
        self.rule_engine = rule_engine
        self.state_handlers = state_handlers
        self.state_switch_count = 0
        
    def get_current_state(self) -> ControllerState:
        """Get current state"""
        return self.global_state.get_controller_current_state()
    
    def switch_state(self, new_state: ControllerState, trigger_role: TriggerRole, trigger_details: str = "", trigger_code: str = "controller"):
        """Switch to new state"""
        if new_state == self.get_current_state():
            logger.debug(f"Already in state {new_state}")
            return

        old_state = self.get_current_state()
        self.state_switch_count += 1

        # Reset repeated action counter when switching to certain states
        # This prevents stale counters from affecting new state logic
        if new_state in [ControllerState.PLAN, ControllerState.QUALITY_CHECK, ControllerState.FINAL_CHECK]:
            self.rule_engine.reset_repeated_action_counter()

        # Record state switch event
        self.global_state.add_event(
            trigger_role, "state_switch",
            f"State changed: {old_state} -> {new_state} (trigger_role: {trigger_role}, details: {trigger_details}, trigger_code: {trigger_code})"
        )

        # Update controller state, including trigger_code
        try:
            self.global_state.update_controller_state(new_state, trigger_role, trigger_details, trigger_code)
        except Exception as e:
            logger.warning(f"Failed to update controller state: {e}")

        logger.info(
            f"State switched: {old_state} -> {new_state} "
            f"(trigger_role: {trigger_role}, details: {trigger_details}, trigger_code: {trigger_code})"
        )
    
    def process_rules_and_update_states(self) -> None:
        """Process rules and update states - called after each loop iteration"""
        try:
            # 1. Check task state rules
            result = self.rule_engine.check_task_state_rules(self.state_switch_count)
            if result:
                new_state, trigger_code = result
                self.switch_state(new_state, TriggerRole.CONTROLLER, f"Task state rule triggered: {new_state}", trigger_code.value)

            # 2. Check current state rules
            result = self.rule_engine.check_current_state_rules()
            if result:
                new_state, trigger_code = result
                self.switch_state(new_state, TriggerRole.CONTROLLER, f"Current state rule triggered: {new_state}", trigger_code.value)

        except Exception as e:
            logger.error(f"Error in rule processing: {e}")
            self.global_state.log_operation(
                TriggerRole.CONTROLLER, "error",
                {"error": f"Rule processing error: {str(e)}"})
    
    def should_exit_loop(self) -> bool:
        """Determine whether to exit the main loop"""
        try:
            task = self.global_state.get_task()

            if not task:
                return False
            task_status = task.status

            if task_status == "fulfilled":
                logger.info("Task fulfilled, should exit loop")
                return True
            elif task_status == "rejected":
                logger.info("Task rejected, should exit loop")
                return True
                
            return False

        except Exception as e:
            logger.error(f"Error checking exit condition: {e}")
            return False
    
    def get_state_switch_count(self) -> int:
        """Get state switch count"""
        return self.state_switch_count
    
    def reset_state_switch_count(self):
        """Reset state switch count"""
        self.state_switch_count = 0
        logger.info("State switch count reset to 0")