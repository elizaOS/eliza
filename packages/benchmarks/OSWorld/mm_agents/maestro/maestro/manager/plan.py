"""
Planning module for Manager
Handles task planning, DAG generation, and context building
"""

import json
import logging
import time
from datetime import datetime
from typing import Dict, List, Optional, Any
from enum import Enum
from dataclasses import dataclass
import re

from ...utils.common_utils import Node
from ..data_models import SubtaskData
from ..manager.utils import (
    enhance_subtasks, generate_dag, topological_sort
)
from .planning_helpers import (
    get_planning_context, generate_planning_prompt
)

logger = logging.getLogger(__name__)


class PlanningScenario(str, Enum):
    """Planning scenario types"""
    REPLAN = "replan"
    SUPPLEMENT = "supplement"


@dataclass
class PlanningResult:
    """Planning result data structure"""
    success: bool
    scenario: str
    subtasks: List[Dict]
    supplement: str
    reason: str
    created_at: str


class PlanningHandler:
    """Handles task planning and DAG generation"""
    
    def __init__(self, global_state, planner_agent, dag_translator_agent, 
                 knowledge_base, search_engine, platform, enable_search, enable_narrative,
                 objective_alignment_agent=None):
        self.global_state = global_state
        self.planner_agent = planner_agent
        self.dag_translator_agent = dag_translator_agent
        self.knowledge_base = knowledge_base
        self.search_engine = search_engine
        self.platform = platform
        self.enable_search = enable_search
        self.enable_narrative = enable_narrative
        self.objective_alignment_agent = objective_alignment_agent
        self.planning_history = []
        self.replan_attempts = 0
    
    def handle_planning_scenario(self, scenario: PlanningScenario, trigger_code: str = "controller") -> PlanningResult:
        """Handle planning scenarios (INITIAL_PLAN/REPLAN) with specific trigger_code context"""
        # Get planning context with trigger_code
        context = get_planning_context(
            self.global_state, 
            self.platform, 
            self.replan_attempts, 
            self.planning_history, 
            trigger_code
        )

        # Step 0: Align/Rewrite objective using current screenshot if tool is available
        try:
            if self.objective_alignment_agent is not None:
                raw_objective = context.get("task_objective", "")
                screenshot = context.get("screenshot")
                recent_subtasks_history = context.get("recent_subtasks_history")
                # Construct complete alignment prompt with objective and recent history
                alignment_prompt = "Original objective: " + raw_objective
                if recent_subtasks_history:
                    alignment_prompt += "\n\nRecent subtasks history: " + str(recent_subtasks_history)
                
                if isinstance(raw_objective, str) and raw_objective.strip():
                    aligned_text, a_tokens, a_cost = self.objective_alignment_agent.execute_tool(
                        "objective_alignment",
                        {"str_input": alignment_prompt, "img_input": screenshot}
                    )
                    logger.info(f"Alignment Done.")
                    # Update context for downstream prompt generation
                    if isinstance(aligned_text, str) and aligned_text.strip() and not aligned_text.startswith("Error:"):
                        context["objective_alignment_raw"] = aligned_text
                        # Try parse JSON to extract final objective text and assumptions (robust against ```json ... ``` and extra text)
                        refined_obj = None
                        assumptions = None
                        constraints_from_screen = None
                        try:
                            import json as _json
                            _text = aligned_text.strip()
                            # Strip markdown fences if present
                            if _text.startswith("```"):
                                # Remove opening fence line (e.g., ```json or ```)
                                nl = _text.find("\n")
                                if nl != -1:
                                    _candidate = _text[nl + 1 :]
                                else:
                                    _candidate = _text
                                # Remove closing fence ``` if present
                                if _candidate.rstrip().endswith("```"):
                                    _candidate = _candidate.rstrip()[:-3]
                                _text = _candidate.strip()
                            # If still fails, extract JSON object substring by braces
                            _parsed = None
                            try:
                                _parsed = _json.loads(_text)
                            except Exception:
                                lb = _text.find("{")
                                rb = _text.rfind("}")
                                if lb != -1 and rb != -1 and rb > lb:
                                    _maybe = _text[lb: rb + 1]
                                    try:
                                        _parsed = _json.loads(_maybe)
                                    except Exception:
                                        _parsed = None
                            if isinstance(_parsed, dict):
                                # Extract all relevant fields from the parsed JSON
                                refined_obj = _parsed.get("rewritten_final_objective_text")
                                assumptions = _parsed.get("assumptions")
                                constraints_from_screen = _parsed.get("constraints_from_screen")
                        except Exception:
                            refined_obj = None
                            assumptions = None
                            constraints_from_screen = None
                        
                        if isinstance(refined_obj, str) and refined_obj.strip():
                            context["objective_alignment"] = refined_obj
                            context["task_objective"] = refined_obj
                        else:
                            # Fallback: use full aligned_text as objective
                            context["objective_alignment"] = aligned_text
                            context["task_objective"] = aligned_text
                        
                        # Store assumptions and constraints for planning
                        # if assumptions is not None:
                        #     context["objective_assumptions"] = assumptions
                        # if constraints_from_screen is not None:
                        #     context["objective_constraints"] = constraints_from_screen
                        # Log the alignment action
                        self.global_state.log_llm_operation(
                            "manager", "objective_alignment", {
                                "tokens": a_tokens,
                                "cost": a_cost,
                                "llm_output": aligned_text,
                            },
                            str_input=raw_objective
                        )
        except Exception as e:
            logger.warning(f"Objective alignment step failed: {e}")

        
        # Retrieve external knowledge (web + narrative) and optionally fuse
        integrated_knowledge = self._retrieve_and_fuse_knowledge(context)
        logger.info(f"Knowledge integrated.")

        # Generate planning prompt (with integrated knowledge if any) based on trigger_code
        # Includes generic configuration persistence and role assignment guidance (see planning_helpers.generate_planning_prompt)
        assumptions = context.get("objective_assumptions")
        # constraints_from_screen = context.get("objective_constraints")
        prompt = generate_planning_prompt(
            context, 
            integrated_knowledge=integrated_knowledge, 
            trigger_code=trigger_code,
            assumptions=assumptions, # type: ignore
            # constraints_from_screen=constraints_from_screen
        )

        # Execute planning using the registered planner tool
        plan_result, total_tokens, cost_string = self.planner_agent.execute_tool(
            "planner_role", {
                "str_input": prompt,
                "img_input": context.get("screenshot")
            }
        )
        logger.info(f"Planner Executed.")

        # Parse manager completion flag from planner output and strip the flag line
        manager_complete_flag = True
        try:
            match = re.search(r"^\s*MANAGER_COMPLETE:\s*(true|false)\s*$", str(plan_result), re.IGNORECASE | re.MULTILINE)
            if match:
                manager_complete_flag = match.group(1).lower() == "true"
                # Remove the flag line from plan_result to avoid polluting downstream DAG translation
                plan_result = re.sub(r"^\s*MANAGER_COMPLETE:\s*(true|false)\s*$", "", str(plan_result), flags=re.IGNORECASE | re.MULTILINE).strip()
        except Exception:
            manager_complete_flag = True

        # Log planning operation (reflect initial vs replan based on attempts)
        scenario_label = context.get("planning_scenario", scenario.value)
        self.global_state.log_llm_operation(
            "manager", "task_planning", {
                "scenario": scenario_label,
                "trigger_code": trigger_code,
                "plan_result": plan_result,
                "tokens": total_tokens,
                "cost": cost_string
            },
            str_input=prompt,
            # img_input=context.get("screenshot")
        )

        # After planning, also generate DAG and action queue
        dag_info, dag_obj = generate_dag(self.dag_translator_agent, self.global_state, context.get("task_objective", ""), plan_result)
        
        # Add DAG retry mechanism
        max_dag_retries = 3
        dag_retry_count = 0
        action_queue: List[Node] = []
        
        while dag_retry_count < max_dag_retries:
            try:
                action_queue = topological_sort(dag_obj)
                # Validate if sorting result is reasonable
                if len(action_queue) == len(dag_obj.nodes):
                    logger.info(f"DAG topological sort successful on attempt {dag_retry_count + 1}")
                    break
                else:
                    raise ValueError(f"Topological sort result length mismatch: expected {len(dag_obj.nodes)}, got {len(action_queue)}")
            except Exception as e:
                dag_retry_count += 1
                logger.warning(f"DAG topological sort failed on attempt {dag_retry_count}: {e}")
                
                if dag_retry_count < max_dag_retries:
                    # Regenerate DAG
                    logger.info(f"Regenerating DAG (attempt {dag_retry_count + 1}/{max_dag_retries})")
                    dag_info, dag_obj = generate_dag(self.dag_translator_agent, self.global_state, context.get("task_objective", ""), plan_result)
                else:
                    # Last attempt failed, use original node order
                    logger.error(f"All DAG retries failed, using original node order")
                    action_queue = dag_obj.nodes
                    self.global_state.add_event("manager", "dag_retry_failed", f"Used original node order after {max_dag_retries} failed attempts")

        # Parse planning result
        try:
            # Validate and enhance subtasks
            enhanced_subtasks = enhance_subtasks(action_queue, self.global_state.task_id)

            # Determine if we are in re-plan phase based on attempts
            is_replan_now = context.get("planning_scenario") == "replan"
            first_new_subtask_id: Optional[str] = None

            if is_replan_now:
                # Remove all not-yet-completed (pending) subtasks
                task = self.global_state.get_task()
                old_pending_ids = list(task.pending_subtask_ids or [])
                if old_pending_ids:
                    self.global_state.delete_subtasks(old_pending_ids)

                # Append new subtasks and capture the first new subtask id
                for i, subtask_dict in enumerate(enhanced_subtasks):
                    subtask_data = SubtaskData(
                        subtask_id=subtask_dict["subtask_id"],
                        task_id=subtask_dict["task_id"],
                        title=subtask_dict["title"],
                        description=subtask_dict["description"],
                        assignee_role=subtask_dict["assignee_role"],
                        status=subtask_dict["status"],
                        attempt_no=subtask_dict["attempt_no"],
                        reasons_history=subtask_dict["reasons_history"],
                        command_trace_ids=subtask_dict["command_trace_ids"],
                        gate_check_ids=subtask_dict["gate_check_ids"],
                        last_reason_text=subtask_dict["last_reason_text"],
                        last_gate_decision=subtask_dict["last_gate_decision"],
                        created_at=subtask_dict["created_at"],
                        updated_at=subtask_dict["updated_at"],
                    )
                    new_id = self.global_state.add_subtask(subtask_data)
                    if first_new_subtask_id is None:
                        first_new_subtask_id = new_id
                # Update managerComplete after adding subtasks
                try:
                    self.global_state.set_manager_complete(manager_complete_flag)
                except Exception:
                    logger.warning("Failed to update managerComplete flag in global state during replan")
            else:
                # Initial planning: append new subtasks; set current only if not set
                for subtask_dict in enhanced_subtasks:
                    subtask_data = SubtaskData(
                        subtask_id=subtask_dict["subtask_id"],
                        task_id=subtask_dict["task_id"],
                        title=subtask_dict["title"],
                        description=subtask_dict["description"],
                        assignee_role=subtask_dict["assignee_role"],
                        status=subtask_dict["status"],
                        attempt_no=subtask_dict["attempt_no"],
                        reasons_history=subtask_dict["reasons_history"],
                        command_trace_ids=subtask_dict["command_trace_ids"],
                        gate_check_ids=subtask_dict["gate_check_ids"],
                        last_reason_text=subtask_dict["last_reason_text"],
                        last_gate_decision=subtask_dict["last_gate_decision"],
                        created_at=subtask_dict["created_at"],
                        updated_at=subtask_dict["updated_at"],
                    )
                    self.global_state.add_subtask(subtask_data)
                # Update managerComplete after adding subtasks
                try:
                    self.global_state.set_manager_complete(manager_complete_flag)
                except Exception:
                    logger.warning("Failed to update managerComplete flag in global state during initial planning")

            # Update planning history
            self.planning_history.append({
                "scenario": scenario_label,
                "trigger_code": trigger_code,
                "subtasks": enhanced_subtasks,
                "dag": dag_info.get("dag", ""),
                "action_queue_len": len(action_queue),
                "timestamp": datetime.now().isoformat(),
                "tokens": total_tokens,
                "cost": cost_string
            })

            # Bump attempts after any successful planning to distinguish initial vs replan next time
            self.replan_attempts += 1

            return PlanningResult(
                success=True,
                scenario=scenario_label,
                subtasks=enhanced_subtasks,
                supplement="",
                reason=f"Successfully planned {len(enhanced_subtasks)} subtasks with trigger_code: {trigger_code}",
                created_at=datetime.now().isoformat()
            )

        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse planning result: {e}")
            return PlanningResult(
                success=False,
                scenario=scenario_label,
                subtasks=[],
                supplement="",
                reason=f"Failed to parse planning result: {str(e)}",
                created_at=datetime.now().isoformat()
            )

    def _retrieve_and_fuse_knowledge(self, context: Dict[str, Any]) -> str:
        """Retrieve external knowledge (web + narrative) and optionally fuse"""
        integrated_knowledge = ""
        web_knowledge = None
        most_similar_task = ""
        retrieved_experience = None

        try:
            objective = context.get("task_objective", "")
            observation = {"screenshot": context.get("screenshot")}

            search_query = None
            if self.enable_search and self.search_engine:
                try:
                    # 1) formulate_query
                    formulate_start = time.time()
                    search_query, f_tokens, f_cost = self.knowledge_base.formulate_query(
                        objective, observation)
                    formulate_duration = time.time() - formulate_start
                    self.global_state.log_operation(
                        "manager", "formulate_query", {
                            "tokens": f_tokens,
                            "cost": f_cost,
                            "query": search_query,
                            "duration": formulate_duration
                        })
                    # 2) websearch directly using search_engine
                    if search_query:
                        web_knowledge, ws_tokens, ws_cost = self.search_engine.execute_tool(
                            "websearch", {"query": search_query})
                        # Not all tools return token/cost; guard format
                        self.global_state.log_llm_operation(
                            "manager", "web_knowledge", {
                                "query": search_query,
                                "tokens": ws_tokens,
                                "cost": ws_cost
                            },
                            str_input=search_query
                        )
                except Exception as e:
                    logger.warning(f"Web search retrieval failed: {e}")

            if self.enable_narrative:
                try:
                    most_similar_task, retrieved_experience, n_tokens, n_cost = (
                        self.knowledge_base.retrieve_narrative_experience(
                            objective))
                    self.global_state.log_llm_operation(
                        "manager", "retrieve_narrative_experience", {
                            "tokens": n_tokens,
                            "cost": n_cost,
                            "task": most_similar_task
                        },
                        str_input=objective
                    )
                except Exception as e:
                    logger.warning(f"Narrative retrieval failed: {e}")

            # 3) Conditional knowledge fusion
            try:
                do_fusion_web = web_knowledge is not None and str(
                    web_knowledge).strip() != ""
                do_fusion_narr = retrieved_experience is not None and str(
                    retrieved_experience).strip() != ""
                if do_fusion_web or do_fusion_narr:
                    web_text = web_knowledge if do_fusion_web else None
                    similar_task = most_similar_task if do_fusion_narr else ""
                    exp_text = retrieved_experience if do_fusion_narr else ""
                    integrated_knowledge, k_tokens, k_cost = self.knowledge_base.knowledge_fusion(
                        observation=observation,
                        instruction=objective,
                        web_knowledge=web_text,
                        similar_task=similar_task,
                        experience=exp_text,
                    )
                    self.global_state.log_llm_operation("manager",
                                                    "knowledge_fusion", {
                                                        "tokens": k_tokens,
                                                        "cost": k_cost
                                                    },
                                                    str_input=f"Objective: {objective}, Web: {web_text}, Experience: {exp_text}")
            except Exception as e:
                logger.warning(f"Knowledge fusion failed: {e}")

        except Exception as e:
            logger.warning(f"Knowledge retrieval pipeline failed: {e}")

        return integrated_knowledge