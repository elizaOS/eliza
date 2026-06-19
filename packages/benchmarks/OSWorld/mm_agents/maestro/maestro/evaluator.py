"""
Evaluator module

This module implements the Evaluator as the quality assurance component.
It follows the design document provided by the user. The Evaluator is
responsible for validating execution quality at key checkpoints and
providing gate decisions to drive the controller flow.

"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Dict, Any, List
from datetime import datetime
import os
import json

from .new_global_state import NewGlobalState
from .enums import GateDecision, GateTrigger, WorkerDecision, WorkerDecision, TriggerCode, TRIGGER_CODE_BY_MODULE
from ..tools.new_tools import NewTools
from ..prompts import get_prompt
from .manager.utils import get_history_subtasks_info, get_pending_subtasks_info, get_failed_subtasks_info


# ========= Data Structures =========
@dataclass
class GateCheck:
    """Quality gate record structure.

    This mirrors the system GateCheck format described in the design.
    """

    gate_check_id: str
    task_id: str
    subtask_id: str
    trigger: str
    decision: str
    notes: str
    created_at: str

class Evaluator:
    """Quality Evaluator implementation.

    The Evaluator consumes the complete NewGlobalState as input and makes a
    gate decision for the specified trigger type. The actual decision logic
    that leverages LLM prompts is left as placeholders for future work.
    """

    def __init__(self,
                 global_state: NewGlobalState,
                 tools_dict: Optional[Dict[str, Any]] = None):
        """Create Evaluator.

        Args:
            global_state: Shared global state store
            tools_dict: Tool configuration dict, expects entries for
                        worker_success_role | worker_stale_role | periodic_role | final_check_role
        """
        self.global_state = global_state
        # Initialize evaluator tools using the new registration style
        self.tools_dict = tools_dict or {}

        # Use the new tool system: register four evaluator role tools by scene
        self.evaluator_agent = NewTools()
        for tool_name in ("worker_success_role", "worker_stale_role",
                          "periodic_role", "final_check_role"):
            cfg = self.tools_dict.get(tool_name)
            if not cfg or not cfg.get("provider") or not cfg.get("model"):
                raise ValueError(
                    f"Missing evaluator tool configuration for '{tool_name}' (provider/model)")
            self.evaluator_agent.register_tool(tool_name, cfg["provider"], cfg["model"])

    # ========= Public API =========
    def quality_check(self) -> GateCheck:
        """Run quality check with no external parameters.

        The trigger type is inferred from the current global state.

        Returns:
            GateCheck: The created gate check record
        """

        globalstate = self.global_state

        # Determine subtask context
        task = globalstate.get_task()
        subtask_id: Optional[str] = task.current_subtask_id

        # Get trigger code and determine tool name and prompt
        trigger_code = self._get_current_trigger_code()
        tool_name = self._trigger_code_to_tool_name(trigger_code)
        # Build prompts
        prompt = self.build_prompt_by_trigger_code(trigger_code)
        screenshot = globalstate.get_screenshot()

        # Start timing
        import time
        evaluator_start_time = time.time()

        content, _tokens, _cost = self.evaluator_agent.execute_tool(
            tool_name, {
                "str_input": prompt,
                "img_input": screenshot
            })

        # Log evaluator operation to display.json
        evaluator_duration = time.time() - evaluator_start_time
        self.global_state.log_llm_operation(
            "evaluator", f"quality_check_{trigger_code.lower()}", {
                "tokens": _tokens,
                "cost": _cost,
                "evaluator_result": content,
                "trigger_code": trigger_code,
                "subtask_id": subtask_id,
                "duration": evaluator_duration
            },
            str_input=prompt,
            # img_input=screenshot
        )

        parsed = self.parse_llm_output(content or "")
        normalized = self._normalize_decision_by_trigger_code(parsed.get("decision", ""), trigger_code)
        if normalized is None:
            raise ValueError(
                f"Invalid decision from LLM: {parsed.get('decision', '')}")
        decision = normalized
        notes = self._compose_notes(parsed)
        trigger_enum = self._trigger_code_to_gate_trigger(trigger_code)

        # Persist to global state in system format
        from .data_models import create_gate_check_data
        gate_check_id = globalstate.add_gate_check(
            create_gate_check_data(
                gate_check_id="",
                task_id=globalstate.task_id,
                decision=decision.value,
                subtask_id=subtask_id,
                notes=notes,
                trigger=trigger_enum.value,
            ))

        # Build dataclass instance to return
        record = GateCheck(
            gate_check_id=gate_check_id,
            task_id=globalstate.task_id,
            subtask_id=subtask_id or "",
            trigger=trigger_enum.value,
            decision=decision.value,
            notes=notes,
            created_at=datetime.now().isoformat(),
        )

        return record

    # ---- Trigger inference ----
    def _get_current_trigger_code(self) -> str:
        """Get current trigger_code from controller state."""
        controller_state = self.global_state.get_controller_state()
        return controller_state.get("trigger_code", "")



    def _trigger_code_to_tool_name(self, trigger_code: str) -> str:
        """Map trigger code to the concrete tool name in the new tool system."""
        mapping = {
            TriggerCode.WORKER_SUCCESS.value: "worker_success_role",
            TriggerCode.WORKER_STALE_PROGRESS.value: "worker_stale_role",
            TriggerCode.RULE_QUALITY_CHECK_STEPS.value: "periodic_role",
            TriggerCode.RULE_QUALITY_CHECK_REPEATED_ACTIONS.value: "periodic_role",  # Use periodic system prompt
            TriggerCode.ALL_SUBTASKS_COMPLETED.value: "final_check_role",
        }
        return mapping.get(trigger_code, "periodic_role")

    def _scene_to_tool_name(self, scene: str) -> str:
        """Map scene name to the concrete tool name in the new tool system."""
        mapping = {
            "WORKER_SUCCESS": "worker_success_role",
            "WORKER_STALE": "worker_stale_role",
            "PERIODIC_CHECK": "periodic_role",
            "FINAL_CHECK": "final_check_role",
        }
        return mapping.get(scene, "periodic_role")

    def _format_subtask_brief(self, subtask) -> str:
        if not subtask:
            return "(no subtask)"
        if isinstance(subtask, dict):
            title = subtask.get("title", "")
            desc = subtask.get("description", "")
            status = subtask.get("status", "")
        else:
            title = getattr(subtask, "title", "")
            desc = getattr(subtask, "description", "")
            status = getattr(subtask, "status", "")
        return f"title:\n{title}\nstatus:\n{status}\ndescription:\n{desc}"

    def _format_task_brief(self) -> str:
        task = self.global_state.get_task()
        return f"{task.objective}"

    def _get_artifacts_text(self) -> str:
        return self.global_state.get_artifacts()

    def _get_supplement_text(self) -> str:
        return self.global_state.get_supplement()

    def _get_command_history_for_subtask(self, subtask_id: Optional[str]) -> str:
        """Reference operator/technician, get historical operation records for specified subtask."""
        try:
            if not subtask_id:
                return "No historical operation records"
            commands = list(reversed(self.global_state.get_commands_for_subtask(subtask_id)))
            if not commands:
                return "No historical operation records"
            history_lines: List[str] = []
            history_lines.append("=== Historical Operation Records ===")
            for i, cmd in enumerate(commands, 1):
                action_type = "Unknown Operation"
                action_desc = ""
                action = getattr(cmd, "action", None)
                if isinstance(action, dict):
                    if "type" in action:
                        action_type = str(action.get("type", ""))
                    if "message" in action:
                        action_desc = str(action.get("message", ""))
                    elif "element_description" in action:
                        action_desc = f"Operate element: {action['element_description']}"
                    elif "text" in action:
                        action_desc = f"Input text: {action['text']}"
                    elif "keys" in action:
                        action_desc = f"Key press: {action['keys']}"
                elif isinstance(action, list):
                    action_type = "Code Generation"
                    if action:
                        # Simplified display to avoid excessive length
                        first_lang, first_code = action[0]
                        action_desc = f"[1] Language: {first_lang}, Code length: {len(str(first_code))}"
                status = getattr(cmd, "worker_decision", "")
                message = getattr(cmd, "message", "") or ""
                reason_text = getattr(cmd, "reason_text", "") or ""
                exec_status = getattr(cmd, "exec_status", "")
                exec_message = getattr(cmd, "exec_message", "")
                pre_screenshot_analysis = getattr(cmd, "pre_screenshot_analysis", "")
                created_at = getattr(cmd, "created_at", "")
                history_lines.append(f"{i}. [{action_type}] - Status: {status}")
                if action_desc:
                    history_lines.append(f"   Description: {action_desc}")
                if message:
                    history_lines.append(f"   Message: {message}")
                if reason_text:
                    history_lines.append(f"   Reason: {reason_text}")
                if exec_status:
                    history_lines.append(f"   Execution Status: {exec_status}")
                if exec_message:
                    history_lines.append(f"   Execution Message: {exec_message}")
                if pre_screenshot_analysis:
                    history_lines.append(f"   Pre-Screenshot Analysis: {pre_screenshot_analysis}")
                if created_at:
                    history_lines.append(f"   Created at: {created_at}")
                history_lines.append("")
            return "\n".join(history_lines)
        except Exception as e:
            return f"Failed to get historical records: {e}"

    def _get_last_operation_brief(self, subtask_id: Optional[str]) -> str:
        """Get brief information of the most recent operation."""
        try:
            if not subtask_id:
                return "(no last operation)"
            cmd = self.global_state.get_current_command_for_subtask(subtask_id)
            if not cmd:
                return "(no last operation)"
            action_type = "Unknown Operation"
            action_desc = ""
            action = getattr(cmd, "action", None)
            if isinstance(action, dict):
                if "type" in action:
                    action_type = str(action.get("type", ""))
                if "analysis" in action:
                    analysis_text = str(action.get("analysis", ""))
                    recs = action.get("recommendations", [])
                    recs_len = len(recs) if isinstance(recs, list) else 0
                    action_desc = f"Analysis: {len(analysis_text)} chars; Recommendations: {recs_len} items"
                elif "message" in action:
                    action_desc = str(action.get("message", ""))
                elif "element_description" in action:
                    action_desc = f"Operate element: {action['element_description']}"
                elif "text" in action:
                    action_desc = f"Input text: {action['text']}"
                elif "keys" in action:
                    action_desc = f"Key press: {action['keys']}"
            elif isinstance(action, list):
                action_type = "Code Generation"
                if action:
                    first_lang, first_code = action[0]
                    action_desc = f"[1] Language: {first_lang}, Code length: {len(str(first_code))}"
            status = getattr(cmd, "worker_decision", "")
            message = getattr(cmd, "message", "") or ""
            reason_text = getattr(cmd, "reason_text", "") or ""
            exec_status = getattr(cmd, "exec_status", "")
            exec_message = getattr(cmd, "exec_message", "")
            pre_screenshot_analysis = getattr(cmd, "pre_screenshot_analysis", "")
            created_at = getattr(cmd, "created_at", "")
            lines = [
                f"Type: {action_type}",
                f"Status: {status}",
            ]
            if action_desc:
                lines.append(f"Description: {action_desc}")
            if message:
                lines.append(f"Message: {message}")
            if reason_text:
                lines.append(f"Reason: {reason_text}")
            if exec_status:
                lines.append(f"Execution Status: {exec_status}")
            if exec_message:
                lines.append(f"Execution Message: {exec_message}")
            if pre_screenshot_analysis:
                lines.append(f"Pre-Screenshot Analysis: {pre_screenshot_analysis}")
            if created_at:
                lines.append(f"Created at: {created_at}")
            return "\n".join(lines)
        except Exception as e:
            return f"(last operation unavailable: {e})"

    def _get_command_history_for_entire_task(self) -> str:
        """Aggregate operation histories for all subtasks in the task.

        Order of aggregation:
        1) Completed/history subtasks (in recorded order)
        2) Current subtask (if any)
        3) Pending subtasks (in recorded order)
        """
        try:
            task = self.global_state.get_task()
            completed_ids = list(task.history_subtask_ids or [])
            current_id = task.current_subtask_id
            pending_ids = list(task.pending_subtask_ids or [])

            ordered_ids: List[str] = []
            ordered_ids.extend(completed_ids)
            if current_id:
                ordered_ids.append(current_id)
            ordered_ids.extend(pending_ids)

            if not ordered_ids:
                return "No historical operation records"

            sections: List[str] = ["=== All Subtasks Operation Records ==="]
            for idx, sid in enumerate(ordered_ids, 1):
                subtask = self.global_state.get_subtask(sid)
                # Get a readable brief for the subtask
                if isinstance(subtask, dict):
                    title = subtask.get("title", "")
                    status = subtask.get("status", "")
                else:
                    title = getattr(subtask, "title", "")
                    status = getattr(subtask, "status", "")

                sections.append(f"\n--- Subtask {idx} [{sid}] ---")
                if title:
                    sections.append(f"Title: {title}")
                if status:
                    sections.append(f"Status: {status}")
                # Reuse per-subtask history formatter
                history_text = self._get_command_history_for_subtask(sid)
                sections.append(history_text)

            return "\n".join(sections)
        except Exception as e:
            return f"Failed to aggregate operation records: {e}"

    def _collect_scene_inputs(self, scene: str) -> dict:
        """Collect and slice inputs for a specific scene.
    
        Command selection rules:
        - WORKER_SUCCESS: all commands of current subtask
        - WORKER_STALE:   all commands of current subtask
        - PERIODIC_CHECK: last 5 commands of current subtask
        - FINAL_CHECK:    all commands of entire task
        """
        task = self.global_state.get_task()
        subtask_id = task.current_subtask_id
        subtask = self.global_state.get_subtask(
            subtask_id) if subtask_id else None
    
        history_text = (
            self._get_command_history_for_entire_task()
            if scene == "FINAL_CHECK"
            else self._get_command_history_for_subtask(subtask_id)
        )
        last_operation_text = self._get_last_operation_brief(subtask_id)
        
        global_task_status = self._get_global_task_status()
        history_subtasks_info = get_history_subtasks_info(self.global_state)
        pending_subtasks_info = get_pending_subtasks_info(self.global_state)
        failed_subtasks_info = get_failed_subtasks_info(self.global_state)
    
        return {
            "task_brief": self._format_task_brief(),
            "subtask_brief": self._format_subtask_brief(subtask),
            "artifacts": self._get_artifacts_text(),
            "supplement": self._get_supplement_text(),
            "worker_report": self._get_worker_report(subtask),
            "history_text": history_text,
            "last_operation_text": last_operation_text,
            "global_task_status": global_task_status,
            "history_subtasks_info": history_subtasks_info,
            "pending_subtasks_info": pending_subtasks_info,
            "failed_subtasks_info": failed_subtasks_info,
        }
    
    def _get_global_task_status(self) -> str:
        """Get global task status summary"""
        task = self.global_state.get_task()
        all_subtasks = self.global_state.get_subtasks()
        
        total_subtasks = len(all_subtasks)
        completed_count = len(task.history_subtask_ids or [])
        pending_count = len(task.pending_subtask_ids or [])
        current_count = 1 if task.current_subtask_id else 0
        
        # Count subtasks by status
        status_counts = {}
        for subtask in all_subtasks:
            status = subtask.status
            status_counts[status] = status_counts.get(status, 0) + 1
        
        status_summary = {
            "total_subtasks": total_subtasks,
            "completed_subtasks": completed_count,
            "pending_subtasks": pending_count,
            "current_subtask": task.current_subtask_id,
            "status_distribution": status_counts,
            "progress_percentage (%)": round((completed_count / total_subtasks * 100), 1) if total_subtasks > 0 else 0
        }
        
        return json.dumps(status_summary, indent=2)

    def build_prompt_by_trigger_code(self, trigger_code: str) -> str:
        """Build user prompt string based on trigger code."""
        # Map trigger code to scene for input collection
        scene = self._trigger_code_to_scene(trigger_code)
        inputs = self._collect_scene_inputs(scene)

        trigger_guidance = self._get_context_info_by_trigger_code(trigger_code)

        parts = [
            "# GlobalState Information\n",
            f"Task objective:\n{inputs['task_brief']}\n",
            f"\nGlobal Task Status:\n{inputs['global_task_status']}\n",
            f"\nCompleted Subtasks:\n{inputs['history_subtasks_info']}\n",
            f"\nPending Subtasks:\n{inputs['pending_subtasks_info']}\n",
            f"\nFailed Subtasks:\n{inputs['failed_subtasks_info']}\n",
            f"Artifacts (Memory written by previous operators and analysts):\n{inputs['artifacts']}\n",
            f"Supplement (Supplement materials provided by the manager):\n{inputs['supplement']}\n",
            f"Subtask:\n{inputs['subtask_brief']}\n",
            (f"Worker Report:\n{inputs['worker_report']}\n" if trigger_code == TriggerCode.WORKER_STALE_PROGRESS.value else ""),
            f"\nOperation History (Current Subtask):\n{inputs['history_text']}\n",
            f"\nLatest Operation:\n{inputs['last_operation_text']}\n",
            f"\nGuidance:\n{trigger_guidance}\n",
        ]
        return "\n".join(parts)

    def build_prompt(self, scene: str) -> str:
        """Build user prompt string containing only runtime inputs."""
        inputs = self._collect_scene_inputs(scene)

        trigger_guidance = self._get_context_info_by_trigger(scene)

        parts = [
            "# GlobalState Information\n",
            f"Task objective:\n{inputs['task_brief']}\n",
            f"\nGlobal Task Status:\n{inputs['global_task_status']}\n",
            f"\nCompleted Subtasks:\n{inputs['history_subtasks_info']}\n",
            f"\nPending Subtasks:\n{inputs['pending_subtasks_info']}\n",
            f"\nFailed Subtasks:\n{inputs['failed_subtasks_info']}\n",
            f"Artifacts (Memory written by previous operators and analysts):\n{inputs['artifacts']}\n",
            f"Supplement (Supplement materials provided by the manager):\n{inputs['supplement']}\n",
            f"Subtask:\n{inputs['subtask_brief']}\n",
            (f"Worker Report:\n{inputs['worker_report']}\n" if scene == "WORKER_STALE" else ""),
            f"\nOperation History (Current Subtask):\n{inputs['history_text']}\n",
            f"\nLatest Operation:\n{inputs['last_operation_text']}\n",
            f"\nGuidance:\n{trigger_guidance}\n",
        ]
        return "\n".join(parts)

    def _compose_notes(self, parsed: Dict[str, str]) -> str:
        parts = []
        if parsed.get("reason"):
            parts.append(f"Reason: {parsed['reason']}")
        if parsed.get("global_impact"):
            parts.append(f"Global Impact: {parsed['global_impact']}")
        if parsed.get("strategic_recommendations"):
            parts.append(f"Strategic Recommendations: {parsed['strategic_recommendations']}")
        if parsed.get("suggestion"):
            parts.append(f"Suggestion: {parsed['suggestion']}")
        if parsed.get("risk_alert"):
            parts.append(f"Risk: {parsed['risk_alert']}")
        if parsed.get("incomplete_items"):
            parts.append(f"Incomplete: {parsed['incomplete_items']}")
        return " \n".join(parts) if parts else ""

    def _normalize_decision(self, decision_text: str,
                            scene: str) -> Optional[GateDecision]:
        if not decision_text:
            return None
        d = decision_text.strip().lower()
        # Accept raw or bracketed
        d = d.replace("[", "").replace("]", "")
        # Allow synonyms
        synonyms = {
            "gate_done": GateDecision.GATE_DONE,
            "done": GateDecision.GATE_DONE,
            "gate_fail": GateDecision.GATE_FAIL,
            "fail": GateDecision.GATE_FAIL,
            "gate_supplement": GateDecision.GATE_SUPPLEMENT,
            "supplement": GateDecision.GATE_SUPPLEMENT,
            "gate_continue": GateDecision.GATE_CONTINUE,
            "continue": GateDecision.GATE_CONTINUE,
        }
        candidate = synonyms.get(d)
        if candidate is None:
            return None

        # Enforce allowed set per scene
        allowed = {
            "WORKER_SUCCESS": {GateDecision.GATE_DONE, GateDecision.GATE_FAIL},
            "WORKER_STALE": {
                GateDecision.GATE_CONTINUE, GateDecision.GATE_FAIL,
                GateDecision.GATE_SUPPLEMENT
            },
            "PERIODIC_CHECK": {
                GateDecision.GATE_CONTINUE, GateDecision.GATE_DONE,
                GateDecision.GATE_FAIL, GateDecision.GATE_SUPPLEMENT
            },
            "FINAL_CHECK": {GateDecision.GATE_DONE, GateDecision.GATE_FAIL},
        }[scene]
        return candidate if candidate in allowed else None

    def _get_worker_report(self, subtask) -> str:
        """Extract the latest worker-reported reason from subtask.

        Priority:
        1) subtask.last_reason_text
        2) the latest entry in subtask.reasons_history[].text
        3) empty string
        """
        if not subtask:
            return ""
        # 1) direct field
        if isinstance(subtask, dict):
            text = subtask.get("last_reason_text")
            if isinstance(text, str) and text.strip():
                return text.strip()
        else:
            text_val = getattr(subtask, "last_reason_text", None)
            if isinstance(text_val, str) and text_val.strip():
                return text_val.strip()

        # 2) history fallback
        hist = subtask.get("reasons_history") if isinstance(
            subtask, dict) else getattr(subtask, "reasons_history", [])
        if isinstance(hist, list) and hist:
            try:

                def get_at(entry):
                    if isinstance(entry, dict):
                        return entry.get("at", "")
                    return getattr(entry, "at", "")

                latest = max(hist, key=lambda x: get_at(x))
                if isinstance(latest, dict):
                    t = latest.get("text", "")
                else:
                    t = getattr(latest, "text", "")
                return t.strip() if isinstance(t, str) else ""
            except Exception:
                pass
        return ""

    # ========= Output parsing helpers =========
    def parse_llm_output(self, text: str) -> dict:
        """Parse the model output into fields expected by controller and storage.

        Expected keys per scene (subset used per decision):
        - Decision: required
        - Reason: short text
        - Global Impact: analysis of overall task impact
        - Strategic Recommendations: suggestions for task optimization
        - Suggestion: optional in STALE
        - Risk Alert: optional in PERIODIC_CHECK
        - Incomplete Items: optional in FINAL_CHECK
        """
        result: dict[str, str] = {}
        if not text:
            return result
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        for ln in lines:
            if ln.lower().startswith("decision:"):
                result["decision"] = ln.split(":", 1)[1].strip()
            elif ln.lower().startswith("reason:"):
                result["reason"] = ln.split(":", 1)[1].strip()
            elif ln.lower().startswith("global impact:"):
                result["global_impact"] = ln.split(":", 1)[1].strip()
            elif ln.lower().startswith("strategic recommendations:"):
                result["strategic_recommendations"] = ln.split(":", 1)[1].strip()
            elif ln.lower().startswith("suggestion:"):
                result["suggestion"] = ln.split(":", 1)[1].strip()
            elif ln.lower().startswith("risk alert:"):
                result["risk_alert"] = ln.split(":", 1)[1].strip()
            elif ln.lower().startswith("incomplete items:"):
                result["incomplete_items"] = ln.split(":", 1)[1].strip()
        return result

    def _trigger_code_to_scene(self, trigger_code: str) -> str:
        """Map trigger code to scene for input collection."""
        mapping = {
            TriggerCode.WORKER_SUCCESS.value: "WORKER_SUCCESS",
            TriggerCode.WORKER_STALE_PROGRESS.value: "WORKER_STALE",
            TriggerCode.RULE_QUALITY_CHECK_STEPS.value: "PERIODIC_CHECK",
            TriggerCode.RULE_QUALITY_CHECK_REPEATED_ACTIONS.value: "PERIODIC_CHECK",
            TriggerCode.ALL_SUBTASKS_COMPLETED.value: "FINAL_CHECK",
        }
        return mapping.get(trigger_code, "PERIODIC_CHECK")

    def _get_context_info_by_trigger_code(self, trigger_code: str) -> str:
        """Return detailed guidance text per trigger code.
        Mirrors the system architecture trigger guidance philosophy.
        """
        if trigger_code == TriggerCode.WORKER_SUCCESS.value:
            return (
                "# Worker Success - Verification Guidance\n"
                "- Worker claims the current subtask is completed; rigorously verify completeness\n"
                "- Cross-check each subtask requirement with clear evidence of completion\n"
                "- Verify there is explicit success feedback for key steps\n"
                "- If evidence is insufficient or inconsistent, choose gate_fail and explain why\n"
                "- Consider how this subtask completion affects overall task progress and other subtasks\n"
                "- Provide strategic insights for optimizing the overall task execution\n"
            )
        if trigger_code == TriggerCode.WORKER_STALE_PROGRESS.value:
            return (
                "# Worker Stale - Diagnosis Guidance\n"
                "- Diagnose causes of stagnation: element not found, error dialogs, loops, missing credentials, etc.\n"
                "- Assess completed progress versus remaining path and decide feasibility of continuation\n"
                "- If information is missing, specify the required supplement materials and their purpose\n"
                "- If continuation is feasible, provide breakthrough suggestions; otherwise recommend replanning\n"
                "- Analyze how this stagnation affects overall task timeline and success probability\n"
                "- Identify lessons learned that could prevent similar issues in other subtasks\n"
                "- Recommend strategic changes to overall task execution plan if needed\n"
            )
        if trigger_code == TriggerCode.RULE_QUALITY_CHECK_STEPS.value:
            return (
                "# Periodic Check - Health Monitoring Guidance\n"
                "- Identify the current execution stage and whether it matches expectations\n"
                "- Detect repetitive ineffective operations or obvious deviation from the target\n"
                "- Prefer early intervention when early risks are detected\n"
                "- Allowed decisions: gate_continue / gate_done / gate_fail / gate_supplement\n"
                "- Evaluate overall task progress and timeline health from a strategic perspective\n"
                "- Identify recurring issues across multiple subtasks and recommend optimizations\n"
                "- Assess whether the overall task strategy needs adjustment\n"
            )
        if trigger_code == TriggerCode.RULE_QUALITY_CHECK_REPEATED_ACTIONS.value:
            return (
                "# Repeated Actions Check - Repetitive Behavior Detection Guidance\n"
                "- This check was triggered because the last several commands are identical or highly similar\n"
                "- Analyze the repetitive pattern to determine if it indicates stuck behavior or systematic approach\n"
                "- Look for signs of: element not found, permission denied, network errors, or UI state issues\n"
                "- If the worker appears stuck, recommend specific breakthrough strategies or replanning\n"
                "- If missing information is causing repetition, specify required supplement materials\n"
                "- Allowed decisions: gate_continue (if repetition is justified) / gate_fail (if stuck) / gate_supplement (if missing info) / gate_done (if actually completed)\n"
                "- Provide specific recommendations for breaking out of the repetitive cycle\n"
                "- Consider how this repetition affects overall task timeline and success probability\n"
            )
        if trigger_code == TriggerCode.ALL_SUBTASKS_COMPLETED.value:
            return (
                "# Final Check - Completion Verification Guidance\n"
                "- Verify DoD/acceptance criteria item by item and cross-subtask consistency\n"
                "- Check whether the final UI/result aligns with the user objective\n"
                "- If core functionality is missing or evidence is insufficient, choose gate_fail and list the major missing items\n"
                "- Evaluate the efficiency and effectiveness of the entire task execution\n"
                "- Provide strategic insights and lessons learned for future task improvements\n"
                "- Recommend optimizations for similar task planning and execution\n"
            )
        return (
            "# General Check - Guidance\n"
            "- Analyze the current context and history to make a robust judgment\n"
            "- Stay conservative when uncertain and provide clear reasons\n"
            "- Always consider the broader task context and long-term strategy\n"
            "- Provide strategic insights for overall task optimization\n"
        )

    def _normalize_decision_by_trigger_code(self, decision_text: str, trigger_code: str) -> Optional[GateDecision]:
        """Normalize decision text to GateDecision enum based on trigger code."""
        if not decision_text:
            return None
        d = decision_text.strip().lower()
        # Accept raw or bracketed
        d = d.replace("[", "").replace("]", "")
        # Allow synonyms
        synonyms = {
            "gate_done": GateDecision.GATE_DONE,
            "done": GateDecision.GATE_DONE,
            "gate_fail": GateDecision.GATE_FAIL,
            "fail": GateDecision.GATE_FAIL,
            "gate_supplement": GateDecision.GATE_SUPPLEMENT,
            "supplement": GateDecision.GATE_SUPPLEMENT,
            "gate_continue": GateDecision.GATE_CONTINUE,
            "continue": GateDecision.GATE_CONTINUE,
        }
        candidate = synonyms.get(d)
        if candidate is None:
            return None

        # Enforce allowed set per trigger code
        allowed = {
            TriggerCode.WORKER_SUCCESS.value: {GateDecision.GATE_DONE, GateDecision.GATE_FAIL},
            TriggerCode.WORKER_STALE_PROGRESS.value: {
                GateDecision.GATE_CONTINUE, GateDecision.GATE_FAIL,
                GateDecision.GATE_SUPPLEMENT
            },
            TriggerCode.RULE_QUALITY_CHECK_STEPS.value: {
                GateDecision.GATE_CONTINUE, GateDecision.GATE_DONE,
                GateDecision.GATE_FAIL, GateDecision.GATE_SUPPLEMENT
            },
            TriggerCode.RULE_QUALITY_CHECK_REPEATED_ACTIONS.value: {
                GateDecision.GATE_CONTINUE, GateDecision.GATE_DONE,
                GateDecision.GATE_FAIL, GateDecision.GATE_SUPPLEMENT
            },
            TriggerCode.ALL_SUBTASKS_COMPLETED.value: {GateDecision.GATE_DONE, GateDecision.GATE_FAIL},
        }.get(trigger_code, {GateDecision.GATE_CONTINUE, GateDecision.GATE_DONE, GateDecision.GATE_FAIL, GateDecision.GATE_SUPPLEMENT})
        
        return candidate if candidate in allowed else None

    def _trigger_code_to_gate_trigger(self, trigger_code: str) -> GateTrigger:
        """Map trigger code to GateTrigger enum."""
        mapping = {
            TriggerCode.WORKER_SUCCESS.value: GateTrigger.WORKER_SUCCESS,
            TriggerCode.WORKER_STALE_PROGRESS.value: GateTrigger.WORKER_STALE,
            TriggerCode.RULE_QUALITY_CHECK_STEPS.value: GateTrigger.PERIODIC_CHECK,
            TriggerCode.RULE_QUALITY_CHECK_REPEATED_ACTIONS.value: GateTrigger.PERIODIC_CHECK,
            TriggerCode.ALL_SUBTASKS_COMPLETED.value: GateTrigger.FINAL_CHECK,
        }
        return mapping.get(trigger_code, GateTrigger.PERIODIC_CHECK)

    def _get_context_info_by_trigger(self, scene: str) -> str:
        """Return detailed guidance text per evaluator trigger scene.
        Mirrors the system architecture trigger guidance philosophy.
        """
        if scene == "WORKER_SUCCESS":
            return (
                "# Worker Success - Verification Guidance\n"
                "- Worker claims the current subtask is completed; rigorously verify completeness\n"
                "- Cross-check each subtask requirement with clear evidence of completion\n"
                "- Verify there is explicit success feedback for key steps\n"
                "- If evidence is insufficient or inconsistent, choose gate_fail and explain why\n"
                "- Consider how this subtask completion affects overall task progress and other subtasks\n"
                "- Provide strategic insights for optimizing the overall task execution\n"
            )
        if scene == "WORKER_STALE":
            return (
                "# Worker Stale - Diagnosis Guidance\n"
                "- Diagnose causes of stagnation: element not found, error dialogs, loops, missing credentials, etc.\n"
                "- Assess completed progress versus remaining path and decide feasibility of continuation\n"
                "- If information is missing, specify the required supplement materials and their purpose\n"
                "- If continuation is feasible, provide breakthrough suggestions; otherwise recommend replanning\n"
                "- Analyze how this stagnation affects overall task timeline and success probability\n"
                "- Identify lessons learned that could prevent similar issues in other subtasks\n"
                "- Recommend strategic changes to overall task execution plan if needed\n"
            )
        if scene == "PERIODIC_CHECK":
            return (
                "# Periodic Check - Health Monitoring Guidance\n"
                "- Identify the current execution stage and whether it matches expectations\n"
                "- Detect repetitive ineffective operations or obvious deviation from the target\n"
                "- Prefer early intervention when early risks are detected\n"
                "- Allowed decisions: gate_continue / gate_done / gate_fail / gate_supplement\n"
                "- Evaluate overall task progress and timeline health from a strategic perspective\n"
                "- Identify recurring issues across multiple subtasks and recommend optimizations\n"
                "- Assess whether the overall task strategy needs adjustment\n"
            )
        if scene == "FINAL_CHECK":
            return (
                "# Final Check - Completion Verification Guidance\n"
                "- Verify DoD/acceptance criteria item by item and cross-subtask consistency\n"
                "- Check whether the final UI/result aligns with the user objective\n"
                "- If core functionality is missing or evidence is insufficient, choose gate_fail and list the major missing items\n"
                "- Evaluate the efficiency and effectiveness of the entire task execution\n"
                "- Provide strategic insights and lessons learned for future task improvements\n"
                "- Recommend optimizations for similar task planning and execution\n"
            )
        return (
            "# General Check - Guidance\n"
            "- Analyze the current context and history to make a robust judgment\n"
            "- Stay conservative when uncertain and provide clear reasons\n"
            "- Always consider the broader task context and long-term strategy\n"
            "- Provide strategic insights for overall task optimization\n"
        )
