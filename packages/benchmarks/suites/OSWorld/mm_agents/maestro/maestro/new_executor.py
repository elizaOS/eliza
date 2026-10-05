"""
New Executor Implementation
Executor module specifically responsible for retrieving and executing actions from global state
"""

import time
import logging
import re
from typing import Dict, Any, Optional, List, Tuple
from .data_models import CommandData
from .hardware_interface import HardwareInterface
from .new_global_state import NewGlobalState
from .enums import ExecStatus, SubtaskStatus
from desktop_env.desktop_env import DesktopEnv
from PIL import Image
from .Action import Screenshot
from .utils.screenShot import scale_screenshot_dimensions

# Setup logging
logger = logging.getLogger(__name__)


class NewExecutor:
    """Action Executor - Responsible for retrieving and executing actions"""
    
    def __init__(self, global_state: NewGlobalState, hardware_interface: HardwareInterface, env_controller: Optional[DesktopEnv] = None):
        """
        Initialize executor
        
        Args:
            global_state: Global state manager
            hardware_interface: Hardware interface
            env_controller: Environment controller for executing code scripts
        """
        self.global_state = global_state
        self.hwi = hardware_interface
        self.env_controller = env_controller.controller if env_controller is not None else None
        self.execution_timeout = 30  # Single execution timeout (seconds)
        
        logger.info("NewExecutor initialized")

    # ========== Pure Execution (No global_state Updates) ==========
    def _run_code_blocks(self, code_blocks: List[Tuple[str, str]]) -> Tuple[bool, str, Optional[str]]:
        """Execute code blocks only, return (success, combined_output, last_status). No global_state updates."""
        if not self.env_controller:
            return False, "No environment controller available for code execution", None
        results = []
        last_status: Optional[str] = None
        for lang, code in code_blocks:
            try:
                if lang in ["bash", "shell", "sh"]:
                    output_dict = self.env_controller.run_bash_script(code, timeout=600)
                    status = (output_dict or {}).get("status")
                    last_status = status
                    if status == "success":
                        results.append(f"[BASH] Success: {(output_dict or {}).get('output', '')}")
                    else:
                        out = (output_dict or {}).get('output', '')
                        err = (output_dict or {}).get('error', '')
                        msg = out if out else err
                        results.append(f"[BASH] Error: {msg}")
                elif lang in ["python", "py"]:
                    output_dict = self.env_controller.run_python_script(code)
                    status = (output_dict or {}).get("status")
                    last_status = status
                    if status == "error":
                        out = (output_dict or {}).get('output', '')
                        err = (output_dict or {}).get('error', '')
                        msg = out if out else err
                        results.append(f"[PYTHON] Error: {msg}")
                    else:
                        results.append(f"[PYTHON] Success: {(output_dict or {}).get('message', '')}")
                else:
                    results.append(f"[{lang.upper()}] Unsupported language")
            except Exception as e:
                last_status = "error"
                results.append(f"[{lang.upper()}] Execution error: {str(e)}")
        success = last_status == "success"
        return success, "\n".join(results), last_status

    # ========== Execute Hardware Actions ==========
    def _run_hardware_action(self, action: Dict[str, Any]) -> Tuple[bool, Optional[str], Optional[Image.Image]]:
        """Execute actions through hardware interaction only, return (success, error_message, screenshot). No global_state updates."""
        try:
            self.hwi.dispatchDict(action)
            time.sleep(3)
            screenshot: Image.Image = self.hwi.dispatch(Screenshot())  # type: ignore
            return True, None, screenshot
        except Exception as e:
            return False, str(e), None
    
    # ========== Execute Command ==========
    def execute_command(self, command: CommandData) -> Dict[str, Any]:
        """
        Execute the passed command (execution only, no global_state modifications):
        - Choose execution path based on subtask's assignee_role
        - operator -> hardware execution only
        - technician -> code execution only
        - analyst -> no artifact storage, return intent information only
        - No artifact writing, no exec_status updates, no screenshot updates, no step increment
        """
        try:
            subtask_id: Optional[str] = getattr(command, "subtask_id", None)
            if not subtask_id:
                return self._create_execution_result(False, "command.subtask_id is empty")
            subtask = self.global_state.get_subtask(subtask_id)
            if not subtask:
                return self._create_execution_result(False, "Subtask not found")

            # Minimal Stale handling: execute candidate_action if provided
            command_action = command.action
            if isinstance(command_action, dict) and str(command_action.get("type", "")).strip().lower() == "stale":
                cand = command_action.get("candidate_action")
                if isinstance(cand, dict) and cand:
                    command_action = cand

            assignee_role = getattr(subtask, "assignee_role", "operator")
            start_ts = time.time()

            if assignee_role == "operator":
                ok, err, _shot = self._run_hardware_action(command_action)
                return self._create_execution_result(
                    success=ok,
                    error_message=err,
                    execution_time=time.time() - start_ts,
                    action=command_action,
                )

            if assignee_role == "technician":
                # Code blocks or extract code blocks from string
                if isinstance(command.action, list) and command.action:
                    code_blocks: List[Tuple[str, str]] = []
                    for item in command.action:
                        if isinstance(item, list) and len(item) == 2:
                            lang, code = item
                            if isinstance(lang, str) and isinstance(code, str):
                                code_blocks.append((lang, code))
                    if not code_blocks:
                        return self._create_execution_result(False, "Invalid code blocks format in command.action")
                    success, combined_output, _ = self._run_code_blocks(code_blocks)
                    return self._create_execution_result(
                        success=success,
                        execution_time=time.time() - start_ts,
                        action={"type": "code_blocks_execution", "result": combined_output}
                    )
                elif isinstance(command.action, str):
                    code_blocks = self._extract_code_blocks(command.action)
                    if not code_blocks:
                        return self._create_execution_result(False, "No code blocks found in string action")
                    success, combined_output, _ = self._run_code_blocks(code_blocks)
                    return self._create_execution_result(
                        success=success,
                        execution_time=time.time() - start_ts,
                        action={"type": "code_blocks_execution", "result": combined_output}
                    )
                else:
                    return self._create_execution_result(False, "Action is not in expected format for technician role")

            if assignee_role == "analyst":
                # No artifact writing, return intent information only
                return self._create_execution_result(
                    success=True,
                    execution_time=time.time() - start_ts,
                    action={"type": "analysis_intent", "payload": command.action}
                )

            # Fallback: unknown roles execute as hardware
            ok, err, _shot = self._run_hardware_action(command.action)
            return self._create_execution_result(
                success=ok,
                error_message=err,
                execution_time=time.time() - start_ts,
                action=command.action,
            )
        except Exception as e:
            return self._create_execution_result(False, f"execute_command failed: {e}")
    
    # ========== Execute Current Action ==========
    def execute_current_action(self) -> Dict[str, Any]:
        """
        Execute the action of specified subtask (using the "current latest command" of that subtask).
        Retained for compatibility with old usage; use execute_command for executing specific commands.
        """
        try:
            subtask_id = self.global_state.get_task().current_subtask_id
            logger.info(f"Starting action execution for subtask: {subtask_id}")
            
            # Get related command (current latest)
            if not subtask_id:
                error_msg = f"No subtask_id found"
                logger.warning(error_msg)
                return self._create_execution_result(False, error_msg)
            command = self.global_state.get_current_command_for_subtask(subtask_id)
            if not command:
                error_msg = f"No command found for subtask {subtask_id}"
                logger.warning(error_msg)
                return self._create_execution_result(False, error_msg)
            command_id = command.command_id
            # Check if there's an action to execute
            if not command.action:
                error_msg = f"No action defined in command for subtask {subtask_id}"
                logger.warning(error_msg)
                return self._create_execution_result(False, error_msg)
            
            # Minimal Stale handling: execute candidate_action if provided
            command_action = command.action
            if isinstance(command_action, dict) and str(command_action.get("type", "")).strip().lower() == "stale":
                cand = command_action.get("candidate_action")
                if isinstance(cand, dict) and cand:
                    command_action = cand
            
            # Get current subtask's assignee_role
            subtask = self.global_state.get_subtask(subtask_id)
            if not subtask:
                return self._create_execution_result(False, "Subtask not found")
            
            assignee_role = getattr(subtask, "assignee_role", "operator")
            
            # Choose different execution methods based on assignee_role
            if assignee_role == "operator":
                return self._execute_action(subtask_id, command_action, command_id)
                
            elif assignee_role == "technician":
                if isinstance(command_action, list) and command_action:
                    code_blocks = []
                    for item in command_action:
                        if isinstance(item, list) and len(item) == 2:
                            lang, code = item
                            if isinstance(lang, str) and isinstance(code, str):
                                code_blocks.append((lang, code))
                    if code_blocks:
                        return self._execute_code_blocks(code_blocks, subtask_id, command_id)
                    else:
                        return self._create_execution_result(False, "Invalid code blocks format in action")
                elif isinstance(command_action, str):
                    code_blocks = self._extract_code_blocks(command_action)
                    if code_blocks:
                        return self._execute_code_blocks(code_blocks, subtask_id)
                    else:
                        return self._create_execution_result(False, "No code blocks found in string action")
                else:
                    return self._create_execution_result(False, "Action is not in expected format for technician role")
                    
            elif assignee_role == "analyst":
                try:
                    if isinstance(command_action, dict) and "analysis" in command_action:
                        analysis_result = command_action.get("analysis", "")
                        recommendations = command_action.get("recommendations", [])
                        artifact_data = {
                            "subtask_id": subtask_id,
                            "type": "analysis_result",
                            "analysis": analysis_result,
                            "recommendations": recommendations,
                            "timestamp": time.time(),
                            "source": "analyst_memorize_analysis"
                        }
                        self.global_state.add_artifact("analysis_result", artifact_data)
                        self.global_state.update_command_exec_status(
                            command_id, # type: ignore
                            ExecStatus.EXECUTED,
                            exec_message='',
                        )
                        return self._create_execution_result(True, action={"type": "analysis_artifact_stored", "artifact": artifact_data})
                    else:
                        artifact_data = {
                            "subtask_id": subtask_id,
                            "action": command_action,
                            "timestamp": time.time(),
                            "type": "action_artifact"
                        }
                        self.global_state.update_command_exec_status(
                            command_id, # type: ignore
                            ExecStatus.EXECUTED,
                            exec_message='',
                        )
                        self.global_state.add_artifact("action_artifact", artifact_data)
                        return self._create_execution_result(True, action={"type": "artifact_stored", "artifact": artifact_data})
                except Exception as e:
                    error_msg = f"Failed to store artifact: {str(e)}"
                    logger.error(error_msg)
                    return self._create_execution_result(False, error_msg)
                    
            else:
                logger.warning(f"Unknown assignee_role '{assignee_role}', falling back to hardware execution")
                return self._execute_action(subtask_id, command_action, command_id)
            
        except Exception as e:
            error_msg = f"Exception in execute_current_action: {str(e)}"
            logger.error(error_msg)
            return self._create_execution_result(False, error_msg)


    # ========== Execute Code Blocks ==========
    def _execute_code_blocks(self, code_blocks: List[Tuple[str, str]], subtask_id: str, command_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Execute list of code blocks
        
        Args:
            code_blocks: List of code blocks, each element is a tuple of (language, code)
            subtask_id: Subtask ID, used to update command's post_screenshot_id
            command_id: If provided, precisely update the execution status of that command; otherwise fallback to current latest command
        """
        if not self.env_controller:
            error_msg = "No environment controller available for code execution"
            logger.warning(error_msg)
            return self._create_execution_result(False, error_msg)
        
        execution_start = time.time()
        
        try:
            # Pure execution
            success, combined_output, last_status = self._run_code_blocks(code_blocks)

            execution_time = time.time() - execution_start
            
            # Record execution results (status updates)
            self.global_state.add_event("executor", "code_blocks_execution_completed", 
                f"Code blocks execution completed in {execution_time:.2f}s")
            exec_status = ExecStatus.EXECUTED if success else ExecStatus.ERROR
            # Precise or fallback execution status update
            self.global_state.update_command_exec_status(
                    command_id, # type: ignore
                    exec_status,
                    combined_output,
                )
            
            # Hardware screenshot (separated from execution logic)
            ok, err, screenshot = self._run_hardware_action({"type": "Screenshot"})
            if ok and screenshot is not None:
                self.global_state.set_screenshot(
                    scale_screenshot_dimensions(screenshot, self.hwi))
            
            # Get new screenshot ID and update command's post_screenshot_id
            new_screenshot_id = self.global_state.get_screenshot_id()
            if new_screenshot_id:
                self.global_state.update_command_post_screenshot(command_id, new_screenshot_id) # type: ignore
                logger.info(f"Updated post_screenshot_id for command {command_id}: {new_screenshot_id}")
                    
            
            self.global_state.increment_step_num()
            
            return self._create_execution_result(
                success=success,
                execution_time=execution_time,
                action={"type": "code_blocks_execution", "result": combined_output}
            )
            
        except Exception as e:
            execution_time = time.time() - execution_start
            error_msg = f"Code blocks execution failed: {str(e)}"
            logger.error(error_msg)
            return self._create_execution_result(False, error_msg, execution_time)
    
    # ========== Extract Code Blocks ==========
    def _extract_code_blocks(self, text: str) -> List[Tuple[str, str]]:
        """Extract code blocks from markdown-style text"""
        # Match ```language\ncode\n``` pattern
        pattern = r'```(\w+)\n(.*?)\n```'
        matches = re.findall(pattern, text, re.DOTALL)
        
        code_blocks = []
        for lang, code in matches:
            lang = lang.lower()
            code = code.strip()
            if code:
                code_blocks.append((lang, code))
        
        return code_blocks

    # ========== Execute Action ==========
    def _execute_action(self, subtask_id: str, action: Dict[str, Any], command_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Execute specific action
        
        Args:
            subtask_id: subtask ID
            action: Dictionary of action to execute
            command_id: If provided, precisely update the screenshot and execution status of that command
        """
        execution_start = time.time()
        
        try:
            logger.info(f"Executing action for subtask {subtask_id}: {action}")
            
            # Special handling for memorize actions (write to artifact), moderate separation of execution logic and status updates
            if isinstance(action, dict) and action.get("type") == "Memorize":
                information = action.get("information", "")
                if information:
                    # Business write operation
                    self.global_state.add_memorize_artifact(subtask_id, information)
                    logger.info(f"Memorize action processed for subtask {subtask_id}: {information[:100]}...")
                    
                    execution_success = True
                    error_message = None
                    execution_time = time.time() - execution_start
                    
                    # Status update
                    self._record_execution_result(subtask_id, execution_success, error_message, execution_time)


                    msg_preview = information.replace("\n", " ").strip()[:200]
                    exec_msg = f"Memorize stored ({len(information)} chars): {msg_preview}{'...' if len(information) > 200 else ''}"
                    self.global_state.update_command_exec_status(
                        command_id, # type: ignore
                        ExecStatus.EXECUTED,
                        exec_message=exec_msg,
                    )
                        
                    
                    return self._create_execution_result(
                        success=execution_success,
                        error_message=error_message,
                        execution_time=execution_time,
                        action=action
                    )
            
            # Pure execution (hardware interaction)
            ok, err, screenshot = self._run_hardware_action(action)
            execution_success = ok
            error_message = err
            
            # Screenshot writing
            if ok and screenshot is not None:
                self.global_state.set_screenshot(
                    scale_screenshot_dimensions(screenshot, self.hwi))
            
            # Get new screenshot ID and update command's post_screenshot_id
            new_screenshot_id = self.global_state.get_screenshot_id()
            if new_screenshot_id:
                self.global_state.update_command_post_screenshot(command_id, new_screenshot_id) # type: ignore
                logger.info(f"Updated post_screenshot_id for command {command_id}: {new_screenshot_id}")
                 

            self.global_state.increment_step_num()
            # Recording and status updates
            execution_time = time.time() - execution_start
            self._record_execution_result(subtask_id, execution_success, error_message, execution_time)

            # Optional: write the status of this command based on execution results
            self.global_state.update_command_exec_status(
                command_id, # type: ignore
                ExecStatus.EXECUTED if execution_success else ExecStatus.ERROR,
                exec_message=("Action executed" if execution_success else f"Action failed: {error_message}")
            )
                
            
            # Return results
            result = self._create_execution_result(
                success=execution_success,
                error_message=error_message,
                execution_time=execution_time,
                action=action
            )
            
            logger.info(f"Action execution completed for subtask {subtask_id} in {execution_time:.2f}s")
            return result
            
        except Exception as e:
            execution_time = time.time() - execution_start
            error_msg = f"Exception during action execution: {str(e)}"
            logger.error(error_msg)
            
            # Record execution exception
            self._record_execution_result(subtask_id, False, error_msg, execution_time)
            
            return self._create_execution_result(False, error_msg, execution_time)
    
    # ========== Record Execution Results ==========
    def _record_execution_result(self, subtask_id: str, success: bool, error_message: Optional[str], execution_time: float):
        """Record execution result to global state"""
        try:
            if success:
                # Record successful execution event
                self.global_state.log_operation("executor", "action_success", {
                    "subtask_id": subtask_id,
                    "execution_time": execution_time
                })
                
                # Can choose to update subtask status to executed, but state management should be decided by Controller
                # self.global_state.update_subtask_status(subtask_id, SubtaskStatus.FULFILLED, "Action executed successfully")
                
            else:
                # Record execution failure event
                self.global_state.log_operation("executor", "action_error", {
                    "subtask_id": subtask_id,
                    "error_message": error_message,
                    "execution_time": execution_time
                })
                
                # Can choose to update subtask status to failed, but state management should be decided by Controller
                # self.global_state.update_subtask_status(subtask_id, SubtaskStatus.REJECTED, f"Action execution failed: {error_message}")
                
        except Exception as e:
            logger.warning(f"Failed to record execution result: {e}")
    
    # Create standardized execution results
    def _create_execution_result(self, success: bool, error_message: Optional[str] = None, execution_time: float = 0.0, action: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Create standardized execution results"""
        result = {
            "success": success,
            "execution_time": execution_time,
            "timestamp": time.time()
        }
        
        if error_message:
            result["error_message"] = error_message
        
        if action:
            result["action"] = action
            
        return result
        
      
    def get_execution_status(self) -> Dict[str, Any]:
        """Get executor status information"""
        return {
            "executor_type": "NewExecutor",
            "hardware_backend": getattr(self.hwi, 'backend', 'unknown'),
            "execution_timeout": self.execution_timeout
        }