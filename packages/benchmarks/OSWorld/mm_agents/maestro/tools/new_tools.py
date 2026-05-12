"""
Tools module for GUI agents.

This module provides various tools for GUI agents to perform tasks such as web search,
context fusion, subtask planning, trajectory reflection, memory retrieval, grounding,
evaluation, and action generation.
"""

import os
import json
import base64
import requests
import time
from typing import Dict, Any, Optional, List, Union, Tuple
from abc import ABC, abstractmethod
import logging
from ..core.mllm import LLMAgent, WebSearchAgent, EmbeddingAgent
import threading
from ..prompts import get_prompt, module

logger = logging.getLogger("desktopenv.tools")

class BaseTool(ABC):
    """Base class for all tools."""
    _prompts_dict = None
    _prompts_dict_lock = threading.Lock()
    # Directory retained for backward compatibility; no longer scanned directly
    _prompts_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "prompts")

    @classmethod
    def _load_prompts_dict(cls):
        # Deprecated: kept for compatibility if other code accesses _prompts_dict.
        # Now pull prompts via the registry to avoid direct filesystem coupling.
        if cls._prompts_dict is None:
            with cls._prompts_dict_lock:
                if cls._prompts_dict is None:
                    cls._prompts_dict = {}

    def __init__(self, provider: str, model_name: str, tool_name: str):
        """
        Initialize the base tool.
        Args:
            provider: API provider name (e.g., "gemini", "openai")
            model_name: Model name to use (e.g., "gemini-2.5-pro")
            tool_name: Name of the tool (used as key in prompts files)
        """
        self.provider = provider
        self.model_name = model_name
        self.tool_name = tool_name
        self._load_prompts_dict()
        self._prompt_template = self._get_prompt_template()
        # Create LLMAgent instance for tool usage
        self.engine_params = {
            "engine_type": provider,
            "model": model_name
        }
        self.llm_agent = LLMAgent(engine_params=self.engine_params, system_prompt=self._prompt_template)

    def _get_prompt_template(self) -> str:
        if self.tool_name is None:
            return ""
        # Prefer reading prompt text directly from gui_agents.prompts.module
        try:
            prompt_category_map = {
                # manager prompts
                "query_formulator": ("manager", "query_formulator"),
                "narrative_summarization": ("manager", "narrative_summarization"),
                "context_fusion": ("manager", "context_fusion"),
                "planner_role": ("manager", "planner_role"),
                "supplement_role": ("manager", "supplement_role"),
                "dag_translator": ("manager", "dag_translator"),
                "objective_alignment": ("manager", "objective_alignment"),
                # worker prompts
                "operator_role": ("worker", "operator_role"),
                "technician_role": ("worker", "technician_role"),
                "analyst_role": ("worker", "analyst_role"),
                "grounding": ("worker", "grounding"),
                "text_span": ("worker", "text_span"),
                "episode_summarization": ("worker", "episode_summarization"),
                # evaluator prompts
                "worker_success_role": ("evaluator", "worker_success_role"),
                "worker_stale_role": ("evaluator", "worker_stale_role"),
                "periodic_role": ("evaluator", "periodic_role"),
                "final_check_role": ("evaluator", "final_check_role"),
            }

            # Tools that should be prefixed with system architecture info
            tools_require_system_prefix = {
                "planner_role",
                "supplement_role",
                "dag_translator",
                "operator_role",
                "technician_role",
                "analyst_role",
                "worker_success_role",
                "worker_stale_role",
                "periodic_role",
                "final_check_role",
                "objective_alignment",
            }

            category_tuple = prompt_category_map.get(self.tool_name)

            prompt_text = ""
            if category_tuple is None:
                # Try root-level attribute on module (e.g., system_architecture)
                if hasattr(module, self.tool_name):
                    prompt_text = getattr(module, self.tool_name)
                else:
                    return ""
            else:
                category_name, key_name = category_tuple
                category_obj = getattr(module, category_name, None)
                if category_obj is None:
                    return ""
                value = getattr(category_obj, key_name, None)
                if isinstance(value, str) and value:
                    prompt_text = value
                else:
                    return ""

            # Optionally prefix with system architecture information for selected tools
            if (
                isinstance(prompt_text, str)
                and prompt_text
                and self.tool_name in tools_require_system_prefix
            ):
                system_info = getattr(module, "system_architecture", "")
                if isinstance(system_info, str) and system_info:
                    return f"{system_info}\n\n{prompt_text}"

            return prompt_text
        except Exception:
            # Fallback to registry to allow central overrides if available
            return ""
    
    def _call_lmm(self, input_data: Dict[str, Any], temperature: float = 0.0):
        """
        Call the LMM model for inference using the prompt template with retry mechanism
        
        Args:
            input_data: Dictionary containing input data to format the prompt template
            temperature: Temperature parameter to control randomness of output
            
        Returns:
            Model response as text
        """
        # self.llm_agent.reset()
        
        # Extract text and image inputs
        text_input = input_data.get('str_input', '')
        image_input = input_data.get('img_input', None)
        
        # Add the message with the formatted prompt
        self.llm_agent.reset()
        self.llm_agent.add_message(text_input, image_content=image_input, role="user")
        
        # Implement safe retry mechanism
        max_retries = 3
        attempt = 0
        content, total_tokens, cost_string = "", [0, 0, 0], ""
        
        while attempt < max_retries:
            try:
                content, total_tokens, cost_string = self.llm_agent.get_response(temperature=temperature)
                break  # If successful, break out of the loop
            except Exception as e:
                attempt += 1
                logger.error(f"LLM call attempt {attempt} failed: {str(e)}")
                if attempt == max_retries:
                    logger.error("Max retries reached. Returning error message.")
                    return f"Error: LLM call failed after {max_retries} attempts: {str(e)}", [0, 0, 0], ""
                time.sleep(1.0)
        return content, total_tokens, cost_string
    
    @abstractmethod
    def execute(self, tool_input: Dict[str, Any]) -> Tuple[str, List[int], str]:
        """
        Execute the tool with the given input.
        
        Args:
            tool_input: Dictionary containing the input for the tool
                        Expected to have 'str_input' and/or 'img_input' keys
        
        Returns:
            The output of the tool as a string
        """
        pass


class ToolFactory:
    """Factory class for creating tools."""
    
    @staticmethod
    def create_tool(tool_name: str, provider: str, model_name: str, **kwargs) -> 'BaseTool':
        """
        Create a tool instance based on the tool name.
        
        Args:
            tool_name: Name of the tool to create
            provider: API provider name
            model_name: Model name to use
            **kwargs: Additional parameters to pass to the tool
            
        Returns:
            An instance of the specified tool
        
        Raises:
            ValueError: If the tool name is not recognized
        """
        tool_map = {
            "embedding": (EmbeddingTool, None), # all

            "query_formulator": (QueryFormulatorTool, "query_formulator"), # manager
            "websearch": (WebSearchTool, None), # manager
            "narrative_summarization": (NarrativeSummarizationTool, "narrative_summarization"), # manager
            "context_fusion": (ContextFusionTool, "context_fusion"), # manager
            "planner_role": (SubtaskPlannerTool, "planner_role"), # manager
            "supplement_role": (SubtaskPlannerTool, "supplement_role"), # manager
            "dag_translator": (DAGTranslatorTool, "dag_translator"), # manager
            "objective_alignment": (ObjectiveAlignmentTool, "objective_alignment"), # manager
            
            "operator_role": (ActionGeneratorTool, "operator_role"), # worker
            "technician_role": (ActionGeneratorTool, "technician_role"), # worker
            "analyst_role": (ActionGeneratorTool, "analyst_role"), # worker
            "grounding": (GroundingTool, "grounding"), # worker
            "text_span": (TextSpanTool, "text_span"), # worker
            "episode_summarization": (EpisodeSummarizationTool, "episode_summarization"), # worker
            
            "worker_success_role": (EvaluatorTool, "worker_success_role"), # evaluator
            "worker_stale_role": (EvaluatorTool, "worker_stale_role"), # evaluator
            "periodic_role": (EvaluatorTool, "periodic_role"), # evaluator
            "final_check_role": (EvaluatorTool, "final_check_role"), # evaluator
        }
        
        if tool_name not in tool_map:
            raise ValueError(f"Unknown tool name: {tool_name}")
        
        tool_class, prompt_key = tool_map[tool_name]
        
        # WebSearchTool and EmbeddingTool don't need a prompt
        if tool_name == "websearch":
            return tool_class(provider, model_name, None, **kwargs)
        if tool_name == "embedding":
            return tool_class(provider, model_name, None, **kwargs)
        
        return tool_class(provider, model_name, prompt_key, **kwargs)


class WebSearchTool(BaseTool):
    """Tool for performing web searches."""
    
    def __init__(self, provider: str, model_name: str, tool_name: str):
        """
        Initialize the web search tool.
        
        Args:
            provider: API provider name (e.g., "bocha", "exa")
            model_name: Model name to use (not used for WebSearchAgent)
            tool_name: Name of the tool (used as key in prompts.json)
        """
        self.provider = provider
        
        # Create WebSearchAgent instance for search
        self.engine_params = {
            "engine_type": provider,
            "model": model_name,
        }
        
        # Initialize WebSearchAgent
        self.search_agent = WebSearchAgent(engine_params=self.engine_params)
    
    def execute(self, tool_input: Dict[str, Any]) -> Tuple[str, List[int], str]:
        """
        Execute a web search with the given query.
        
        Args:
            tool_input: Dictionary containing the search query
                        Expected to have 'str_input' key with the search query
        
        Returns:
            Search results as a string
        """
        query = tool_input.get('str_input', '')
        if not query:
            return "Error: No search query provided", [0, 0, 0], ""
        
        try:
            # Get the answer from the search results
            answer, total_tokens, cost = self.search_agent.get_answer(query)
            
            # Return just the answer
            return answer, total_tokens, cost # type: ignore
        
        except Exception as e:
            logger.error(f"Error during web search: {str(e)}")
            return f"Error: Web search failed: {str(e)}", [0, 0, 0], ""


class ContextFusionTool(BaseTool):
    """Tool for fusing multiple contexts together."""
    
    def execute(self, tool_input: Dict[str, Any]):
        """
        Fuse multiple contexts together.
        
        Args:
            tool_input: Dictionary containing the contexts to fuse
                        Expected to have 'str_input' key with JSON-formatted contexts
        
        Returns:
            Fused context as a string
        """
        contexts = tool_input.get('str_input', '')
        if not contexts:
            return "Error: No contexts provided"
        
        # Use the prompt template and LMM for context fusion
        return self._call_lmm(tool_input)


class SubtaskPlannerTool(BaseTool):
    """Tool for planning subtasks."""
    
    def execute(self, tool_input: Dict[str, Any]):
        """
        Plan subtasks for a given task.
        
        Args:
            tool_input: Dictionary containing the task description
                        Expected to have 'str_input' key with the task description
                        May also have 'img_input' key with a screenshot
        
        Returns:
            Subtask plan as a string
        """
        task = tool_input.get('str_input', '')
        if not task:
            return "Error: No task description provided"
        
        # Use the prompt template and LMM for subtask planning
        return self._call_lmm(tool_input)


class NarrativeSummarizationTool(BaseTool):
    """Tool for summarizing narrative memories."""
    
    def execute(self, tool_input: Dict[str, Any]):
        """
        Summarize narrative memories.
        
        Args:
            tool_input: Dictionary containing the narrative memory data
                        Expected to have 'str_input' key with the narrative memory data
                        May also have 'img_input' key with relevant images
        
        Returns:
            Summarized narrative as a string
        """
        narrative_data = tool_input.get('str_input', '')
        if not narrative_data:
            return "Error: No narrative memory data provided"
        
        # Use the prompt template and LMM for narrative summarization
        return self._call_lmm(tool_input)


class EpisodeSummarizationTool(BaseTool):
    """Tool for summarizing episodic memories."""
    
    def execute(self, tool_input: Dict[str, Any]):
        """
        Summarize episodic memories.
        
        Args:
            tool_input: Dictionary containing the episodic memory data
                        Expected to have 'str_input' key with the episodic memory data
                        May also have 'img_input' key with relevant images
        
        Returns:
            Summarized episode as a string
        """
        episode_data = tool_input.get('str_input', '')
        if not episode_data:
            return "Error: No episodic memory data provided"
        
        # Use the prompt template and LMM for episode summarization
        return self._call_lmm(tool_input)


class TextSpanTool(BaseTool):
    """Tool for processing text spans."""
    
    def execute(self, tool_input: Dict[str, Any]):
        """
        Process text spans for a given input.
        
        Args:
            tool_input: Dictionary containing the text input
                        Expected to have 'str_input' key with the text content
                        May also have 'img_input' key with a screenshot
        
        Returns:
            Processed text spans as a string
        """
        text = tool_input.get('str_input', '')
        if not text:
            return "Error: No text content provided"
        
        # Use the prompt template and LMM for text span processing
        return self._call_lmm(tool_input)


class DAGTranslatorTool(BaseTool):
    """Tool for translating task descriptions into a DAG (Directed Acyclic Graph) structure."""
    
    def execute(self, tool_input: Dict[str, Any]):
        """
        Translate task descriptions into a DAG structure.
        
        Args:
            tool_input: Dictionary containing the task description
                        Expected to have 'str_input' key with the task description
                        May also have 'img_input' key with a screenshot
        
        Returns:
            DAG representation as a string
        """
        task = tool_input.get('str_input', '')
        if not task:
            return "Error: No task description provided"
        
        # Use the prompt template and LMM for DAG translation
        return self._call_lmm(tool_input)


class ObjectiveAlignmentTool(BaseTool):
    """Tool for aligning and rewriting user objective with current screen context."""
    
    def execute(self, tool_input: Dict[str, Any]):
        """
        Align ambiguous or high-level user objective with the current desktop screenshot context
        and output a refined objective and assumptions.
        
        Args:
            tool_input: Dict with keys:
                - 'str_input': the raw user objective or context text
                - 'img_input': optional screenshot image content
        
        Returns:
            Refined objective as text (ideally JSON-structured), token count, and cost string
        """
        text = tool_input.get('str_input', '')
        if not text:
            return "Error: No objective text provided", [0, 0, 0], ""
        # Forward to LMM with the prompt template
        return self._call_lmm(tool_input)


class TrajReflectorTool(BaseTool):
    """Tool for reflecting on execution trajectories."""
    
    def execute(self, tool_input: Dict[str, Any]):
        """
        Reflect on an execution trajectory.
        
        Args:
            tool_input: Dictionary containing the trajectory
                        Expected to have 'str_input' key with the trajectory
        
        Returns:
            Reflection as a string
        """
        trajectory = tool_input.get('str_input', '')
        if not trajectory:
            return "Error: No trajectory provided"
        
        # Use the prompt template and LMM for trajectory reflection
        return self._call_lmm(tool_input)

class GroundingTool(BaseTool):
    """Tool for grounding agent actions in the environment."""
    
    def execute(self, tool_input: Dict[str, Any]):
        """
        Ground agent actions in the environment.
        
        Args:
            tool_input: Dictionary containing the action and environment state
                        Expected to have 'str_input' key with the action
                        Expected to have 'img_input' key with a screenshot
        
        Returns:
            Grounded action as a string
        """
        action = tool_input.get('str_input', '')
        screenshot = tool_input.get('img_input')
        
        if not action:
            return "Error: No action provided"
        if not screenshot:
            return "Error: No screenshot provided"
        
        # Use the prompt template and LMM for action grounding
        return self._call_lmm(tool_input)
    
    def get_grounding_wh(self):
        """
        Get grounding width and height based on provider and model name.
        
        Returns:
            If provider is doubao and model_name contains 'ui-tars', returns two values:
            grounding_width (int): Width value (1024)
            grounding_height (int): Height value (768)
            Otherwise returns None, None
        """
        if self.provider == "doubao" and ("ui-tars" in self.model_name or "ep-" in self.model_name):
            grounding_width = 1000
            grounding_height = 1000
            return grounding_width, grounding_height
        return None, None


class EvaluatorTool(BaseTool):
    """Tool for evaluating agent performance."""
    
    def execute(self, tool_input: Dict[str, Any]):
        """
        Evaluate agent performance.
        
        Args:
            tool_input: Dictionary containing the evaluation data
                        Expected to have 'str_input' key with the evaluation data
        
        Returns:
            Evaluation result as a string
        """
        eval_data = tool_input.get('str_input', '')
        if not eval_data:
            return "Error: No evaluation data provided"
        
        # Use the prompt template and LMM for performance evaluation
        return self._call_lmm(tool_input)


class ActionGeneratorTool(BaseTool):
    """Tool for generating executable actions."""
    
    def __init__(self, provider: str, model_name: str, tool_name: str, **kwargs):
        """
        Initialize the action generator tool.
        
        Args:
            provider: API provider name
            model_name: Model name to use
            tool_name: Name of the tool (used as key in prompts.json)
            **kwargs: Additional parameters, including:
                enable_search: Whether to enable web search functionality
                search_provider: Provider for web search (defaults to "bocha")
                search_model: Model for web search (defaults to "")
        """
        super().__init__(provider, model_name, tool_name)
        
        # Extract search-related parameters
        self.enable_search = kwargs.get("enable_search", False)
        search_provider = kwargs.get("search_provider", "bocha")
        search_model = kwargs.get("search_model", "")
        
        # Initialize search tool if enabled
        self.search_tool = None
        if self.enable_search:
            self.search_tool = WebSearchTool(search_provider, search_model, "")
            logger.info(f"Web search enabled for {tool_name} using provider: {search_provider}")
    
    def execute(self, tool_input: Dict[str, Any]):
        """
        Generate executable actions.
        
        Args:
            tool_input: Dictionary containing the action request
                        Expected to have 'str_input' key with the action request
                        May also have 'img_input' key with a screenshot
        
        Returns:
            Generated action as a string
        """
        action_request = tool_input.get('str_input', '')
        if not action_request:
            return "Error: No action request provided", [0, 0, 0], ""
        
        # Check if search is enabled
        if self.enable_search and self.search_tool:
            try:
                # Use the input text directly as search query
                search_query = action_request
                logger.info(f"Performing web search for query: {search_query}")
                search_results, tokens, cost = self.search_tool.execute({"str_input": search_query})
                
                # Enhance the action request with search results
                enhanced_request = f"[Action Request]\n{action_request}\n[End of Action Request]\n\n[Web Search Results for '{action_request}']\n{search_results}\n\n[End of Web Search Results]"
                tool_input["str_input"] = enhanced_request
                
                logger.info(f"Search completed. Found information: {len(search_results)} characters")
            except Exception as e:
                logger.error(f"Error during web search: {e}")
                # Continue with original request if search fails
        
        # Use the prompt template and LMM for action generation
        return self._call_lmm(tool_input)


class FastActionGeneratorTool(BaseTool):
    """Tool for directly generating executable actions without intermediate planning."""
    
    def __init__(self, provider: str, model_name: str, tool_name: str, **kwargs):
        """
        Initialize the fast action generator tool.
        
        Args:
            provider: API provider name
            model_name: Model name to use
            tool_name: Name of the tool (used as key in prompts.json)
            **kwargs: Additional parameters, including:
                enable_search: Whether to enable web search functionality
                search_provider: Provider for web search (defaults to "bocha")
                search_model: Model for web search (defaults to "")
        """
        super().__init__(provider, model_name, tool_name)
        
        # Extract search-related parameters
        self.enable_search = kwargs.get("enable_search", False)
        search_provider = kwargs.get("search_provider", "bocha")
        search_model = kwargs.get("search_model", "")
        
        # Initialize search tool if enabled
        self.search_tool = None
        if self.enable_search:
            self.search_tool = WebSearchTool(search_provider, search_model, "")
            logger.info(f"Web search enabled for {tool_name} using provider: {search_provider}")
    
    def execute(self, tool_input: Dict[str, Any]):
        """
        Generate executable actions directly from the instruction and screenshot.
        
        Args:
            tool_input: Dictionary containing the action request
                        Expected to have 'str_input' key with the instruction
                        Expected to have 'img_input' key with a screenshot
        
        Returns:
            Generated action as a string, token count, and cost
        """
        action_request = tool_input.get('str_input', '')
        screenshot = tool_input.get('img_input')
        if not action_request:
            return "Error: No action request provided", [0, 0, 0], ""
        if not screenshot:
            return "Error: No screenshot provided", [0, 0, 0], ""
        # Check if search is enabled
        if self.enable_search and self.search_tool:
            try:
                # Use the input text directly as search query
                search_query = action_request
                logger.info(f"Performing web search for query: {search_query}")
                search_results, tokens, cost = self.search_tool.execute({"str_input": search_query})
                
                # Enhance the action request with search results
                enhanced_request = f"[Action Request]\n{action_request}\n[End of Action Request]\n\n[Web Search Results for '{action_request}']\n{search_results}\n\n[End of Web Search Results]"
                tool_input["str_input"] = enhanced_request
                
                logger.info(f"Search completed. Found information: {len(search_results)} characters")
            except Exception as e:
                logger.error(f"Error during web search: {e}")
                # Continue with original request if search fails
        
        # Use the prompt template and LMM for action generation
        return self._call_lmm(tool_input)

    def get_grounding_wh(self):
        """
        Get grounding width and height based on provider and model name.
        
        Returns:
            If provider is doubao and model_name contains 'ui-tars', returns two values:
            grounding_width (int): Width value (1024)
            grounding_height (int): Height value (768)
            Otherwise returns None, None
        """
        if self.provider == "doubao" and "ui-tars" in self.model_name:
            grounding_width = 1000
            grounding_height = 1000
            return grounding_width, grounding_height
        return None, None

class EmbeddingTool(BaseTool):
    """Tool for generating text embeddings."""
    
    def __init__(self, provider: str, model_name: str, tool_name: str):
        """
        Initialize the embedding tool.
        
        Args:
            provider: API provider name (e.g., "openai", "gemini")
            model_name: Model name to use
            tool_name: Name of the tool (used as key in prompts.json)
        """
        self.provider = provider
        self.model_name = model_name
        self.tool_name = tool_name
        
        # Create EmbeddingAgent instance
        self.engine_params = {
            "engine_type": provider,
            "embedding_model": model_name
        }
        
        # Initialize EmbeddingAgent
        self.embedding_agent = EmbeddingAgent(engine_params=self.engine_params)
    
    def execute(self, tool_input: Dict[str, Any]):
        """
        Generate embeddings for the given text.
        
        Args:
            tool_input: Dictionary containing the text to embed
                        Expected to have 'str_input' key with the text
        
        Returns:
            Embeddings as a JSON string
        """
        text = tool_input.get('str_input', '')
        
        if not text:
            return "Error: No text provided for embedding", [0, 0, 0], ""
        
        try:
            # Get embeddings for the text
            embeddings, total_tokens, cost_string = self.embedding_agent.get_embeddings(text)
            return embeddings, total_tokens, cost_string
                
        except Exception as e:
            logger.error(f"Error during embedding operation: {str(e)}")
            return f"Error: Embedding operation failed: {str(e)}", [0, 0, 0], ""

class QueryFormulatorTool(BaseTool):
    """Tool for formulating queries from tasks or contexts."""
    
    def execute(self, tool_input: Dict[str, Any]):
        """
        Formulate a query for a given task or context.
        
        Args:
            tool_input: Dictionary containing the task or context description
                        Expected to have 'str_input' key with the description
                        May also have 'img_input' key with a screenshot
        
        Returns:
            Formulated query as a string
        """
        task = tool_input.get('str_input', '')
        if not task:
            return "Error: No task or context description provided"
        
        # Use the prompt template and LMM for query formulation
        return self._call_lmm(tool_input)

class NewTools:
    """Main Tools class that provides access to all available tools."""
    
    def __init__(self):
        """Initialize the Tools class."""
        self.tools = {}
    
    def register_tool(self, tool_name: str, provider: str, model_name: str, **kwargs):
        """
        Register a tool with the specified parameters.
        
        Args:
            tool_name: Name of the tool to register
            provider: API provider name
            model_name: Model name to use
            **kwargs: Additional parameters to pass to the tool
        """
        tool: BaseTool = ToolFactory.create_tool(tool_name, provider, model_name, **kwargs)
        self.tools[tool_name] = tool
    
    def execute_tool(self, tool_name: str, tool_input: Dict[str, Any]):
        """
        Execute a tool with the given input.
        
        Args:
            tool_name: Name of the tool to execute
            tool_input: Input for the tool
        
        Returns:
            The output of the tool as a string
        
        Raises:
            ValueError: If the tool is not registered
        """
        if tool_name not in self.tools:
            raise ValueError(f"Tool {tool_name} is not registered")
        
        return self.tools[tool_name].execute(tool_input)

    def reset(self, tool_name: Optional[str] = None):
        """
        Reset tools by resetting their llm_agent if available.
        
        Args:
            tool_name: Optional name of the specific tool to reset. If None, resets all tools.
        """
        if tool_name is not None:
            # Reset a specific tool
            if tool_name not in self.tools:
                raise ValueError(f"Tool {tool_name} is not registered")
            
            tool = self.tools[tool_name]
            if hasattr(tool, 'llm_agent') and tool.llm_agent is not None:
                tool.llm_agent.reset()
        else:
            # Reset all tools
            for tool in self.tools.values():
                # Only reset if the tool has an llm_agent attribute
                if hasattr(tool, 'llm_agent') and tool.llm_agent is not None:
                    tool.llm_agent.reset() 