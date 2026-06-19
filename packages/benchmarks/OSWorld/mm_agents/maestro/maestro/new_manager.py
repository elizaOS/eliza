"""
New Manager Module for GUI-Agent Architecture
Responsible for task planning, decomposition, and resource allocation
"""

import logging
import time
from datetime import datetime
from typing import Dict, Any, Union

from ..tools.new_tools import NewTools
from ..core.new_knowledge import NewKnowledgeBase

from .new_global_state import NewGlobalState
from .enums import ManagerStatus
from .manager.plan import PlanningHandler, PlanningScenario, PlanningResult
from .manager.supplement import SupplementHandler

logger = logging.getLogger(__name__)


class NewManager:
    """
    Enhanced Manager module for GUI-Agent architecture
    Responsible for task planning, decomposition, and resource allocation

    Note: Planning prompts include generic guidance for configuration persistence (prefer editing config files; GUI changes require Save/Exit) and role assignment (Technician vs Operator). See planning_helpers.generate_planning_prompt.
    """

    def __init__(
        self,
        tools_dict: Dict[str, Any],
        global_state: NewGlobalState,
        local_kb_path: str = "",
        platform: str = "Windows",
        enable_search: bool = False,
        enable_narrative: bool = False,
        max_replan_attempts: int = 3,
    ):
        """
        Initialize the Manager module
        
        Args:
            tools_dict: Dictionary containing tool configurations
            global_state: Global state instance
            local_kb_path: Path to local knowledge base
            platform: Target platform (Windows/Darwin/Ubuntu)
            enable_search: Whether to enable web search
            max_replan_attempts: Maximum replanning attempts
        """
        self.tools_dict = tools_dict
        self.global_state = global_state
        self.local_kb_path = local_kb_path
        self.platform = platform
        self.enable_search = enable_search
        self.enable_narrative = enable_narrative
        self.max_replan_attempts = max_replan_attempts

        # Initialize status
        self.status = ManagerStatus.IDLE
        self.plan_scenario = PlanningScenario.REPLAN

        # Initialize tools
        self._initialize_tools()

        # Initialize knowledge base
        self._initialize_knowledge_base()

        # Initialize handlers
        self._initialize_handlers()

        logger.info("NewManager initialized successfully")

    def _initialize_tools(self):
        """Initialize required tools with backward-compatible keys"""
        self.planner_agent_name = "planner_role"
        self.supplement_agent_name = "supplement_role"
        self.dag_translator_agent_name = "dag_translator"

        # planner_agent
        self.planner_agent = NewTools()
        self.planner_agent.register_tool(
            self.planner_agent_name,
            self.tools_dict[self.planner_agent_name]["provider"],
            self.tools_dict[self.planner_agent_name]["model"],
        )

        # dag_translator_agent
        self.dag_translator_agent = NewTools()
        self.dag_translator_agent.register_tool(
            self.dag_translator_agent_name,
            self.tools_dict[self.dag_translator_agent_name]["provider"],
            self.tools_dict[self.dag_translator_agent_name]["model"],
        )

        # supplement_agent
        self.supplement_agent = NewTools()
        self.supplement_agent.register_tool(
            self.supplement_agent_name,
            self.tools_dict[self.supplement_agent_name]["provider"],
            self.tools_dict[self.supplement_agent_name]["model"]
        )

        # objective_alignment agent
        self.objective_alignment_agent = None
        if self.tools_dict.get("objective_alignment"):
            try:
                self.objective_alignment_agent = NewTools()
                self.objective_alignment_agent.register_tool(
                    "objective_alignment",
                    self.tools_dict["objective_alignment"]["provider"],
                    self.tools_dict["objective_alignment"]["model"],
                )
            except Exception:
                self.objective_alignment_agent = None

        # Embedding engine for Memory
        self.embedding_engine = NewTools()
        self.embedding_engine.register_tool(
            "embedding",
            self.tools_dict["embedding"]["provider"],
            self.tools_dict["embedding"]["model"],
        )

        # Web search engine (optional)
        if self.enable_search and self.tools_dict.get("websearch"):
            self.search_engine = NewTools()
            self.search_engine.register_tool(
                "websearch",
                self.tools_dict["websearch"]["provider"],
                self.tools_dict["websearch"]["model"],
            )
        else:
            self.search_engine = None

    def _initialize_knowledge_base(self):
        """Initialize knowledge base for RAG operations"""
        kb_tools_dict = {
            "query_formulator": self.tools_dict.get("query_formulator", {}),
            "context_fusion": self.tools_dict.get("context_fusion", {}),
            "narrative_summarization": self.tools_dict.get("narrative_summarization", {}),
            "episode_summarization": self.tools_dict.get("episode_summarization", {}),
        }

        self.knowledge_base = NewKnowledgeBase(
            embedding_engine=self.embedding_engine,
            local_kb_path=self.local_kb_path,
            platform=self.platform,
            Tools_dict=kb_tools_dict,
        )

    def _initialize_handlers(self):
        """Initialize the planning and supplement handlers"""
        self.planning_handler = PlanningHandler(
            global_state=self.global_state,
            planner_agent=self.planner_agent,
            dag_translator_agent=self.dag_translator_agent,
            knowledge_base=self.knowledge_base,
            search_engine=self.search_engine,
            platform=self.platform,
            enable_search=self.enable_search,
            enable_narrative=self.enable_narrative,
            objective_alignment_agent=self.objective_alignment_agent,
        )
        
        self.supplement_handler = SupplementHandler(
            global_state=self.global_state,
            supplement_agent=self.supplement_agent,
            search_engine=self.search_engine,
            knowledge_base=self.knowledge_base,
            enable_search=self.tools_dict[self.supplement_agent_name]["enable_search"],
        )

    def plan_task(self, scenario: Union[PlanningScenario, str]) -> PlanningResult:
        """
        Execute task planning based on scenario and current trigger_code
        
        Args:
            scenario: Planning scenario (INITIAL_PLAN|REPLAN|SUPPLEMENT or enum)
            
        Returns:
            PlanningResult: Planning result with subtasks or supplement
        """
        try:
            scenario_enum = self._normalize_scenario(scenario)
            self.status = ManagerStatus.PLANNING
            
            # Get current trigger_code to determine specific planning strategy
            current_trigger_code = self._get_current_trigger_code()
            
            self.global_state.log_operation("manager", "planning_start", {
                "scenario": scenario_enum.value,
                "trigger_code": current_trigger_code,
                "timestamp": time.time()
            })

            if scenario_enum == PlanningScenario.SUPPLEMENT:
                return self._handle_supplement_scenario()
            else:
                return self._handle_planning_scenario(scenario_enum, current_trigger_code)

        except Exception as e:
            logger.error(f"Planning failed: {e}")
            self.status = ManagerStatus.ERROR
            self.global_state.log_operation("manager", "planning_error", {
                "error": str(e),
                "timestamp": time.time()
            })

            return PlanningResult(
                success=False,
                scenario=self._normalize_scenario(scenario).value if isinstance(
                    scenario, str) else scenario.value,
                subtasks=[],
                supplement="",
                reason=f"Planning failed: {str(e)}",
                created_at=datetime.now().isoformat())
        finally:
            self.status = ManagerStatus.IDLE

    def _normalize_scenario(
            self, scenario: Union[PlanningScenario, str]) -> PlanningScenario:
        """Normalize string/enum scenario to PlanningScenario enum (case-insensitive)."""
        if isinstance(scenario, PlanningScenario):
            return scenario
        s = str(scenario).strip().lower()
        if s in {"replan", "re-plan"}:
            return PlanningScenario.REPLAN
        if s in {"supplement", "supp"}:
            return PlanningScenario.SUPPLEMENT
        # Default to INITIAL_PLAN if unknown
        return PlanningScenario.REPLAN

    def _handle_planning_scenario(self, scenario: PlanningScenario, trigger_code: str = "controller") -> PlanningResult:
        """Handle planning scenarios (INITIAL_PLAN/REPLAN) with specific trigger_code context"""
        return self.planning_handler.handle_planning_scenario(scenario, trigger_code)

    def _handle_supplement_scenario(self) -> PlanningResult:
        """Handle supplement collection scenario"""
        try:
            logger.info("Starting supplement scenario handling")
            result = self.supplement_handler.handle_supplement_scenario()
            
            # Validate result structure
            if not isinstance(result, dict):
                logger.error(f"Invalid supplement result type: {type(result)}")
                return PlanningResult(
                    success=False,
                    scenario="supplement",
                    subtasks=[],
                    supplement="",
                    reason="Invalid supplement result structure",
                    created_at=datetime.now().isoformat()
                )
            
            # Log supplement result
            self.global_state.log_operation("manager", "supplement_completed", {
                "success": result.get("success", False),
                "supplement_length": len(result.get("supplement", "")),
                "timestamp": time.time()
            })
            
            return PlanningResult(**result)
            
        except Exception as e:
            logger.error(f"Supplement scenario handling failed: {e}")
            self.global_state.log_operation("manager", "supplement_error", {
                "error": str(e),
                "timestamp": time.time()
            })
            
            return PlanningResult(
                success=False,
                scenario="supplement",
                subtasks=[],
                supplement="",
                reason=f"Supplement handling failed: {str(e)}",
                created_at=datetime.now().isoformat()
            )

    def get_planning_status(self) -> Dict[str, Any]:
        """Get current planning status"""
        return {
            "status": self.status.value,
            "replan_attempts": self.planning_handler.replan_attempts,
            "supplement_attempts": self.supplement_handler.supplement_attempts,
            "planning_history_count": len(self.planning_handler.planning_history),
            "max_replan_attempts": self.max_replan_attempts,
        }

    def reset_planning_state(self):
        """Reset planning state (useful for new tasks)"""
        self.planning_handler.replan_attempts = 0
        self.supplement_handler.supplement_attempts = 0
        self.planning_handler.planning_history = []
        self.status = ManagerStatus.IDLE

        self.global_state.add_event("manager", "planning_reset", "Planning state reset")

    def can_replan(self) -> bool:
        """Check if replanning is still allowed"""
        return self.planning_handler.replan_attempts < self.max_replan_attempts

    def _get_current_trigger_code(self) -> str:
        """Get current trigger_code"""
        controller_state = self.global_state.get_controller_state()
        return controller_state.get("trigger_code", "")


# Export a friendly alias to match the interface name used elsewhere
Manager = NewManager
