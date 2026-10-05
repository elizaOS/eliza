"""
Technician Module for GUI-Agent Architecture (agents3)
- Provides system-level operations via terminal commands
- Generates and executes bash/python scripts
- Returns execution results and status
"""

from __future__ import annotations

import re
import time
import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple, Union
from desktop_env.desktop_env import DesktopEnv

from ...tools.new_tools import NewTools
from ..new_global_state import NewGlobalState
from ..enums import WorkerDecision
from ...utils.common_utils import parse_technician_screenshot_analysis

logger = logging.getLogger(__name__)


@dataclass
class StepResult:
    """Lightweight step result for controller/evaluator handoff."""
    step_id: str
    ok: bool
    error: Optional[str]
    latency_ms: int
    outcome: str
    action: Optional[Dict[str, Any]] = None


class Technician:
    """Technician role: execute system-level operations via terminal commands.

    Responsibilities:
    - Generate bash/python scripts to complete system tasks
    - Execute scripts via environment controller
    - Return execution results and status

    Tools_dict requirements:
    - coding_agent: {"provider": str, "model": str} - LLM for code generation
    """

    def __init__(
        self,
        *,
        tools_dict: Dict[str, Any],
        global_state: NewGlobalState,
        platform: str = "Ubuntu",
        client_password: str = "osworld-public-evaluation",
        # max_execution_time: int = 300,
    ) -> None:
        self.tools_dict = tools_dict
        self.global_state = global_state
        self.platform = platform
        self.client_password = client_password
        # self.max_execution_time = max_execution_time

        # LLM for code generation
        self.technician_agent_name = "technician_role"
        self.technician_agent = NewTools()
        self.technician_agent.register_tool(
            self.technician_agent_name,
            self.tools_dict[self.technician_agent_name]["provider"],
            self.tools_dict[self.technician_agent_name]["model"],
        )

    def _get_command_history_for_subtask(self, subtask_id: str) -> str:
        """Get command history for specified subtask, formatted as readable text"""
        try:
            commands = list(reversed(self.global_state.get_commands_for_subtask(subtask_id)))
            if not commands:
                return "No historical operation records"
            
            history_lines = []
            history_lines.append("=== Historical Operation Records ===")
            
            for i, cmd in enumerate(commands, 1):
                # Format each command's information
                action_type = "Unknown operation"
                action_desc = ""
                
                if isinstance(cmd.action, dict):
                    action_type = cmd.action["type"]
                    action_desc = str(cmd.action)
                elif isinstance(cmd.action, list):
                    action_type = "Code generation"
                    if cmd.action:
                        descs = []
                        for idx, (lang, code) in enumerate(cmd.action, 1):
                            code_str = str(code)
                            descs.append(f"[{idx}] Language: {lang}, Code length: {len(code_str)} Code{code_str}")
                        action_desc = " | ".join(descs)
                
                # Add command status information
                status = cmd.worker_decision
                message = cmd.message if cmd.message else ""
                exec_status = getattr(cmd, "exec_status", "")
                exec_message = getattr(cmd, "exec_message", "")
                
                history_lines.append(f"{i}. [{action_type}] - Status: {status}")
                if action_desc:
                    history_lines.append(f"   Description: {action_desc}")
                if message:
                    history_lines.append(f"   Message: {message}")
                if exec_status:
                    history_lines.append(f"   Execution status: {exec_status}")
                if exec_message:
                    history_lines.append(f"   Execution message: {exec_message}")
                if cmd.pre_screenshot_analysis:
                    history_lines.append(f"   Pre-execution screenshot analysis: {cmd.pre_screenshot_analysis}")
                history_lines.append("")
            
            return "\n".join(history_lines)
        except Exception as e:
            logger.warning(f"Failed to get command history: {e}")
            return "Failed to get historical records"

    def execute_task(
        self,
        *,
        subtask: Dict[str, Any],
        guidance: Optional[str] = None,
        trigger_code: str = "",
    ) -> Dict[str, Any]:
        """Execute a system-level task using terminal commands.

        Args:
            subtask: Subtask information
            guidance: Optional guidance for the task
            trigger_code: Current trigger code to adjust behavior

        Returns a dict containing:
        - plan: generated code/script
        - execution_result: output from script execution
        - step_result: StepResult as dict
        - outcome: one of {"worker_done", "worker_fail", "worker_supplement", "worker_stale_progress", "worker_generate_action", "worker_fail"}
        - action: when outcome is worker_generate_action, a list of (lang, code) blocks
        """

        # Get command history
        subtask_id = subtask.get("subtask_id", "")
        command_history = self._get_command_history_for_subtask(subtask_id)
        task = self.global_state.get_task()

        # Check if this is a file modification task and enforce inspection-first workflow
        file_modification_guidance = self._check_file_modification_workflow(subtask, command_history)

        # Build context-aware prompt based on trigger_code
        context_aware_prompt = self._build_context_aware_prompt(
            subtask, task, guidance, command_history, trigger_code, file_modification_guidance
        )

        # Get screenshot for context
        # screenshot_bytes = self.global_state.get_screenshot()

        # Call coding agent
        t0 = time.time()
        try:
            command_plan, total_tokens, cost_string = self.technician_agent.execute_tool(
                self.technician_agent_name,
                # {"str_input": context_aware_prompt, "img_input": screenshot_bytes},
                {"str_input": context_aware_prompt},
            )
            latency_ms = int((time.time() - t0) * 1000)
            
            self.global_state.log_llm_operation(
                "technician",
                "code_generated",
                {
                    "tokens": total_tokens,
                    "cost": cost_string,
                    "duration": latency_ms / 1000.0,
                    "llm_output": command_plan
                },
                str_input=context_aware_prompt,
            )
        except Exception as e:
            err = f"CODE_GENERATION_FAILED: {e}"
            logger.warning(err)
            self.global_state.add_event("technician", "code_generation_failed", err)
            result = StepResult(
                step_id=f"{subtask.get('subtask_id','unknown')}.tech-1",
                ok=False,
                error=err,
                latency_ms=int((time.time() - t0) * 1000),
                outcome=WorkerDecision.CANNOT_EXECUTE.value,
            )
            return {
                "plan": "",
                "execution_result": "",
                "step_result": result.__dict__,
                "outcome": WorkerDecision.CANNOT_EXECUTE.value,
                "action": None,
            }

        # # Parse screenshot analysis and extract/classify
        # screenshot_analysis = parse_technician_screenshot_analysis(command_plan)
        # self.global_state.add_event("technician", "screenshot_analysis_parsed", f"length={len(screenshot_analysis)}")
        
        try:
            decision = self._infer_decision_from_text(command_plan)
            # code_blocks: List[Tuple[str, str]] = []
            code_blocks = self._extract_code_blocks(command_plan)
            decision_message = ""

            # Only try to extract code blocks when no explicit decision is detected
            # if decision is None:
            #     code_blocks = self._extract_code_blocks(command_plan)

            if decision is None and code_blocks:
                ok = True
                outcome = WorkerDecision.GENERATE_ACTION.value
                err = None
                action = code_blocks
                message = ""
            elif decision == "done":
                ok = True
                outcome = WorkerDecision.WORKER_DONE.value
                err = None
                decision_message = self._extract_decision_message(command_plan, decision)
                action = {"type": "Done", "message": decision_message}
                message = decision_message
            elif decision == "failed":
                ok = False
                outcome = WorkerDecision.CANNOT_EXECUTE.value
                err = None
                decision_message = self._extract_decision_message(command_plan, decision)
                action = {"type": "Failed", "message": decision_message}
                message = decision_message
            elif decision == "supplement":
                ok = False
                outcome = WorkerDecision.SUPPLEMENT.value
                err = None
                decision_message = self._extract_decision_message(command_plan, decision)
                action = {"type": "Supplement", "message": decision_message}
                message = decision_message
            elif decision == "need_quality_check":
                ok = True
                outcome = WorkerDecision.STALE_PROGRESS.value
                err = None
                decision_message = self._extract_decision_message(command_plan, decision)
                # Prefer CandidateAction JSON over placeholder
                candidate = self._extract_candidate_action(command_plan)
                action = candidate
                message = decision_message
            else:
                # No clear signal; treat as cannot execute
                ok = False
                outcome = WorkerDecision.CANNOT_EXECUTE.value
                err = "No code blocks or valid decision found"
                action = None
                message = ""
        except Exception as e:
            ok = False
            outcome = WorkerDecision.CANNOT_EXECUTE.value
            code_blocks = []
            err = f"CLASSIFICATION_FAILED: {e}"
            action = None
            message = ""
            logger.warning(err)
        
        result = StepResult(
            step_id=f"{subtask.get('subtask_id','unknown')}.tech-1",
            ok=ok,
            error=err,
            latency_ms=latency_ms,
            outcome=outcome,
            action=action, # type: ignore
        )

        # Log execution result
        self.global_state.add_event(
            "technician",
            "task_executed" if ok else "task_failed",
            f"outcome={outcome}",
        )

        return {
            "command_plan": command_plan,
            "action": action,
            "step_result": result.__dict__,
            "outcome": outcome,
            # "screenshot_analysis": screenshot_analysis,
            "message": message,
        }

    def _extract_code_blocks(self, text: str) -> List[Tuple[str, str]]:
        """Extract code blocks from markdown-style text.
        
        Handles both literal newlines (\n) and escaped newlines (\\n) for compatibility
        with different LLM output formats.
        """
        import re
        
        # Normalize newlines: convert escaped newlines to literal newlines
        # This handles cases where LLM outputs \\n instead of \n
        text = text.replace('\\n', '\n')
        
        # Pattern to match ```language\ncode\n```
        pattern = r'```(\w+)\n(.*?)\n```'
        matches = re.findall(pattern, text, re.DOTALL)
        
        code_blocks = []
        for lang, code in matches:
            lang = lang.lower()
            code = code.strip()
            if code:
                code_blocks.append((lang, code))
        
        return code_blocks

    def _infer_decision_from_text(self, text: str) -> Optional[str]:
        """Infer high-level decision from free-form LLM text.
        Returns one of: "done", "failed", "supplement", "need_quality_check", or None.
        """
        # First try to find structured decision format
        if "DECISION_START" in text and "DECISION_END" in text:
            # Extract content between markers
            start_marker = "DECISION_START"
            end_marker = "DECISION_END"
            start_pos = text.find(start_marker) + len(start_marker)
            end_pos = text.find(end_marker)
            
            if start_pos < end_pos:
                decision_content = text[start_pos:end_pos].strip()
                # Look for Decision: line
                import re
                decision_match = re.search(r"Decision:\s*(DONE|FAILED|SUPPLEMENT|NEED_QUALITY_CHECK)", decision_content, re.IGNORECASE)
                if decision_match:
                    decision = decision_match.group(1).lower()
                    if decision == "need_quality_check":
                        return "need_quality_check"
                    return decision

    def _extract_decision_message(self, text: str, decision: str) -> str:
        """Extract the detailed message associated with a decision.
        Returns the message explaining the decision reason and context.
        """
        import re
        
        # First try to extract from structured format
        if "DECISION_START" in text and "DECISION_END" in text:
            start_marker = "DECISION_START"
            end_marker = "DECISION_END"
            start_pos = text.find(start_marker) + len(start_marker)
            end_pos = text.find(end_marker)
            
            if start_pos < end_pos:
                decision_content = text[start_pos:end_pos].strip()
                # Look for Message: line
                message_match = re.search(r"Message:\s*(.+)", decision_content, re.IGNORECASE | re.DOTALL)
                if message_match:
                    message = message_match.group(1).strip()
                    # Clean up the message (remove extra whitespace and newlines)
                    message = re.sub(r'\s+', ' ', message)
                    if message:
                        return message

        return f"Decision {decision} was made"

    def _check_file_modification_workflow(self, subtask: Dict[str, Any], command_history: str) -> str:
        """Check if this is a file modification task and determine workflow guidance."""
        subtask_desc = subtask.get("description", "").lower()
        subtask_title = subtask.get("title", "").lower()
        
        # Keywords that indicate file modification
        file_mod_keywords = [
            "edit", "modify", "change", "update", "configure", "set",
            "write to", "save to", "_config", ".yaml", ".json", ".txt",
            ".conf", "config file", "configuration"
        ]
        
        is_file_modification = any(keyword in subtask_desc or keyword in subtask_title 
                                 for keyword in file_mod_keywords)
        
        if not is_file_modification:
            return ""
        
        # Check if we already have inspection commands in history
        has_inspection = any(
            cmd in command_history.lower() 
            for cmd in ["cat ", "head ", "tail ", "grep ", "less ", "more "]
        )
        
        if has_inspection:
            return """
**FILE MODIFICATION - STEP 2 CONTEXT:**
- Previous inspection commands were executed
- You can now proceed with the actual file modifications
- Base your changes on the inspection results from command history
"""
        else:
            return """
**FILE MODIFICATION - STEP 1 REQUIRED:**
- This task involves file modification
- You MUST start with inspection commands ONLY (cat, head, grep, less, etc.)
- DO NOT perform any modifications in this first script
- After inspection, the system will call you again for the actual modifications
"""

    def _build_context_aware_prompt(
        self, 
        subtask: Dict[str, Any], 
        task: Any,
        guidance: Optional[str], 
        command_history: str,
        trigger_code: str,
        file_modification_guidance: str = ""
    ) -> str:
        task_message = []
        if task:
            task_message.extend([
                f"**Task Objective**: {task.objective}",
            ])
        else:
            task_message.append("**Task Information**: Not available")

        subtask_title = subtask.get("title", "")
        subtask_desc = subtask.get("description", "")
        
        # System context information
        system_context = [
            "# System Environment",
            f"- Linux username: \"user\"",
            f"- Client password: {self.client_password}",
            f"- Platform: {self.platform}",
            f"- Starting directory: Same base directory for each new script execution",
            ""
        ]
        
        # Task objective alignment check
        alignment_check = [
            "# CRITICAL: Task Objective Alignment Check",
            "Before writing any script or making any decision, carefully review whether the current subtask description conflicts with the main Task Objective.",
            "If there is any conflict or contradiction:",
            "- The Task Objective takes absolute priority over subtask description",
            "- Adapt your script/approach to align with the Task Objective",
            "- Never execute scripts that would contradict or undermine the main Task Objective",
            ""
        ]
        
        # Task information
        task_info = [
            "# Current Task",
            f"**Title**: {subtask_title}",
            f"**Description**: {subtask_desc}",
        ]
        
        if guidance:
            task_info.append(f"**Guidance**: {guidance}")
        
        # Add file modification guidance if applicable
        if file_modification_guidance:
            task_info.extend([
                "# File Modification Workflow Guidance",
                file_modification_guidance,
                ""
            ])
        
        # Add context-specific guidance based on trigger_code
        context_guidance = self._get_context_info_by_trigger_code(trigger_code)
        if context_guidance:
            task_info.extend([
                "# Context-Specific Guidance",
                context_guidance,
                ""
            ])
        
        # Previous operations history
        history_section = [
            "# Previous Operations History",
            command_history,
            ""
        ]

        # Instructions for script generation
        instructions = [
            "# Instructions",
            "Based on the task description, previous history, and current context:",
            "",
            "**CRITICAL FILE OPERATION RULE**: If this task involves modifying any files, you MUST follow this two-step process:",
            "- STEP 1: First execution must ONLY examine/inspect the target files (use cat, head, grep, less, etc.)",
            "- STEP 2: Second execution performs the actual modifications based on inspection results",
            "- NEVER combine inspection and modification in a single script",
            "",
            "1. **If you need to write a script**, provide exactly ONE complete code block:",
            "   - Use ```bash for bash scripts or ```python for python code",
            "   - For file modifications: FIRST script must only inspect, SECOND script modifies",
            "   - Include verification steps and progress reporting within the script",
            "   - Handle directory navigation explicitly or use absolute paths",
            "   - Include error checking and informative output messages",
            "",
            "2. **If you cannot proceed or task is complete**, use the decision format:",
            "   ```",
            "   DECISION_START",
            "   Decision: [DONE|FAILED|SUPPLEMENT|NEED_QUALITY_CHECK]",
            "   Message: [Your detailed explanation]",
            "   DECISION_END",
            "   ```",
            "",
            "3. **Important reminders**:",
            "   - Each script runs in a fresh terminal session",
            "   - You cannot see GUI changes - rely on command output for verification",
            "   - Use `echo osworld-public-evaluation | sudo -S [command]` format for sudo operations",
            "   - Include progress indicators and result verification in your scripts",
            "",
            "# Color Gradient Arrangement (CCT) Guidance",
            "- If the task requires warm/cool gradient, compute Correlated Color Temperature (CCT) per segment (e.g., via CIE xy/XYZ and McCamy approximation).",
            "- Avoid naive metrics like average red as the primary ordering signal. Do not recolor; only reorder unless color edits are explicitly part of the objective.",
            ""
        ]

        # Combine all sections
        full_prompt = "\n".join(
            system_context + 
            alignment_check +
            task_message + 
            task_info + 
            history_section + 
            instructions
        )
        
        return full_prompt

    def _get_context_info_by_trigger_code(self, trigger_code: str) -> str:
        """Build context-aware prompt based on trigger_code"""
        from ..enums import TRIGGER_CODE_BY_MODULE
        
        # Check if it belongs to WORKER_GET_ACTION_CODES
        worker_codes = TRIGGER_CODE_BY_MODULE.WORKER_GET_ACTION_CODES
        
        if trigger_code == worker_codes["subtask_ready"]:
            return """
**New System Task Context:**
- This is a fresh system-level task assignment
- Analyze system requirements and identify necessary tools/dependencies
- Plan script execution sequence for optimal efficiency
- Consider system permissions and resource requirements
- Verify system prerequisites before proceeding with main operations
"""
        
        elif trigger_code == worker_codes["execution_error"]:
            return """
**Error Recovery Context:**
- Previous script execution encountered an error or failure
- Analyze error patterns from command history to understand root cause
- Check for: permission issues, missing dependencies, resource constraints
- Implement alternative approach or error mitigation strategy
- Include additional error handling and verification in new script
- Consider breaking complex operations into smaller, safer steps
"""
        
        elif trigger_code == worker_codes["command_completed"]:
            return """
**Continuation Context:**
- Previous script executed successfully
- Verify expected system changes occurred as planned
- Check system state, file modifications, or process status
- Determine next logical step in the task sequence
- Build upon previous success while maintaining system integrity
- Continue with appropriate next operation based on current system state
"""
        
        elif trigger_code == worker_codes["no_command"]:
            return """
**Command Generation Context:**
- No suitable system command was previously identified
- Re-analyze task requirements with fresh perspective
- Look for alternative tools, approaches, or execution methods
- Consider task decomposition into simpler system operations
- Review system constraints and available resources
- Generate clear, executable system command based on current understanding
"""
        
        elif trigger_code == worker_codes["quality_check_passed"]:
            return """
**Quality Validated Context:**
- Previous system operation passed quality verification
- System state meets required standards and criteria
- Proceed confidently to next step in task execution
- Maintain same quality standards for subsequent operations
- Continue task flow with validated foundation
- Focus on next logical system operation in the sequence
"""
        
        elif trigger_code == worker_codes["subtask_ready_after_plan"]:
            return """
**Post-Replanning Context:**
- Task has been refined through replanning process
- Previous approach may have been updated or improved
- Apply new understanding and refined strategy
- Follow updated guidance and system requirements
- Start with fresh approach based on improved planning
- Consider any new constraints or methodology changes
"""
        
        elif trigger_code == worker_codes["final_check_pending"]:
            return """
**Final Verification Context:**
- System task is approaching completion stage
- Ensure all required system operations are complete
- Verify system state matches expected final outcome
- Complete any remaining system changes or cleanup
- Prepare system for final quality assessment
- Focus on completion criteria and system validation
"""
        
        else:
            return """
**General System Context:**
- Analyze current system state and task requirements
- Choose appropriate system tools and commands for the situation
- Ensure script operations align with task objectives and safety requirements
- Consider system security, resource usage, and operational impact
- Maintain consistency with overall task execution strategy
"""

    def _extract_candidate_action(self, text: str) -> Optional[Dict[str, Any]]:
        """Try to extract a CandidateAction JSON block from the LLM output."""
        try:
            # Pattern 1: explicit CandidateAction: { ... }
            m = re.search(r"CandidateAction\s*:\s*(\{.*?\})", text, re.DOTALL)
            if m:
                import json
                return json.loads(m.group(1))

            # Pattern 2: fenced json with a top-level object having type/selector
            m2 = re.search(r"```json\s*(\{.*?\})\s*```", text, re.DOTALL)
            if m2:
                import json
                candidate = json.loads(m2.group(1))
                return candidate
        except Exception as e:
            logger.debug(f"No CandidateAction found: {e}")
        return None