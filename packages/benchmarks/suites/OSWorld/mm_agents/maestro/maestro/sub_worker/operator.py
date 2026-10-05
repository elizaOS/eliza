"""
Operator Module for GUI-Agent Architecture (agents3)
- Merges action planning (LLM) and visual grounding
- Generates next UI action and grounds it to screen coordinates
- Produces Action dicts compatible with agents3 Action.py and hardware_interface.py
"""

from __future__ import annotations

import time
import logging
from typing import Any, Dict, List, Optional

from ...tools.new_tools import NewTools
from ...utils.common_utils import (
    parse_single_code_from_string,
    sanitize_code,
    extract_first_agent_function,
    parse_screenshot_analysis,
)
from ..grounding import Grounding
from ..new_global_state import NewGlobalState

logger = logging.getLogger(__name__)


class Operator:
    """Operator role: generate next UI action and ground it to screen coordinates.

    Responsibilities:
    - Query the LLM action generator to propose the next grounded action (code snippet)
    - Parse the proposed action and extract intent + arguments
    - If necessary, run visual grounding to obtain precise coordinates
    - Return a normalized action dict compatible with `Action.py` for hardware execution

    """

    def __init__(
        self,
        tools_dict: Dict[str, Any],
        global_state: NewGlobalState,
        platform: str = "Windows",
        enable_search: bool = False,
        screen_size: List[int] = [1920, 1080],
        client_password: str = "osworld-public-evaluation",
    ) -> None:
        self.tools_dict = tools_dict
        self.global_state = global_state
        self.platform = platform
        self.enable_search = enable_search
        self.screen_size = screen_size
        self.client_password = client_password

        # Embedding engine for Memory
        self.embedding_engine = NewTools()
        self.embedding_engine.register_tool(
            "embedding",
            self.tools_dict["embedding"]["provider"],
            self.tools_dict["embedding"]["model"],
        )

        # LLM for action generation
        self.operator_agent_name = "operator_role"
        tool_params = {}
        action_gen_cfg = self.tools_dict.get("action_generator", {})
        if self.enable_search:
            tool_params["enable_search"] = action_gen_cfg.get("enable_search", True)
            tool_params["search_provider"] = action_gen_cfg.get("search_provider", "bocha")
            tool_params["search_model"] = action_gen_cfg.get("search_model", "")
        else:
            tool_params["enable_search"] = False
        self.operator_agent = NewTools()
        self.operator_agent.register_tool(
            self.operator_agent_name,
            self.tools_dict[self.operator_agent_name]["provider"],
            self.tools_dict[self.operator_agent_name]["model"],
             **tool_params
        )

        # Visual grounding
        self.grounding_agent = Grounding(
            Tools_dict=self.tools_dict,
            platform=self.platform,
            global_state=self.global_state,
            width=self.screen_size[0],
            height=self.screen_size[1]
        )

    def _extract_candidate_action(self, text: str) -> Optional[Dict[str, Any]]:
        """Extract CandidateAction JSON from LLM output if provided."""
        import re, json
        try:
            m = re.search(r"CandidateAction\s*:\s*(\{.*?\})", text, re.DOTALL)
            if m:
                return json.loads(m.group(1))
            m2 = re.search(r"```json\s*(\{.*?\})\s*```", text, re.DOTALL)
            if m2:
                candidate = json.loads(m2.group(1))
                if isinstance(candidate, dict):
                    return candidate
        except Exception:
            pass
        return None

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
                created_at = getattr(cmd, "created_at", "")
                
                history_lines.append(f"{i}. [{action_type}] - Status: {status}")
                if action_desc:
                    history_lines.append(f"   Action details: {action_desc}")
                if message:
                    history_lines.append(f"   Message: {message}")
                if exec_status:
                    history_lines.append(f"   Execution status: {exec_status}")
                if exec_message:
                    history_lines.append(f"   Execution message: {exec_message}")
                if cmd.pre_screenshot_analysis:
                    history_lines.append(f"   Pre-execution screenshot analysis: {cmd.pre_screenshot_analysis}")
                if created_at:
                    history_lines.append(f"   Created at: {created_at}")
                history_lines.append("")
            
            return "\n".join(history_lines)
        except Exception as e:
            logger.warning(f"Failed to get command history: {e}")
            return "Failed to get historical records"

    def _get_previous_subtasks_command_history(self, current_subtask_id: str, limit: Optional[int] = None) -> str:
        """Aggregate command histories of all previous subtasks (excluding current).

        Args:
            current_subtask_id: ID of the current subtask to exclude
            limit: Optional maximum number of previous subtasks to include (most recent first)
        """
        try:
            task = self.global_state.get_task()
            all_subtasks = {s.subtask_id: s for s in self.global_state.get_subtasks()}
            history_ids = list(getattr(task, 'history_subtask_ids', []) or [])
            # Keep order from oldest to newest, then exclude current and optionally limit from the end (most recent)
            previous_ids = [sid for sid in history_ids if sid != current_subtask_id and sid in all_subtasks]
            if limit is not None and limit > 0:
                previous_ids = previous_ids[-limit:]
            if not previous_ids:
                # Fallback: include any other subtasks except current, ordered by updated_at if available
                others = [s for sid, s in all_subtasks.items() if sid != current_subtask_id]
                if not others:
                    return ""
                try:
                    others.sort(key=lambda x: getattr(x, 'updated_at', ''), reverse=True)
                except Exception:
                    pass
                previous_ids = [s.subtask_id for s in others]
                if limit is not None and limit > 0:
                    previous_ids = previous_ids[:limit]

            lines: List[str] = []
            if not previous_ids:
                return ""
            
            for idx, sid in enumerate(previous_ids, 1):
                subtask = all_subtasks.get(sid)
                title = getattr(subtask, 'title', '') if subtask else ''
                lines.append(f"--- Subtask {idx} ---")
                if title:
                    lines.append(f"Title: {title}")
                commands = list(reversed(self.global_state.get_commands_for_subtask(sid)))
                if not commands:
                    lines.append("No operation command records")
                    lines.append("")
                    continue
                for i, cmd in enumerate(commands, 1):
                    action_type = "Unknown operation"
                    action_desc = ""
                    if isinstance(cmd.action, dict):
                        if "type" in cmd.action:
                            action_type = cmd.action["type"]
                        if "message" in cmd.action:
                            action_desc = cmd.action["message"]
                        elif "element_description" in cmd.action:
                            action_desc = f"Operate element: {cmd.action['element_description']}"
                        elif "text" in cmd.action:
                            action_desc = f"Input text: {cmd.action['text']}"
                        elif "keys" in cmd.action:
                            action_desc = f"Keys: {cmd.action['keys']}"
                    status = getattr(cmd, 'worker_decision', '')
                    message = getattr(cmd, 'message', '') or ''
                    exec_status = getattr(cmd, 'exec_status', '')
                    exec_message = getattr(cmd, 'exec_message', '')
                    pre_screenshot_analysis = getattr(cmd, 'pre_screenshot_analysis', '')
                    created_at = getattr(cmd, 'created_at', '')
                    lines.append(f"{i}. [{action_type}] - Status: {status}")
                    if action_desc:
                        lines.append(f"   Description: {action_desc}")
                    if message:
                        lines.append(f"   Message: {message}")
                    if exec_status:
                        lines.append(f"   Execution status: {exec_status}")
                    if exec_message:
                        lines.append(f"   Execution message: {exec_message}")
                    if pre_screenshot_analysis:
                        lines.append(f"   Pre-execution screenshot analysis: {pre_screenshot_analysis}")
                    if created_at:
                        lines.append(f"   Created at: {created_at}")
                lines.append("")
            return "\n".join(lines)
        except Exception as e:
            logger.warning(f"Failed to get previous subtasks history: {e}")
            return ""

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    def _should_inject_spreadsheet_protocol(self, *texts: str) -> bool:
        """Detect if current context is about spreadsheets/tables/cell ranges.

        This aims to reduce misaligned inputs (e.g., F10:F23 vs F11:F24) by injecting zoom-first guidance.
        """
        try:
            keywords = [
                "A1", "B2", "C3", "F10", "F11", "F23", ":F", "F10:F23", "F11:F24", "cell", "range", "sheet", "Sheet", "Excel", "Calc", "工作表", "工作簿"
            ]
            haystack = "\n".join([t for t in texts if isinstance(t, str)]).lower()
            return any(k.lower() in haystack for k in keywords)
        except Exception:
            return False

    def _should_inject_vscode_protocol(self, *texts: str) -> bool:
        """Detect if current context is about VS Code operations, especially settings.

        This aims to ensure proper command palette usage with ">" symbol for settings.
        """
        try:
            keywords = [
                "vs code", "vscode", "visual studio code", "code editor", "settings", "preferences", 
                "command palette", "ctrl+shift+p", "__pycache__", "files.exclude", "explorer view",
                "extension", "theme", "configuration", "workspace"
            ]
            haystack = "\n".join([t for t in texts if isinstance(t, str)]).lower()
            return any(k.lower() in haystack for k in keywords)
        except Exception:
            return False

    def generate_next_action(
        self,
        subtask: Dict[str, Any],
        guidance: Optional[str] = None,
        trigger_code: str = "",
    ) -> Dict[str, Any]:
        """Generate and ground the next action for the given subtask.

        Args:
            subtask: Subtask information
            guidance: Optional guidance for the task
            trigger_code: Current trigger code to adjust behavior
        
        Returns a dict containing:
        - plan: raw LLM output text
        - action: JSON action dict (if ok)
        - step_result: StepResult as dict
        - outcome: one of {"generate_action", "CANNOT_EXECUTE", "STALE_PROGRESS"}
        """
        task = self.global_state.get_task()
        screenshot_bytes = self.global_state.get_screenshot()
        if not screenshot_bytes:
            # Without screenshot, we cannot ground; signal stale
            msg = "No screenshot available for action generation"
            logger.warning(msg)
            self.global_state.log_operation("worker", "no_screenshot", {"error": msg})
            result = {
                "step_id": f"{subtask.get('subtask_id','unknown')}.step-0",
                "ok": False,
                "error": msg,
                "latency_ms": 0,
                "outcome": "STALE_PROGRESS",
            }
            return {
                "plan": "",
                "action": None,
                "step_result": result,
                "outcome": "STALE_PROGRESS",
            }

        # Get command history
        subtask_id = subtask.get("subtask_id", "")
        command_history = self._get_command_history_for_subtask(subtask_id)
        previous_history = self._get_previous_subtasks_command_history(subtask_id)

        # Read artifacts and supplement as context
        artifacts_content = ""
        supplement_content = ""
        try:
            artifacts_content = self.global_state.get_artifacts() or ""
        except Exception as e:
            logger.warning(f"Failed to get artifacts: {e}")
        try:
            supplement_content = self.global_state.get_supplement() or ""
        except Exception as e:
            logger.warning(f"Failed to get supplement: {e}")

        # Adjust prompt based on trigger_code
        context_aware_prompt = self._build_context_aware_prompt(
            subtask,
            task,
            guidance,
            command_history,
            previous_history,
            trigger_code,
            artifacts_content,
            supplement_content,
        )

        # Call action generator
        t0 = time.time()
        action_plan, total_tokens, cost_string = self.operator_agent.execute_tool(
            self.operator_agent_name,
            {"str_input": context_aware_prompt, "img_input": screenshot_bytes},
        )
        latency_ms = int((time.time() - t0) * 1000)
        self.global_state.log_llm_operation(
            "worker", 
            "action_plan_generated", 
            {
                "tokens": total_tokens,
                "cost": cost_string,
                "duration": latency_ms / 1000.0,
                "llm_output": action_plan
            },
            str_input=context_aware_prompt,
        )

        # Parse screenshot analysis and action code
        screenshot_analysis = parse_screenshot_analysis(action_plan)
        self.global_state.add_event("worker", "screenshot_analysis_parsed", f"length={len(screenshot_analysis)}")
        
        try:
            current_width, current_height = self.global_state.get_screen_size()
            self.grounding_agent.reset_screen_size(current_width, current_height)
            self.grounding_agent.assign_coordinates(action_plan, self.global_state.get_obs_for_grounding())

            action_code = parse_single_code_from_string(action_plan.split("Grounded Action")[-1])
            action_code = sanitize_code(action_code)
            self.global_state.log_operation("worker", "generated_action_code", {"action_code": action_code})
        except Exception as e:
            err = f"PARSE_ACTION_FAILED: {e}"
            logger.warning(err)
            self.global_state.log_operation("worker", "parse_action_failed", {"error": err})
            result = {
                "step_id": f"{subtask.get('subtask_id','unknown')}.step-1",
                "ok": False,
                "error": err,
                "latency_ms": latency_ms,
                "outcome": "CANNOT_EXECUTE",
            }
            return {
                "action_plan": action_plan,
                "action": None,
                "step_result": result,
                "outcome": "CANNOT_EXECUTE",
            }

        # Convert code into a normalized action dict
        agent: Grounding = self.grounding_agent
        try:
            plan_code = extract_first_agent_function(action_code)
            exec_code = eval(plan_code)  # type: ignore
            self.global_state.log_operation("worker", "generated_exec_code", {"exec_code": str(exec_code)})
            ok = True
            # Determine outcome based on action type
            action_type = ""
            message = ""
            if isinstance(exec_code, dict):
                action_type = str(exec_code.get("type", ""))
                message = str(exec_code.get("message", ""))
                if action_type == "Memorize":
                    if "information" not in exec_code:
                        if message:
                            exec_code["information"] = message
                        else:
                            exec_code["information"] = "Information memorized"
                    outcome = "worker_generate_action"
                elif action_type == "Done":
                    outcome = "worker_done"
                elif action_type == "Failed":
                    outcome = "worker_fail"
                elif action_type == "Supplement":
                    outcome = "worker_supplement"
                elif action_type == "NeedQualityCheck":
                    # For stale, try to extract CandidateAction JSON from action_plan
                    candidate = self._extract_candidate_action(action_plan)
                    exec_code = candidate if isinstance(candidate, dict) else {}
                    outcome = "worker_stale_progress"
                else:
                    outcome = "worker_generate_action"
            else:
                outcome = "worker_generate_action"

            err = None
        except Exception as e:
            ok = False
            outcome = "CANNOT_EXECUTE"
            exec_code = None
            err = f"BUILD_ACTION_FAILED: {e}"
            message = ""
            logger.warning(err)

        result = {
            "step_id": f"{subtask.get('subtask_id','unknown')}.step-1",
            "ok": ok,
            "error": err,
            "latency_ms": latency_ms,
            "outcome": outcome,
            "action": exec_code,
        }

        # Log
        self.global_state.add_event(
            "worker",
            "action_ready" if ok else "action_failed",
            f"outcome={outcome}",
        )
        return {
            "action_plan": action_plan,
            "action": exec_code,
            "step_result": result,
            "outcome": outcome,
            "screenshot_analysis": screenshot_analysis,
            "message": message,
        }

    def _build_context_aware_prompt(
        self, 
        subtask: Dict[str, Any], 
        task: Any,
        guidance: Optional[str], 
        command_history: str,
        previous_subtasks_history: str,
        trigger_code: str,
        artifacts_content: str,
        supplement_content: str
    ) -> str:
        """Build context-aware prompt based on trigger_code and inject artifacts and supplement information"""
        message = []
        # Format task information
        if task:
            message.extend([
                f"**Task Objective**: {task.objective}",
            ])
        else:
            message.append("**Task Information**: Not available")
        
        subtask_title = subtask.get("title", "")
        subtask_desc = subtask.get("description", "")
        
        def _truncate(text: str, limit: int = 3000) -> str:
            if not text:
                return ""
            if len(text) <= limit:
                return text
            return text[:limit] + "\n... (content too long, truncated)"
        
        # Add task objective alignment check
        message.append("")
        message.append("=== CRITICAL: Task Objective Alignment Check ===")
        message.append("Before executing any action, carefully review whether the current subtask description conflicts with the main Task Objective.")
        message.append("If there is any conflict or contradiction:")
        message.append("- The Task Objective takes absolute priority")
        message.append("- Adapt your approach to align with the Task Objective")
        message.append("")
        
        message.append(f"The current subtask is: {subtask_title}")
        message.append(f"You can use this extra information for completing the current subtask: {subtask_desc}")
        if guidance:
            message.append(f"GUIDANCE: {guidance}")
        
        # System context information
        message.append("")
        message.append("=== System Environment ===")
        system_context = [
            f"- Linux username: \"user\"",
            f"- [CLIENT_PASSWORD]: {self.client_password}",
            f"- Platform: {self.platform}",
        ]
        message.append("\n".join(system_context))
        
        # Add specific context information based on trigger_code
        context_info = self._get_context_info_by_trigger_code(trigger_code)
        if context_info:
            message.append("")
            message.append("=== Current Context Information ===")
            message.append(context_info)


        # Inject VS Code command palette protocol if relevant
        if self._should_inject_vscode_protocol(subtask_title, subtask_desc, artifacts_content, supplement_content):
            message.append("")
            message.append("=== VS Code Command Palette Protocol ===")
            message.append("- When using Ctrl+Shift+P to access VS Code command palette, ALWAYS ensure the \">\" symbol is present before typing setting names.")
            message.append("- If the \">\" symbol is missing or deleted, type \">\" first before entering the setting name.")
            message.append("- Examples: \">Preferences: Open Settings\", \">Files: Exclude\", \">Extensions: Install Extensions\".")
            message.append("- The \">\" symbol is essential for accessing settings and preferences in VS Code command palette.")
            message.append("- Do NOT proceed with typing setting names if the \">\" symbol is absent - add it first.")
            message.append("")
            message.append("=== VS Code Settings File Distinction ===")
            message.append("- VS Code has TWO types of settings files:")
            message.append("  * Default Settings (defaultSettings.json) - READ-ONLY system settings")
            message.append("    Access: \">Preferences: Open Default Settings (JSON)\" - CANNOT be modified")
            message.append("  * User Settings (settings.json) - EDITABLE user configuration")
            message.append("    Access: \">Preferences: Open User Settings (JSON)\" - CAN be modified")
            message.append("- When tasks require MODIFYING VS Code settings, ALWAYS use User Settings.")
            message.append("- NEVER attempt to edit Default Settings - they are read-only and changes will fail.")
            message.append("")
            message.append("=== VS Code File Exclusion Format (MANDATORY) ===")
            message.append("- When configuring file exclusion patterns in VS Code settings (e.g., files.exclude), use the format WITHOUT trailing slash.")
            message.append("- This ensures exact matching with expected validation criteria and prevents comparison failures.")
            message.append("")
            message.append("=== VS Code Settings JSON Validation (CRITICAL) ===")
            message.append("- After editing VS Code settings.json, ALWAYS verify the JSON format is valid:")
            message.append("  * Ensure proper JSON structure with matching braces: {...}")
            message.append("  * Use consistent indentation (2 or 4 spaces)")
            message.append("  * No duplicate opening/closing braces")
            message.append("  * Valid JSON syntax with proper comma placement")
            message.append("- If JSON is malformed, fix it immediately before proceeding.")
            message.append("- Invalid JSON will cause VS Code settings to fail and may corrupt the configuration.")
        
        # Inject available artifacts content
        message.append("")
        message.append("=== Available Artifacts Content (from memory records) ===")
        if artifacts_content and artifacts_content.strip():
            # message.append(_truncate(artifacts_content))
            message.append(artifacts_content) # No truncation for now, memory optimization can be added here later
        else:
            message.append("No available artifacts content")
        
        # Inject supplement materials
        message.append("")
        message.append("=== Supplement Materials (possibly from retrieval/external tools) ===")
        if supplement_content and supplement_content.strip():
            # message.append(_truncate(supplement_content))
            message.append(supplement_content) # No truncation for now, memory optimization can be added here later
        else:
            message.append("No supplement materials")

        # Add previous subtasks operation records
        if previous_subtasks_history and previous_subtasks_history.strip():
            message.append("")
            message.append("=== Previous Subtasks Operation Records ===")
            message.append(previous_subtasks_history)
        
        # Add historical operation records to prompt - this is very important context information
        message.append("")
        message.append("=== Historical Operation Records (from current subtask) ===")
        message.append(command_history)
        
        message.append("")
        message.append("=== Action Description Guidelines ===")
        message.append("- When describing elements to click, be as specific and clear as possible")
        message.append("- For color-related elements, include RGB values if visible (e.g., 'red button (RGB: 255,0,0)')")
        message.append("- For color adjustments: NEVER click directly on color swatches/blocks - instead find and use color input panels")
        message.append("- Look for 'Custom Color', 'More Colors', 'Color Picker', or similar panels where you can input color codes")
        message.append("- Use hex color codes: yellow=#FFFF00, gold=#FFBF00, orange=#FF8000, brick=#FF4000, red=#FF0000")
        message.append("- More colors: magenta=#BF0041, purple=#800080, indigo=#55308D, blue=#2A6099, teal=#158466, green=#00A933, lime=#81D41A")
        message.append("- For text color changes: ALWAYS select the text first (Ctrl+A), then use color input panel - direct clicking on color options won't work")
        message.append("- Avoid vague descriptions like 'the button' - use 'the blue Save button below the text input field'")
        message.append("")
        message.append("=== File Extension Handling ===")
        message.append("- When changing file formats in Save/Open dialogs, selecting a supported file type will automatically update the file extension; do NOT retype the filename.")
        message.append("- Only when 'All files' or 'All formats' is selected should you manually edit the filename extension.")
        message.append("- Prefer keeping the original filename and only change the extension unless the task explicitly requires renaming the base name.")
        message.append("")
        message.append("=== Terminal Python Execution Rule ===")
        message.append("Do NOT use here-doc to run Python in the current opened terminal. If you need to run Python, create a .py file first, then use `python3 your_file.py` to execute it.")
        message.append("")
        message.append("=== Browser Reuse Guideline ===")
        message.append("- Before opening a browser, check whether a browser window/tab is already open. Unless explicitly instructed to open a new browser/page, continue in the existing browser window/tab.")
        message.append("- **Smart Tab Usage**: If the current tab is empty (blank page, new tab page, or about:blank), use it directly instead of opening a new tab.")
        message.append("- If the browser already has open pages with content, avoid closing them. For searches or opening links/files, prefer opening a new tab unless the task explicitly requires closing pages.")
        message.append("- Avoid using Ctrl+O to open files in existing browser tabs, as this replaces the current page. Instead, open a new tab first, then use Ctrl+O.")
        message.append("")
        message.append("=== CRITICAL: Data Integrity and Accuracy Guidelines ===")
        message.append("- NEVER create fake URLs like 'scholar.google.com/citations?user=VjJmJUsAAAAJ' or similar patterns")
        message.append("- NEVER generate random user IDs, citation numbers, or profile identifiers")
        message.append("  * Do not create placeholder or example data")
        message.append("  * If you need to search for someone, use the actual search functionality rather than guessing")
        message.append("")
        message.append("=== WEB QUERY RETRY STRATEGY ===")
        message.append("- When searching for information online, implement systematic retry before concluding failure")
        message.append("")
        message.append("Based on the above history, current screenshot, artifacts and supplement, decide on the next action.")
        message.append("Return exactly one action as an agent.* function in Python fenced code under (Grounded Action).")
        message.append("")

        
        return "\n\n".join(message)

    def _get_context_info_by_trigger_code(self, trigger_code: str) -> str:
        """Return corresponding detailed context information and guidance based on trigger_code"""
        from ..enums import TRIGGER_CODE_BY_MODULE
        
        # Check if it belongs to WORKER_GET_ACTION_CODES
        worker_codes = TRIGGER_CODE_BY_MODULE.WORKER_GET_ACTION_CODES
        
        if trigger_code == worker_codes["subtask_ready"]:
            return """
# New Subtask Ready - Context Information
- This is a new subtask that has just been assigned
- Carefully analyze the current screen state and identify the starting point
- Review the subtask requirements and understand what needs to be accomplished
- Consider the most efficient approach to begin execution
- Look for any UI elements or visual cues that indicate the next action
- Ensure you understand the context before proceeding with any actions
"""
        
        elif trigger_code == worker_codes["execution_error"]:
            return """
# Previous Execution Error - Context Information
- The previous action execution encountered an error or failure
- Analyze the current screen state to understand what went wrong
- Look for error messages, unexpected UI states, or failed operations
- Consider alternative approaches or methods to achieve the same goal
- Review the error context and adapt your strategy accordingly
- Ensure the new action addresses the specific failure point identified

# Web Query Retry Strategy (for search/information gathering tasks)
- If this is a web search or information gathering task that failed:
  * Do NOT immediately conclude the information is unavailable after just one failed attempt
"""
        
        elif trigger_code == worker_codes["command_completed"]:
            return """
# Command Successfully Completed - Context Information
- The previous command has been successfully executed
- Check the current screen state to verify the expected outcome
- Look for visual changes, new UI elements, or progress indicators
- Assess whether the current state matches the expected result
- Identify the next logical step based on the current progress
- Continue with the next action in the subtask sequence
"""
        
        elif trigger_code == worker_codes["no_command"]:
            return """
# No Executable Command Found - Context Information
- No suitable command could be identified for the current situation
- Re-analyze the task requirements and current screen state
- Look for alternative approaches or different UI interaction methods
- Consider whether the task needs to be broken down into smaller steps
- Review the subtask description for any missed requirements
- Generate a more appropriate action based on the current context
"""
        
        elif trigger_code == worker_codes["quality_check_passed"]:
            return """
# Quality Check Passed - Context Information
- The quality check for the previous action has been successfully completed
- The action met all quality criteria and requirements
- Continue with the next step in the subtask execution
- Look for the next logical action based on the current progress
- Ensure continuity in the task execution flow
- Maintain the same level of quality for subsequent actions
"""
        
        elif trigger_code == worker_codes["subtask_ready_after_plan"]:
            return """
# Subtask Ready After Replanning - Context Information
- This subtask has been prepared after a replanning process
- The previous plan may have had issues that have been addressed
- Start fresh with the improved understanding and approach
- Pay attention to any specific guidance provided during replanning
- Ensure you follow the updated strategy and requirements
- Look for any changes in the approach or methodology
"""
        
        elif trigger_code == worker_codes["final_check_pending"]:
            return """
# Final Check Pending - Context Information
- The system is approaching the final verification stage
- Ensure all necessary steps for this subtask have been completed
- Review the current state against the subtask completion criteria
- Look for any missing elements or incomplete actions
- Verify that the current state meets the expected final outcome
- Prepare for the final quality assessment of the entire task
"""
        
        else:
            # Default case
            return """
# General Context Information
- Analyze the current screen state and task requirements
- Consider the most appropriate action based on the current context
- Ensure your action aligns with the subtask objectives
- Look for visual cues and UI elements that guide the next step
- Maintain consistency with the overall task execution strategy
"""