import json
import re
import time
import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple, Union

from ...tools.new_tools import NewTools
from ..new_global_state import NewGlobalState
from ..enums import SubtaskStatus, WorkerDecision

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


class Analyst:
    """Analyst role: analyze artifacts content and provide analytical support.

    Responsibilities:
    - Analyze artifacts content and stored information
    - Provide recommendations and insights based on data
    - Extract and process information from stored content
    - Support decision-making with data analysis
    - Handle non-GUI interaction subtasks

    Tools_dict requirements:
    - analyst_agent: {"provider": str, "model": str} - LLM for analysis
    """

    def __init__(
        self,
        tools_dict: Dict[str, Any],
        global_state: NewGlobalState,
        platform: str = "unknown",
        enable_search: bool = False,
    ) -> None:
        self.tools_dict = tools_dict
        self.global_state = global_state
        self.platform = platform

        # LLM for analysis
        self.analyst_agent_name = "analyst_role"
        self.analyst_agent = NewTools()
        self.analyst_agent.register_tool(
            self.analyst_agent_name,
            self.tools_dict[self.analyst_agent_name]["provider"],
            self.tools_dict[self.analyst_agent_name]["model"],
        )

    def analyze_task(
        self,
        *,
        subtask: Dict[str, Any],
        guidance: Optional[str] = None,
        analysis_type: str = "general",
    ) -> Dict[str, Any]:
        """Analyze the current state and provide recommendations based on artifacts content.

        Args:
            subtask: Current subtask information
            guidance: Optional guidance from manager
            analysis_type: Type of analysis (kept for compatibility, not used in new design)

        Returns a dict containing:
        - analysis: detailed analysis result
        - recommendations: list of recommendations
        - step_result: StepResult as dict
        - outcome: 
        - message: optional message when outcome is WORKER_DONE or other decisions
        """
        # Get all required context information
        task = self.global_state.get_task()
        artifacts_content = self.global_state.get_artifacts()
        history_subtasks = self.global_state.get_subtasks()  # All subtasks including completed ones
        supplement_content = self.global_state.get_supplement()

        # Only keep top 2 subtasks whose status is NOT READY, ordered by updated_at desc
        try:
            non_ready_subtasks = [
                s for s in history_subtasks
                if getattr(s, 'status', '') != SubtaskStatus.READY.value
            ]
            non_ready_subtasks.sort(key=lambda x: getattr(x, 'updated_at', ''), reverse=True)
            history_subtasks = non_ready_subtasks[:2]
        except Exception as e:
            logger.warning(f"Filter non-ready subtasks failed: {e}")

        # Get current subtask commands
        subtask_id = subtask.get('subtask_id')
        subtask_commands = []
        if subtask_id:
            subtask_obj = self.global_state.get_subtask(subtask_id)
            if subtask_obj and hasattr(subtask_obj, 'command_trace_ids'):
                for cmd_id in subtask_obj.command_trace_ids:
                    cmd = self.global_state.get_command(cmd_id)
                    if cmd:
                        subtask_commands.append(cmd.to_dict() if hasattr(cmd, 'to_dict') else cmd)

        # Check if we have sufficient information to analyze
        if not artifacts_content and not history_subtasks and not supplement_content:
            msg = "No content available for analysis (artifacts, history, or supplement)"
            logger.warning(msg)
            self.global_state.add_event("analyst", "no_content", msg)
            result = StepResult(
                step_id=f"{subtask.get('subtask_id','unknown')}.analyst-0",
                ok=False,
                error=msg,
                latency_ms=0,
                outcome=WorkerDecision.STALE_PROGRESS.value,
            )
            return {
                "analysis": "",
                "recommendations": [],
                "step_result": result.__dict__,
                "outcome": WorkerDecision.STALE_PROGRESS.value,
            }

        # Build analysis prompt with all context information
        analysis_prompt = self._build_analysis_prompt(
            subtask, task, artifacts_content, history_subtasks, 
            supplement_content, subtask_commands, guidance
        )

        # Call analyst agent
        t0 = time.time()
        try:
            analysis_result, total_tokens, cost_string = self.analyst_agent.execute_tool(
                self.analyst_agent_name,
                {"str_input": analysis_prompt},
            )
            latency_ms = int((time.time() - t0) * 1000)
            
            self.global_state.log_llm_operation(
                "analyst",
                "analysis_completed",
                {
                    "tokens": total_tokens,
                    "cost": cost_string,
                    "duration": latency_ms / 1000.0,
                    "llm_output": analysis_result
                },
                str_input=analysis_prompt
            )
        except Exception as e:
            err = f"ANALYSIS_FAILED: {e}"
            logger.warning(err)
            self.global_state.add_event("analyst", "analysis_failed", err)
            result = StepResult(
                step_id=f"{subtask.get('subtask_id','unknown')}.analyst-1",
                ok=False,
                error=err,
                latency_ms=int((time.time() - t0) * 1000),
                outcome=WorkerDecision.CANNOT_EXECUTE.value,
            )
            return {
                "analysis": "",
                "recommendations": [],
                "step_result": result.__dict__,
                "outcome": WorkerDecision.CANNOT_EXECUTE.value,
            }

        # 1) Check explicit DONE decision markers or JSON fields
        try:
            decision = self._infer_done_decision(analysis_result)
        except Exception:
            decision = None
        if decision == "done":
            # Return a WORKER_DONE outcome with a message
            msg = self._extract_done_message(analysis_result)
            ok = True
            outcome = WorkerDecision.WORKER_DONE.value
            err = None
            result = StepResult(
                step_id=f"{subtask.get('subtask_id','unknown')}.analyst-1",
                ok=ok,
                error=err,
                latency_ms=latency_ms,
                outcome=outcome,
            )
            self.global_state.add_event("analyst", "analysis_done", "Analyst marked subtask as done")
            return {
                "analysis": "",
                "recommendations": [],
                "message": msg,
                "step_result": result.__dict__,
                "outcome": outcome,
            }

        # 2) Try to extract CandidateAction first (stale continuation)
        try:
            candidate_action = self._extract_candidate_action(analysis_result)
            if isinstance(candidate_action, dict) and candidate_action:
                ok = True
                outcome = WorkerDecision.STALE_PROGRESS.value
                err = None
                result = StepResult(
                    step_id=f"{subtask.get('subtask_id','unknown')}.analyst-1",
                    ok=ok,
                    error=err,
                    latency_ms=latency_ms,
                    outcome=outcome,
                    action=candidate_action,  # type: ignore
                )
                self.global_state.add_event("analyst", "candidate_action_detected", "CandidateAction suggested in analysis")
                return {
                    "analysis": "",
                    "recommendations": [],
                    "candidate_action": candidate_action,
                    "step_result": result.__dict__,
                    "outcome": outcome,
                }
        except Exception:
            # Ignore and continue to parse JSON
            pass

        # 3) Parse analysis JSON output
        try:
            parsed_result = self._parse_analysis_result(analysis_result)
            ok = True
            outcome = WorkerDecision.GENERATE_ACTION.value
            err = None
        except Exception as e:
            ok = False
            outcome = WorkerDecision.CANNOT_EXECUTE.value
            parsed_result = {
                "analysis": f"Failed to parse analysis: {str(e)}",
                "recommendations": [],
                "summary": "",
            }
            err = f"PARSE_ANALYSIS_FAILED: {e}"
            logger.warning(err)

        result = StepResult(
            step_id=f"{subtask.get('subtask_id','unknown')}.analyst-1",
            ok=ok,
            error=err,
            latency_ms=latency_ms,
            outcome=outcome,
        )

        # Log analysis result
        self.global_state.add_event(
            "analyst",
            "analysis_ready" if ok else "analysis_failed",
            f"outcome={outcome}",
        )

        return {
            "analysis": parsed_result.get("analysis", ""),
            "recommendations": parsed_result.get("recommendations", []),
            "summary": parsed_result.get("summary", ""),
            "step_result": result.__dict__,
            "outcome": outcome,
        }

    def _build_analysis_prompt(
        self, 
        subtask: Dict[str, Any], 
        task: Any,
        artifacts_content: str,
        history_subtasks: List[Any],
        supplement_content: str,
        subtask_commands: List[Dict[str, Any]],
        guidance: Optional[str]
    ) -> str:
        """Build comprehensive analysis prompt with all context information."""
        
        # Format task information
        task_info = []
        if task:
            task_info.extend([
                f"**Task ID**: {task.task_id}",
                f"**Task Objective**: {task.objective}",
            ])
        else:
            task_info.append("**Task Information**: Not available")
        
        # Format subtask information
        subtask_info = [
            f"**Subtask Title**: {subtask.get('title', 'Not specified')}",
            f"**Subtask Description**: {subtask.get('description', 'Not specified')}",
            f"**Assignee Role**: {subtask.get('assignee_role', 'analyst')}",
        ]
        
        # Format guidance information
        guidance_info = []
        if guidance:
            guidance_info.extend([
                "# Specific Guidance",
                f"**Instructions**: {guidance}",
                ""
            ])
        
        # Format artifacts content with analysis
        artifacts_section = []
        if artifacts_content and artifacts_content.strip():
            artifacts_section.extend([
                "# Available Artifacts Content",
                f"**Content Length**: {len(artifacts_content)} characters",
                f"**Content**:",
                "```",
                artifacts_content,
                "```",
                ""
            ])
        else:
            artifacts_section.extend([
                "# Available Artifacts Content",
                "**Status**: No artifacts content available",
                ""
            ])
        
        # Format supplement content
        supplement_section = []
        if supplement_content and supplement_content.strip():
            supplement_section.extend([
                "# Supplement Information",
                f"**Content Length**: {len(supplement_content)} characters",
                f"**Content**:",
                "```",
                supplement_content,
                "```",
                ""
            ])
        else:
            supplement_section.extend([
                "# Supplement Information",
                "**Status**: No supplement content available",
                ""
            ])
        
        # Format historical context
        history_section = []
        if history_subtasks:
            history_section.extend([
                "# Historical Subtasks Context",
                f"**Total Subtasks**: {len(history_subtasks)}",
                "**Recent Subtask Summary**:"
            ])
            
            # Show last 5 subtasks with status
            recent_subtasks = history_subtasks[-5:] if len(history_subtasks) > 5 else history_subtasks
            for i, hist_subtask in enumerate(recent_subtasks, 1):
                if hasattr(hist_subtask, 'to_dict'):
                    hist_data = hist_subtask.to_dict()
                else:
                    hist_data = hist_subtask
                
                title = hist_data.get('title', 'Unknown Task')
                status = hist_data.get('status', 'Unknown')
                role = hist_data.get('assignee_role', 'Unknown')
                history_section.append(f"{i}. **{title}** (Role: {role}) - Status: {status}")
            
            history_section.append("")
        else:
            history_section.extend([
                "# Historical Subtasks Context",
                "**Status**: No historical subtask information available",
                ""
            ])
        
        # Format command execution context
        commands_section = []
        if subtask_commands:
            commands_section.extend([
                "# Current Subtask Command History",
                f"**Total Commands**: {len(subtask_commands)}",
                "**Recent Command Summary**:"
            ])
            
            # Show last 3 commands
            recent_commands = subtask_commands[-3:] if len(subtask_commands) > 3 else subtask_commands
            for i, cmd in enumerate(recent_commands, 1):
                action_type = "Unknown"
                if isinstance(cmd.get('action'), dict):
                    action_type = cmd.get('action', {}).get('type', 'Unknown')
                
                exec_status = cmd.get('exec_status', 'Unknown')
                worker_decision = cmd.get('worker_decision', 'Unknown')
                commands_section.append(f"{i}. **{action_type}** - Execution: {exec_status}, Decision: {worker_decision}")
            
            commands_section.append("")
        else:
            commands_section.extend([
                "# Current Subtask Command History",
                "**Status**: No command execution history available",
                ""
            ])
        
        # Build analysis requirements
        requirements_section = [
            "# Analysis Requirements",
            "As the Analyst role, you must:",
            "",
            "1. **Comprehensive Review**: Analyze all available information sources",
            "2. **Context Integration**: Connect information across artifacts, history, and current state", 
            "3. **Accurate Extraction**: Extract precise, verifiable data and insights",
            "4. **Actionable Recommendations**: Provide specific, implementable suggestions",
            "5. **Clear Communication**: Present findings in structured, understandable format",
            "",
            "## Special Considerations:",
            "- Focus on information that helps complete the current subtask",
            "- If this is a 'memorize' analysis, prioritize information retention and recall",
            "- For question-answering, provide comprehensive answers with evidence",
            "- When data is insufficient, clearly state limitations",
            "- Base all conclusions on available evidence, not assumptions",
            "",
            "## Completion Signaling:",
            "- If you determine the current subtask is fully completed by analysis alone, you may explicitly mark it as DONE.",
            "- You can signal completion using one of the following:",
            "  Structured markers:",
            "     DECISION_START\n     Decision: DONE\n     Message: [why it's done]\n     DECISION_END",
            ""
        ]
        
        # Output format specification
        output_section = [
            "# Required Output Format",
            "Your response supports two mutually exclusive output modes. Do NOT mix them in the same response.",
            "",
            "- JSON Mode (default when not making a decision): Return exactly one JSON object with these fields:",
            "```json",
            "{",
            '    "analysis": "Detailed analysis description explaining your findings and methodology",',
            '    "recommendations": ["Specific actionable recommendation 1", "Specific actionable recommendation 2"],',
            '    "summary": "Brief summary of key findings and conclusions"',
            "}",
            "```",
            "",
            "## Field Requirements:",
            "- **analysis**: Comprehensive explanation of findings (required)",
            "- **recommendations**: List of specific, actionable suggestions (required, can be empty list)",
            "- **summary**: Concise overview of key points (required)",
            "",
            "- Decision Mode (when you must signal task state): Use the structured decision markers exactly as specified below and do not include JSON.",
            "- If you determine the current subtask is fully completed by analysis alone, you may explicitly mark it as DONE so the controller can proceed.",
            "- You can signal completion using one of the following methods:",
            "Structured decision markers:",
            "    DECISION_START",
            "    Decision: DONE",
            "    Message: [why it's done and no further action is required]",
            "    DECISION_END",
        ]
        
        # Combine all sections
        prompt_sections = [
            "# Analysis Task",
            "You are a professional data analyst responsible for analyzing task-related information.",
            "",
            "## Task Context",
            *task_info,
            "",
            "## Current Subtask Information", 
            *subtask_info,
            ""
        ]
        
        if guidance_info:
            prompt_sections.extend(guidance_info)
        
        prompt_sections.extend(artifacts_section)
        prompt_sections.extend(supplement_section) 
        prompt_sections.extend(history_section)
        prompt_sections.extend(commands_section)
        prompt_sections.extend(requirements_section)
        prompt_sections.extend(output_section)
        
        return "\n".join(prompt_sections)

    def _parse_analysis_result(self, result: str) -> Dict[str, Any]:
        """Parse the analysis result from LLM response with improved error handling."""
        
        # Try to extract JSON from markdown code blocks first
        json_patterns = [
            r'```json\s*(\{.*?\})\s*```',  # Standard JSON code block
            r'```\s*(\{.*?\})\s*```',      # Code block without json label
            r'(\{[^{}]*"analysis"[^{}]*\})',  # JSON with analysis field
        ]
        
        for pattern in json_patterns:
            json_match = re.search(pattern, result, re.DOTALL)
            if json_match:
                try:
                    parsed = json.loads(json_match.group(1))
                    return self._validate_and_format_result(parsed)
                except json.JSONDecodeError:
                    continue
        
        # Try to parse the entire result as JSON
        try:
            parsed = json.loads(result.strip())
            return self._validate_and_format_result(parsed)
        except json.JSONDecodeError:
            pass
        
        # Final fallback: extract information using regex patterns
        analysis_match = re.search(r'"analysis":\s*"([^"]*)"', result, re.DOTALL)
        recommendations_match = re.search(r'"recommendations":\s*\[(.*?)\]', result, re.DOTALL)
        summary_match = re.search(r'"summary":\s*"([^"]*)"', result, re.DOTALL)
        
        analysis = analysis_match.group(1) if analysis_match else result
        recommendations = []
        if recommendations_match:
            rec_text = recommendations_match.group(1)
            recommendations = re.findall(r'"([^"]*)"', rec_text)
        
        summary = summary_match.group(1) if summary_match else "Analysis completed"
        
        return {
            "analysis": analysis,
            "recommendations": recommendations,
            "summary": summary
        }

    def _validate_and_format_result(self, parsed: Dict[str, Any]) -> Dict[str, Any]:
        """Validate and format the parsed result to ensure required fields."""
        return {
            "analysis": str(parsed.get("analysis", "")).strip() or "No analysis provided",
            "recommendations": list(parsed.get("recommendations", [])),
            "summary": str(parsed.get("summary", "")).strip() or "Analysis completed"
        }

    def _extract_candidate_action(self, text: str) -> Optional[Dict[str, Any]]:
        """Try to extract a CandidateAction JSON block from the LLM output."""
        try:
            # Pattern 1: explicit CandidateAction: { ... }
            m = re.search(r"CandidateAction\s*:\s*(\{.*?\})", text, re.DOTALL)
            if m:
                return json.loads(m.group(1))

            # Pattern 2: fenced json with a top-level object having type/selector
            m2 = re.search(r"```json\s*(\{.*?\})\s*```", text, re.DOTALL)
            if m2:
                candidate = json.loads(m2.group(1))
                if isinstance(candidate, dict):
                    return candidate
        except Exception as e:
            logger.debug(f"No CandidateAction found: {e}")
        return None

    def _infer_done_decision(self, text: str) -> Optional[str]:
        """Infer DONE decision from LLM output.
        Supports structured markers and JSON fields to indicate completion.
        Returns 'done' if detected, otherwise None.
        """
        try:
            # Structured markers
            if "DECISION_START" in text and "DECISION_END" in text:
                start = text.find("DECISION_START") + len("DECISION_START")
                end = text.find("DECISION_END")
                if 0 < start < end:
                    content = text[start:end]
                    m = re.search(r"Decision:\s*(DONE)", content, re.IGNORECASE)
                    if m:
                        return "done"
            # JSON fields
            try:
                parsed = json.loads(text)
                decision = str(parsed.get("decision", "")).strip().lower()
                outcome = str(parsed.get("outcome", "")).strip().upper()
                if decision == "done" or outcome == "WORKER_DONE":
                    return "done"
            except Exception:
                pass
        except Exception:
            pass
        return None

    def _extract_done_message(self, text: str) -> str:
        """Extract a message explaining DONE decision, best-effort."""
        try:
            if "DECISION_START" in text and "DECISION_END" in text:
                start = text.find("DECISION_START") + len("DECISION_START")
                end = text.find("DECISION_END")
                if 0 < start < end:
                    content = text[start:end]
                    m = re.search(r"Message:\s*(.+)", content, re.IGNORECASE | re.DOTALL)
                    if m:
                        import re as _re
                        msg = m.group(1).strip()
                        msg = _re.sub(r'\s+', ' ', msg)
                        return msg
            # JSON fields
            try:
                parsed = json.loads(text)
                msg = str(parsed.get("message", "")).strip()
                if msg:
                    return msg
            except Exception:
                pass
        except Exception:
            pass
        return "Analysis indicates the subtask is complete."