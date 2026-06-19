"""
Supplement module for Manager
Handles supplement collection and processing logic based on trigger_code
"""

import json
import logging
import time
from datetime import datetime
from typing import Dict, Any

from ..enums import TRIGGER_CODE_BY_MODULE
from ..manager.utils import get_supplement_info
from ..new_global_state import NewGlobalState

logger = logging.getLogger(__name__)


class SupplementHandler:
    """Handles supplement collection and processing based on trigger_code"""
    
    def __init__(self, global_state: NewGlobalState, supplement_agent, search_engine, knowledge_base, enable_search):
        self.global_state = global_state
        self.supplement_agent = supplement_agent
        self.search_engine = search_engine
        self.knowledge_base = knowledge_base
        self.supplement_attempts = 0
        self.enable_search = enable_search
    def handle_supplement_scenario(self) -> Dict[str, Any]:
        """Handle supplement collection scenario based on current trigger_code"""
        try:
            self.global_state.log_operation("manager", "supplement_start", {
                "attempt": self.supplement_attempts,
                "timestamp": time.time()
            })
            
            self.supplement_attempts += 1

            # Get supplement context with trigger_code
            context = self._get_supplement_context()
            
            # Get current trigger_code to determine supplement strategy
            current_trigger_code = self._get_current_trigger_code()
            
            # Validate trigger_code
            if not current_trigger_code or current_trigger_code.strip() == "":
                logger.warning("No valid trigger_code found, using default supplement strategy")
                current_trigger_code = "general_supplement"
            
            # Generate supplement prompt based on trigger_code
            prompt = self._generate_supplement_prompt(context, current_trigger_code)
            
            # Execute supplement collection using LLM if available
            if self.supplement_agent:
                try:
                    supplement_result, total_tokens, cost_string = self.supplement_agent.execute_tool(
                        "supplement_role",
                        {"str_input": prompt},
                    )
                    
                    # Log supplement operation with LLM details
                    self.global_state.log_llm_operation(
                        "manager",
                        "supplement_collection",
                        {
                            "attempt": self.supplement_attempts,
                            "trigger_code": current_trigger_code,
                            "tokens": total_tokens,
                            "cost": cost_string
                        },
                        str_input=prompt
                    )
                    
                    # Parse and execute supplement plan
                    collected_data = self._execute_supplement_plan(supplement_result, current_trigger_code)
                except Exception as e:
                    logger.error(f"Supplement agent execution failed: {e}")
                    # Fallback to fallback strategy if LLM fails
                    collected_data = self._fallback_supplement_strategy(context, current_trigger_code)
            else:
                # No supplement tool configured; use fallback strategy
                logger.info("No supplement agent configured, using fallback strategy")
                collected_data = self._fallback_supplement_strategy(context, current_trigger_code)

            # Update supplement content
            self._update_supplement_content(collected_data, current_trigger_code)

            return {
                "success": True,
                "scenario": "supplement",
                "subtasks": [],
                "supplement": collected_data,
                "reason": f"Successfully collected supplement data for trigger_code: {current_trigger_code}",
                "created_at": datetime.now().isoformat()
            }

        except Exception as e:
            logger.error(f"Supplement collection failed: {e}")
            return {
                "success": False,
                "scenario": "supplement",
                "subtasks": [],
                "supplement": "",
                "reason": f"Supplement collection failed: {str(e)}",
                "created_at": datetime.now().isoformat()
            }

    def _get_current_trigger_code(self) -> str:
        """Get current trigger_code"""
        controller_state = self.global_state.get_controller_state()
        trigger_code = controller_state.get("trigger_code", "")
        
        # Validate trigger_code
        if not trigger_code or trigger_code.strip() == "":
            logger.warning("No trigger_code found in controller state")
            return ""
        
        # Check if it's a valid supplement trigger code
        valid_supplement_codes = [
            TRIGGER_CODE_BY_MODULE.MANAGER_SUPPLEMENT_CODES["worker_supplement"],
            TRIGGER_CODE_BY_MODULE.MANAGER_SUPPLEMENT_CODES["quality_check_supplement"]
        ]
        
        if trigger_code not in valid_supplement_codes:
            logger.warning(f"Trigger code '{trigger_code}' is not a recognized supplement code")
            # Still return it for fallback handling
        
        return trigger_code

    def _get_supplement_context(self) -> Dict[str, Any]:
        """Get context information for supplement collection"""
        task = self.global_state.get_task()
        subtasks = self.global_state.get_subtasks()
        supplement = self.global_state.get_supplement()

        # Get current subtask that needs supplement
        current_subtask = None
        supplement_reason = ""
        if task.current_subtask_id:
            current_subtask = self.global_state.get_subtask(task.current_subtask_id)
            # Get the reason for supplement collection from the current command's message field
            if current_subtask:
                current_command = self.global_state.get_current_command_for_subtask(current_subtask.subtask_id)
                if current_command:
                    # Check if the command has a message field that explains why supplement is needed
                    if hasattr(current_command, 'message') and current_command.message:
                        supplement_reason = current_command.message
                    # Fallback to action type if message is not available
                    elif hasattr(current_command, 'action') and current_command.action:
                        action_type = current_command.action.get('type', '')
                        if action_type == 'Supplement':
                            supplement_reason = current_command.action.get('message', 'Worker requested supplement')
                else:
                    supplement_reason = ""
        
        return {
            "task_objective": task.objective or "",
            "current_subtask": current_subtask,
            "all_subtasks": subtasks,
            "existing_supplement": supplement,
            "supplement_attempts": self.supplement_attempts,
            "supplement_reason": supplement_reason
        }

    def _generate_supplement_prompt(self, context: Dict[str, Any], trigger_code: str) -> str:
        """Generate supplement collection prompt based on trigger_code"""
        
        # Get trigger_code specific context
        trigger_context = self._get_trigger_code_specific_context(trigger_code, context)
        
        # Generate trigger_code specific supplement guidance
        trigger_specific_guidance = self._generate_trigger_specific_supplement_guidance(trigger_code, trigger_context, context)

        system_info = f"""
# System Architecture
You are the Manager (task planner) in the GUI-Agent system. The system includes:
- Controller: Central scheduling and process control
- Manager: Task planning and resource allocation (your role)
- Worker: Execute specific operations (Operator/Analyst/Technician)
- Evaluator: Quality inspection
- Hardware: Low-level execution

# Current Supplement Task
During execution, necessary information was found to be missing. You need to collect supplementary materials based on the specific trigger_code: {trigger_code}

# Collection Tools
- Web Search: Search for latest information from the internet (primary tool)
- RAG Retrieval: Retrieve relevant documents from knowledge base (if needed)

# Collection Strategy
1. Clearly identify the type and importance of required information based on trigger_code
2. Choose appropriate search queries for web search
3. Verify and organize collected information
4. Update supplement.md file

{trigger_specific_guidance}

# Output Format
You must output the following JSON format:
{{
  "needed_info": "Detailed description of required information based on trigger_code",
  "search_queries": ["search query1", "search query2", "search query3"],
  "priority_keywords": ["keyword1", "keyword2"],
  "expected_outcome": "What we expect to achieve with this supplement"
}}
"""

        supplement_prompt = f"""
{system_info}

# Missing Information Situation
Task Objective: {context.get('task_objective', '')}
Current Subtask: {context.get('current_subtask', {})}
Existing Supplement: {context.get('existing_supplement', '')}
Supplement Attempts: {context.get('supplement_attempts', 0)}
Trigger Code: {trigger_code}
Supplement Reason: {context.get('supplement_reason', '')}

Please output the supplementary material collection solution based on the trigger_code and execute it:
"""

        return supplement_prompt

    def _get_trigger_code_specific_context(self, trigger_code: str, context: Dict[str, Any]) -> Dict[str, Any]:
        """Get trigger_code specific context information"""
        trigger_context = {}
        
        if trigger_code == TRIGGER_CODE_BY_MODULE.MANAGER_SUPPLEMENT_CODES["worker_supplement"]:
            # Worker needs supplementary information situation
            trigger_context = {
                "type": "worker_supplement",
                "description": "Worker reported that supplementary information is needed to proceed",
                "focus": "Need to understand what specific information the worker needs and collect it"
            }
            # Get current subtask information
            if context.get("current_subtask"):
                trigger_context["current_subtask"] = context["current_subtask"]
                
        elif trigger_code == TRIGGER_CODE_BY_MODULE.MANAGER_SUPPLEMENT_CODES["quality_check_supplement"]:
            # Quality check needs supplementary information situation
            trigger_context = {
                "type": "quality_check_supplement",
                "description": "Quality check requires supplementary information to proceed",
                "focus": "Need to collect information that will help pass the quality check"
            }
            # Get quality check failure information
            trigger_context["quality_check_context"] = self._get_quality_check_context() #type: ignore
            
        else:
            # Default situation
            trigger_context = {
                "type": "general_supplement",
                "description": f"General supplement collection triggered by: {trigger_code}",
                "focus": "Analyze the current situation and collect relevant supplementary information"
            }
            
        return trigger_context

    def _get_quality_check_context(self) -> Dict[str, Any]:
        """Get quality check context for supplement"""
        try:
            # Get latest quality check information
            task = self.global_state.get_task()
            if task.current_subtask_id:
                latest_gate = self.global_state.get_latest_gate_check_for_subtask(task.current_subtask_id)
                if latest_gate:
                    return {
                        "gate_decision": latest_gate.decision,
                        "gate_notes": latest_gate.notes,
                        "gate_trigger": latest_gate.trigger
                    }
        except Exception as e:
            logger.warning(f"Failed to get quality check context: {e}")
        
        return {}

    def _generate_trigger_specific_supplement_guidance(self, trigger_code: str, trigger_context: Dict[str, Any], 
                                                     context: Dict[str, Any]) -> str:
        """Generate trigger_code specific supplement guidance"""
        
        if trigger_code == TRIGGER_CODE_BY_MODULE.MANAGER_SUPPLEMENT_CODES["worker_supplement"]:
            current_subtask = context.get("current_subtask", {})
            return f"""
# Worker Supplement - Specific Guidance
- The Worker reported that supplementary information is needed to proceed
- Current subtask: {current_subtask.get('title', 'Unknown')}
- Focus on collecting information that will help the worker complete this specific subtask
- Consider what technical details, examples, or context the worker might need
- Prioritize practical, actionable information over general knowledge
- Use web search to find current, up-to-date information relevant to the subtask
"""
            
        elif trigger_code == TRIGGER_CODE_BY_MODULE.MANAGER_SUPPLEMENT_CODES["quality_check_supplement"]:
            quality_context = trigger_context.get("quality_check_context", {})
            return f"""
# Quality Check Supplement - Specific Guidance
- Quality check requires supplementary information to proceed
- Gate decision: {quality_context.get('gate_decision', 'Unknown')}
- Gate notes: {quality_context.get('gate_notes', 'No notes available')}
- Focus on collecting information that addresses the specific quality criteria that failed
- Look for examples, standards, or best practices that can help meet quality requirements
- Use web search to find authoritative sources and current standards
- Consider what additional context would help the evaluator make a positive decision
"""
            
        else:
            return f"""
# General Supplement - Specific Guidance
- General supplement collection triggered by: {trigger_code}
- Analyze the current situation and identify what information is missing
- Focus on practical, relevant information that will help move the task forward
- Use web search to find current, authoritative information
- Consider what context or examples would be most helpful
"""

    def _execute_supplement_plan(self, supplement_result: str, trigger_code: str) -> str:
        """Execute supplement collection plan based on LLM output"""
        try:
            # Parse LLM output
            plan_data = json.loads(supplement_result)
            
            # Extract search queries
            search_queries = plan_data.get("search_queries", [])
            needed_info = plan_data.get("needed_info", "")
            expected_outcome = plan_data.get("expected_outcome", "")
            
            # Validate search queries
            if not search_queries or not isinstance(search_queries, list):
                logger.warning("Invalid search queries from LLM, using fallback")
                return self._fallback_supplement_strategy({}, trigger_code)
            
            # Execute web search for each query
            collected_data = []
            
            if search_queries and self.search_engine:
                for query in search_queries:
                    try:
                        logger.info(f"Executing web search for query: {query}")
                        search_result, _, _ = self.search_engine.execute_tool("websearch", {"query": query})
                        if search_result:
                            collected_data.append(f"Web Search Result for '{query}':\n{search_result}")
                        else:
                            collected_data.append(f"Web Search returned no results for '{query}'")
                    except Exception as e:
                        logger.warning(f"Web search failed for query '{query}': {e}")
                        collected_data.append(f"Web Search Failed for '{query}': {str(e)}")
            else:
                if not search_queries:
                    collected_data.append("No search queries provided by LLM")
                if not self.search_engine:
                    collected_data.append("Search engine not available")
            
            # Combine collected data with context
            combined_data = f"""
# Supplement Collection Results
Trigger Code: {trigger_code}
Needed Information: {needed_info}
Expected Outcome: {expected_outcome}

## Collected Data:
{chr(10).join(collected_data) if collected_data else "No data collected"}

## Summary:
This supplement was collected to address the specific needs identified by trigger_code: {trigger_code}
"""
            
            return combined_data
            
        except json.JSONDecodeError as e:
            logger.warning(f"Failed to parse supplement result: {e}")
            logger.warning(f"Raw supplement result: {supplement_result[:200]}...")  # Log first 200 chars
            return self._fallback_supplement_strategy({}, trigger_code)
        except Exception as e:
            logger.error(f"Unexpected error in supplement plan execution: {e}")
            return self._fallback_supplement_strategy({}, trigger_code)

    def _fallback_supplement_strategy(self, context: Dict[str, Any], trigger_code: str) -> str:
        """Fallback supplement strategy when LLM is unavailable"""
        objective = context.get("task_objective", "").strip()

        # Fix: Ensure search_queries is a list, not a string
        if objective:
            search_queries = [objective]  # Convert string to list
        else:
            search_queries = ["supplement information", "task details"]  # Default queries
        
        # Execute fallback web search
        collected_data = []
        if self.search_engine:
            for query in search_queries:
                try:
                    search_result, _, _ = self.search_engine.execute_tool("websearch", {"query": query})
                    if search_result:
                        collected_data.append(f"Fallback Web Search Result for '{query}':\n{search_result}")
                except Exception as e:
                    logger.warning(f"Fallback web search failed for query '{query}': {e}")
        else:
            collected_data.append("Search engine not available for fallback strategy")
        
        combined_data = f"""
# Fallback Supplement Collection
Trigger Code: {trigger_code}
Strategy: Automatic fallback due to LLM unavailability

## Search Queries Used:
{chr(10).join(f"- {q}" for q in search_queries)}

## Collected Data:
{chr(10).join(collected_data) if collected_data else "No data collected in fallback mode"}
"""
        
        return combined_data

    def _update_supplement_content(self, collected_data: str, trigger_code: str):
        """Update supplement content in global state"""
        current_supplement = self.global_state.get_supplement()

        # Add new supplement entry
        entry_id = f"supplement-{int(time.time() * 1000)}"
        timestamp = datetime.now().isoformat()

        new_entry = f"""
## Supplement Entry - {entry_id}
- **Created**: {timestamp}
- **Type**: Collected Information
- **Trigger Code**: {trigger_code}
- **Content**: {collected_data}
- **Status**: Collected

---
"""

        updated_content = current_supplement + new_entry
        self.global_state.set_supplement(updated_content)
        
        # Also add to events for tracking
        self.global_state.add_event("manager", "supplement_added", 
                                  f"Added supplement artifact {entry_id} for trigger_code {trigger_code}")
