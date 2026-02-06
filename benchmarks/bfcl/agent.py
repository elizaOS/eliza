"""
BFCL Agent Wrapper - Full ElizaOS Integration

Uses the canonical ElizaOS runtime with:
- message_service.handle_message() for full pipeline
- Actions registered for BFCL functions  
- Providers giving context
- Basic capabilities enabled (default)
- Trajectory logging for training data capture

This is NOT a bypass - it uses the full ElizaOS agent flow.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from pathlib import Path
from typing import Optional

from benchmarks.bfcl.parser import FunctionCallParser
from benchmarks.bfcl.plugin import (
    BFCLPluginFactory,
    generate_openai_tools_format,
    get_call_capture,
)
from benchmarks.bfcl.types import (
    BFCLConfig,
    BFCLTestCase,
    FunctionCall,
)

logger = logging.getLogger(__name__)

# Import trajectory logger plugin for training data capture (optional)
try:
    from elizaos_plugin_trajectory_logger.runtime_service import (
        TrajectoryExportConfig,
        TrajectoryLoggerRuntimeService,
    )
    from elizaos_plugin_trajectory_logger import get_trajectory_logger_plugin

    TRAJECTORY_LOGGER_AVAILABLE = True
except Exception:
    TrajectoryLoggerRuntimeService = None  # type: ignore[misc, assignment]
    TrajectoryExportConfig = None  # type: ignore[misc, assignment]
    get_trajectory_logger_plugin = None  # type: ignore[misc, assignment]
    TRAJECTORY_LOGGER_AVAILABLE = False
    logger.debug("Trajectory logger plugin not available - training data capture disabled")


# Import ElizaOS types - required dependency for full agent
try:
    from elizaos.runtime import AgentRuntime
    from elizaos.types.agent import Character
    from elizaos.types.memory import Memory
    from elizaos.types.plugin import Plugin
    from elizaos.types.primitives import Content, string_to_uuid
    from elizaos.types.components import Action, ActionResult, Provider, ProviderResult
    from elizaos.types.runtime import IAgentRuntime
    from elizaos.types.state import State

    ELIZAOS_AVAILABLE = True
except ImportError:
    AgentRuntime = None  # type: ignore[misc, assignment]
    Character = None  # type: ignore[misc, assignment]
    Memory = None  # type: ignore[misc, assignment]
    Plugin = None  # type: ignore[misc, assignment]
    Content = None  # type: ignore[misc, assignment]
    string_to_uuid = None  # type: ignore[misc, assignment]
    Action = None  # type: ignore[misc, assignment]
    ActionResult = None  # type: ignore[misc, assignment]
    Provider = None  # type: ignore[misc, assignment]
    ProviderResult = None  # type: ignore[misc, assignment]
    IAgentRuntime = None  # type: ignore[misc, assignment]
    State = None  # type: ignore[misc, assignment]
    ELIZAOS_AVAILABLE = False
    logger.warning("ElizaOS not available, agent will use mock mode")


def get_model_provider_plugin(
    provider: Optional[str] = None,
    model: Optional[str] = None,
) -> tuple[Optional["Plugin"], Optional[str]]:
    """
    Get an LLM model provider plugin based on configuration.
    
    Priority order (when no explicit provider):
    1. BFCL_PROVIDER env var
    2. Groq (llama-3.1-8b-instant - our default)
    3. OpenAI
    4. Anthropic
    5. Google GenAI
    6. XAI
    7. OpenRouter
    8. Ollama (local)
    
    Args:
        provider: Optional explicit provider name
        model: Optional explicit model name
        
    Returns:
        Tuple of (Plugin, model_name) or (None, None) if no provider available
    """
    from benchmarks.bfcl.models import (
        ModelProvider,
        PROVIDER_CONFIGS,
        get_default_model_config,
        get_model_config,
    )
    
    if not ELIZAOS_AVAILABLE:
        return None, None
    
    # Determine which provider/model to use
    model_config = None
    if model:
        model_config = get_model_config(model)
    elif provider:
        # Find provider config
        try:
            mp = ModelProvider(provider.lower())
            pc = PROVIDER_CONFIGS[mp]
            from benchmarks.bfcl.models import BenchmarkModelConfig
            api_key = os.environ.get(pc.api_key_env, "")
            if api_key or pc.is_local:
                model_config = BenchmarkModelConfig(
                    provider=mp,
                    model_id=pc.small_model,
                    display_name=f"{pc.small_model} ({mp.value})",
                    api_key=api_key if api_key else None,
                )
        except (ValueError, KeyError):
            logger.warning(f"Unknown provider: {provider}")
    
    if model_config is None:
        model_config = get_default_model_config()
    
    if model_config is None:
        logger.warning("No model provider available")
        return None, None
    
    # Create the appropriate plugin
    plugin = _create_provider_plugin(model_config.provider.value)
    if plugin:
        return plugin, model_config.full_model_name
    
    return None, None


def _create_provider_plugin(provider_name: str) -> Optional["Plugin"]:
    """Create a plugin for the specified provider."""
    from benchmarks.bfcl.models import ModelProvider
    
    try:
        provider = ModelProvider(provider_name)
    except ValueError:
        logger.warning(f"Unknown provider: {provider_name}")
        return None
    
    try:
        if provider == ModelProvider.GROQ:
            try:
                from elizaos_plugin_groq.plugin import get_groq_elizaos_plugin
                logger.info("Using Groq model provider (llama-3.1-8b-instant default)")
                return get_groq_elizaos_plugin()
            except ImportError:
                # Groq plugin may not have elizaos integration yet, create one
                return _create_groq_plugin()
        
        elif provider == ModelProvider.OPENAI:
            from elizaos_plugin_openai import create_openai_elizaos_plugin
            logger.info("Using OpenAI model provider")
            return create_openai_elizaos_plugin()
        
        elif provider == ModelProvider.ANTHROPIC:
            try:
                from elizaos_plugin_anthropic.plugin import get_anthropic_elizaos_plugin
                logger.info("Using Anthropic model provider")
                return get_anthropic_elizaos_plugin()
            except ImportError:
                # Create plugin manually
                return _create_anthropic_plugin()
        
        elif provider == ModelProvider.GOOGLE_GENAI:
            try:
                from elizaos_plugin_google_genai.plugin import get_google_elizaos_plugin
                logger.info("Using Google GenAI model provider")
                return get_google_elizaos_plugin()
            except ImportError:
                logger.warning("Google GenAI plugin not fully installed")
        
        elif provider == ModelProvider.XAI:
            from elizaos_plugin_xai.plugin import get_xai_elizaos_plugin
            logger.info("Using xAI Grok model provider")
            return get_xai_elizaos_plugin()
        
        elif provider == ModelProvider.OPENROUTER:
            try:
                from elizaos_plugin_openrouter.plugin import get_openrouter_elizaos_plugin
                logger.info("Using OpenRouter model provider")
                return get_openrouter_elizaos_plugin()
            except ImportError:
                logger.warning("OpenRouter plugin not fully installed")
        
        elif provider == ModelProvider.OLLAMA:
            try:
                from elizaos_plugin_ollama.plugin import get_ollama_elizaos_plugin
                logger.info("Using Ollama model provider (local)")
                return get_ollama_elizaos_plugin()
            except ImportError:
                logger.warning("Ollama plugin not fully installed")
        
        elif provider == ModelProvider.LOCAL_AI:
            logger.info("Using Local AI model provider")
            return None
            
    except ImportError as e:
        logger.warning(f"Failed to import plugin for {provider}: {e}")
    except Exception as e:
        logger.error(f"Error creating plugin for {provider}: {e}")
    
    return None


def _create_groq_plugin() -> Optional["Plugin"]:
    """Create an elizaOS plugin for Groq."""
    if not ELIZAOS_AVAILABLE:
        return None
    
    try:
        from elizaos.types.model import ModelType
        from elizaos.types.plugin import Plugin
        from elizaos_plugin_groq import GroqClient, GroqConfig, GenerateTextParams
        
        api_key = os.environ.get("GROQ_API_KEY", "")
        if not api_key:
            return None
        
        # Configuration from environment
        config = GroqConfig(
            api_key=api_key,
            base_url=os.environ.get("GROQ_BASE_URL", "https://api.groq.com/openai/v1"),
            small_model=os.environ.get("GROQ_SMALL_MODEL", "llama-3.1-8b-instant"),
            large_model=os.environ.get("GROQ_LARGE_MODEL", "llama-3.3-70b-versatile"),
        )
        
        _client: GroqClient | None = None
        
        def _get_client() -> GroqClient:
            nonlocal _client
            if _client is None:
                _client = GroqClient(api_key=config.api_key, config=config)
            return _client
        
        async def text_large_handler(
            runtime: object,  # IAgentRuntime - not used in handler
            params: dict[str, object],
        ) -> str:
            client = _get_client()
            max_tokens_val = params.get("maxTokens")
            temp_val = params.get("temperature")
            return await client.generate_text_large(
                GenerateTextParams(
                    prompt=str(params.get("prompt", "")),
                    system=str(params.get("system", "")) if params.get("system") else None,
                    max_tokens=int(str(max_tokens_val)) if max_tokens_val is not None else None,
                    temperature=float(str(temp_val)) if temp_val is not None else None,
                )
            )
        
        async def text_small_handler(
            runtime: object,  # IAgentRuntime - not used in handler
            params: dict[str, object],
        ) -> str:
            client = _get_client()
            max_tokens_val = params.get("maxTokens")
            temp_val = params.get("temperature")
            return await client.generate_text_small(
                GenerateTextParams(
                    prompt=str(params.get("prompt", "")),
                    system=str(params.get("system", "")) if params.get("system") else None,
                    max_tokens=int(str(max_tokens_val)) if max_tokens_val is not None else None,
                    temperature=float(str(temp_val)) if temp_val is not None else None,
                )
            )
        
        return Plugin(
            name="groq",
            description="Groq model provider for BFCL benchmark (llama-3.1-8b-instant default)",
            models={
                ModelType.TEXT_LARGE: text_large_handler,
                ModelType.TEXT_SMALL: text_small_handler,
            },
        )
    
    except ImportError as e:
        logger.warning(f"Failed to create Groq plugin: {e}")
        return None


def _create_anthropic_plugin() -> Optional["Plugin"]:
    """Create an elizaOS plugin for Anthropic."""
    if not ELIZAOS_AVAILABLE:
        return None
    
    try:
        from elizaos.types.model import ModelType
        from elizaos.types.plugin import Plugin
        from elizaos_plugin_anthropic import AnthropicClient, AnthropicConfig, TextGenerationParams
        
        api_key = os.environ.get("ANTHROPIC_API_KEY", "")
        if not api_key:
            return None
        
        # Use from_env() which handles Model objects correctly
        try:
            config = AnthropicConfig.from_env()
        except Exception:
            # Fallback: create config with defaults
            config = AnthropicConfig(api_key=api_key)
        
        _client: AnthropicClient | None = None
        
        def _get_client() -> AnthropicClient:
            nonlocal _client
            if _client is None:
                _client = AnthropicClient(config=config)
            return _client
        
        async def text_large_handler(
            runtime: object,  # IAgentRuntime - not used in handler
            params: dict[str, object],
        ) -> str:
            client = _get_client()
            max_tokens_val = params.get("maxTokens")
            temp_val = params.get("temperature")
            result = await client.generate_text_large(
                TextGenerationParams(
                    prompt=str(params.get("prompt", "")),
                    system=str(params.get("system", "")) if params.get("system") else None,
                    max_tokens=int(str(max_tokens_val)) if max_tokens_val is not None else 4096,
                    temperature=float(str(temp_val)) if temp_val is not None else 0.0,
                ),
            )
            return result.text if result else ""
        
        async def text_small_handler(
            runtime: object,  # IAgentRuntime - not used in handler
            params: dict[str, object],
        ) -> str:
            client = _get_client()
            max_tokens_val = params.get("maxTokens")
            temp_val = params.get("temperature")
            result = await client.generate_text_small(
                TextGenerationParams(
                    prompt=str(params.get("prompt", "")),
                    system=str(params.get("system", "")) if params.get("system") else None,
                    max_tokens=int(str(max_tokens_val)) if max_tokens_val is not None else 4096,
                    temperature=float(str(temp_val)) if temp_val is not None else 0.0,
                ),
            )
            return result.text if result else ""
        
        logger.info("Using Anthropic model provider (created manually)")
        return Plugin(
            name="anthropic",
            description="Anthropic model provider for BFCL benchmark",
            models={
                ModelType.TEXT_LARGE: text_large_handler,
                ModelType.TEXT_SMALL: text_small_handler,
            },
        )
    
    except ImportError as e:
        logger.warning(f"Failed to create Anthropic plugin: {e}")
        return None


class BFCLAgent:
    """
    Agent wrapper for BFCL benchmark execution using FULL ElizaOS pipeline.

    This agent uses the canonical ElizaOS flow:
    - message_service.handle_message() for full message processing
    - Actions registered for BFCL test functions
    - Providers giving context (bootstrap providers + BFCL functions)
    - Basic capabilities enabled (default)
    
    This is NOT a bypass - it uses the complete ElizaOS agent architecture.
    
    Default Model:
    - Groq with llama-3.1-8b-instant (fast and efficient for function calling)
    """

    def __init__(
        self,
        config: BFCLConfig,
        runtime: Optional["AgentRuntime"] = None,
        character: Optional["Character"] = None,
        model_plugin: Optional["Plugin"] = None,
        provider: Optional[str] = None,
        model: Optional[str] = None,
    ):
        """
        Initialize BFCL agent with full ElizaOS support.

        Args:
            config: BFCL benchmark configuration
            runtime: Optional pre-configured runtime
            character: Optional character for runtime creation
            model_plugin: Optional model provider plugin (auto-detected if not provided)
            provider: Optional provider name (groq, openai, anthropic, etc.)
            model: Optional specific model name (e.g., "groq/llama-3.1-8b-instant")
        """
        self.config = config
        self.runtime = runtime
        self.character = character
        self.model_plugin = model_plugin
        self.provider = provider
        self.model = model
        self.plugin_factory = BFCLPluginFactory()
        self.parser = FunctionCallParser()
        self._initialized = False
        self._has_model_provider = False
        self._model_name: Optional[str] = None
        self._current_test_case: Optional[BFCLTestCase] = None
        self._room_id: Optional[str] = None
        self._entity_id: Optional[str] = None
        
        # Trajectory capture is performed by the canonical runtime service registered
        # by plugin-trajectory-logger.
        self._current_trajectory_id: Optional[str] = None
        self._trajectories: list[object] = []

    async def initialize(self) -> None:
        """
        Initialize the agent runtime with FULL ElizaOS capabilities.
        
        This sets up:
        1. The ElizaOS AgentRuntime with bootstrap plugin (basic capabilities)
        2. A model provider plugin (Groq default, or other providers)
        3. The message service for proper message handling
        
        Basic capabilities are enabled by default (disable_basic_capabilities=False).
        """
        if self._initialized:
            return

        if not ELIZAOS_AVAILABLE:
            logger.warning("ElizaOS not available, running in mock mode")
            self._initialized = True
            return

        # Auto-detect model plugin if not provided
        if self.model_plugin is None:
            self.model_plugin, self._model_name = get_model_provider_plugin(
                provider=self.provider,
                model=self.model,
            )
        
        if self.model_plugin is None:
            logger.warning(
                "No model provider plugin available. "
                "Set GROQ_API_KEY (recommended), OPENAI_API_KEY, ANTHROPIC_API_KEY, or other provider keys. "
                "Agent will run in mock mode."
            )
            self._initialized = True
            return

        if self.runtime is None:
            # Create character with system prompt for function calling
            if self.character is None:
                self.character = Character(
                    name="BFCLBenchmarkAgent",
                    bio="An AI agent specialized in function calling for BFCL benchmark evaluation.",
                    system="""You are a function-calling AI assistant being evaluated on the Berkeley Function-Calling Leaderboard (BFCL).

Your task is to analyze user queries and determine which function(s) to call with what arguments.

CRITICAL INSTRUCTIONS:
1. Carefully read the available functions from the BFCL_FUNCTIONS context
2. Match the user's intent to the most appropriate function(s)
3. Extract the correct argument values from the query
4. Include ALL required parameters with correct types
5. Use correct types - numbers should be numbers (not strings), booleans should be booleans

RESPONSE FORMAT - Use the BFCL_CALL action with your function call:
<actions>BFCL_CALL</actions>
<params>
{"calls": [{"name": "function_name", "arguments": {"arg1": value1, "arg2": value2}}]}
</params>

For multiple functions:
<params>
{"calls": [{"name": "func1", "arguments": {...}}, {"name": "func2", "arguments": {...}}]}
</params>

If no function is relevant:
<params>
{"calls": [], "reason": "explanation"}
</params>

IMPORTANT:
- Numbers should NOT be quoted: use 100 not "100"
- Booleans should be true/false not "true"/"false"
- Always use the BFCL_CALL action format""",
                )

            # Create runtime with model plugin, sql plugin, and bootstrap (basic capabilities)
            # disable_basic_capabilities=False is the default - ensures full agent pipeline
            # This matches the canonical pattern from chat.py and telegram_agent.py
            plugins_list = [self.model_plugin]
            
            # Add sql_plugin for proper message_service support (like telegram_agent.py)
            try:
                from elizaos_plugin_sql import sql_plugin
                plugins_list.append(sql_plugin)
            except ImportError:
                logger.warning("sql_plugin not available - message_service may have limited functionality")

            # Optional: enable end-to-end trajectory capture via the canonical service.
            if TRAJECTORY_LOGGER_AVAILABLE and callable(get_trajectory_logger_plugin):
                try:
                    plugins_list.append(get_trajectory_logger_plugin())
                    logger.info("Trajectory logger plugin enabled for BFCL training capture")
                except Exception:
                    # Never fail initialization due to optional logging.
                    pass
            
            self.runtime = AgentRuntime(
                character=self.character,
                plugins=plugins_list,
                log_level="INFO",
                disable_basic_capabilities=False,  # Explicit: use full capabilities
            )

        await self.runtime.initialize()
        
        # Verify message service is available
        if not hasattr(self.runtime, 'message_service') or self.runtime.message_service is None:
            logger.warning("Message service not available - using simplified flow")
        
        self._has_model_provider = self.runtime.has_model("TEXT_LARGE")
        
        # Set up room and entity IDs for message handling
        self._room_id = string_to_uuid("bfcl_benchmark_room")
        self._entity_id = string_to_uuid("bfcl_user")
        
        if self._has_model_provider:
            logger.info(f"BFCL agent initialized with model: {self._model_name or 'unknown'}")
        else:
            logger.warning("BFCL agent initialized but no TEXT_LARGE model available")
        
        self._initialized = True

    @property
    def model_name(self) -> Optional[str]:
        """Get the name of the model being used."""
        return self._model_name

    async def setup_test_case(self, test_case: BFCLTestCase) -> None:
        """
        Set up the runtime for a specific test case.

        Registers:
        - BFCL_CALL action for capturing function calls
        - BFCL_FUNCTIONS provider for injecting available functions into context
        """
        if not ELIZAOS_AVAILABLE or self.runtime is None:
            return

        self._current_test_case = test_case
        
        # Clear previous call captures
        get_call_capture().clear()

        # Create plugin with BFCL action and provider
        plugin = self._create_bfcl_test_plugin(test_case)
        await self.runtime.register_plugin(plugin)

        logger.debug(f"Set up test case {test_case.id} with {len(test_case.functions)} functions")

    def _create_bfcl_test_plugin(self, test_case: BFCLTestCase) -> "Plugin":
        """
        Create an ElizaOS plugin for a BFCL test case.
        
        This creates:
        - BFCL_CALL action: Captures function calls made by the agent
        - BFCL_FUNCTIONS provider: Injects available functions into context
        """
        # Generate function definitions in OpenAI tools format
        tools = generate_openai_tools_format(test_case.functions)
        tools_json = str(tools)
        
        # Create provider that injects BFCL functions into context
        async def bfcl_functions_provider(
            runtime: IAgentRuntime,
            message: Memory,
            state: State,
        ) -> ProviderResult:
            """Provide BFCL function definitions to the agent."""
            return ProviderResult(
                text=f"""# BFCL Available Functions

The following functions are available for this query. Analyze the user's request and call the appropriate function(s).

```json
{tools_json}
```

Use the BFCL_CALL action to make function calls.""",
                values={"bfcl_functions": tools_json},
                data={"functions": test_case.functions},
            )
        
        functions_provider = Provider(
            name="BFCL_FUNCTIONS",
            description="Provides BFCL function definitions for the current test case",
            get=bfcl_functions_provider,
            dynamic=True,  # Changes per test case
            position=10,   # After character, before actions
        )
        
        # Create action that captures function calls
        async def bfcl_call_validate(
            runtime: IAgentRuntime,
            message: Memory,
            state: State,
        ) -> bool:
            """Always valid - the BFCL_CALL action is always available."""
            return True
        
        async def bfcl_call_handler(
            runtime: IAgentRuntime,
            message: Memory,
            state: State,
            options: dict[str, object],
            callback: object,
            responses: list[object],
        ) -> ActionResult:
            """Handle BFCL function calls - captures them for evaluation."""
            
            # Get calls from action params
            calls_data = options.get("calls", [])
            reason = options.get("reason", "")
            
            captured_calls: list[FunctionCall] = []
            
            if isinstance(calls_data, list):
                for call in calls_data:
                    if isinstance(call, dict) and "name" in call:
                        func_name = str(call.get("name", ""))
                        arguments = call.get("arguments", {})
                        if isinstance(arguments, dict):
                            captured_calls.append(FunctionCall(
                                name=func_name,
                                arguments=arguments,
                            ))
            
            # Store captured calls
            capture = get_call_capture()
            for call in captured_calls:
                capture.capture(call.name, call.arguments)
            
            response_text = f"Captured {len(captured_calls)} function call(s)"
            if reason:
                response_text = f"No function called: {reason}"
            
            return ActionResult(
                success=True,
                text=response_text,
                data={"calls": [{"name": c.name, "arguments": c.arguments} for c in captured_calls]},
            )
        
        # Import ActionParameter types for proper schema
        from elizaos.types.components import ActionParameter, ActionParameterSchema, ActionExample
        from elizaos.types.primitives import Content as ElizaContent
        
        bfcl_call_action = Action(
            name="BFCL_CALL",
            description="Make function calls for BFCL benchmark evaluation. Use this action to call any of the available BFCL functions.",
            similes=["CALL_FUNCTION", "INVOKE_FUNCTION", "EXECUTE_FUNCTION"],
            validate=bfcl_call_validate,
            handler=bfcl_call_handler,
            examples=[
                [
                    ActionExample(
                        name="{{user}}",
                        content=ElizaContent(text="What's the weather in San Francisco?"),
                    ),
                    ActionExample(
                        name="{{agentName}}",
                        content=ElizaContent(text="I'll check the weather for you.", actions=["BFCL_CALL"]),
                    ),
                ],
            ],
            parameters=[
                ActionParameter(
                    name="calls",
                    description="Array of function calls to make, each with 'name' and 'arguments'",
                    required=True,
                    schema=ActionParameterSchema(
                        type="array",
                        description="Array of function calls",
                        items={"type": "object", "properties": {"name": {"type": "string"}, "arguments": {"type": "object"}}},
                    ),
                ),
                ActionParameter(
                    name="reason",
                    description="Reason if no function call is appropriate",
                    required=False,
                    schema=ActionParameterSchema(
                        type="string",
                        description="Explanation for why no function was called",
                    ),
                ),
            ],
        )
        
        return Plugin(
            name=f"bfcl_{test_case.id}",
            description=f"BFCL test case: {test_case.id}",
            actions=[bfcl_call_action],
            providers=[functions_provider],
        )

    async def query(
        self,
        test_case: BFCLTestCase,
        timeout_ms: Optional[int] = None,
    ) -> tuple[list[FunctionCall], str, float]:
        """
        Execute a BFCL query using the FULL ElizaOS agent pipeline.

        This uses message_service.handle_message() for proper:
        - Provider context injection (BFCL_FUNCTIONS + bootstrap providers)
        - Action execution (BFCL_CALL captures function calls)
        - Full agent message handling
        - Trajectory logging for training data capture

        Args:
            test_case: The BFCL test case to execute
            timeout_ms: Optional timeout in milliseconds

        Returns:
            Tuple of (predicted_calls, raw_response, latency_ms)
        """
        if not self._initialized:
            await self.initialize()

        timeout_ms = timeout_ms or self.config.timeout_per_test_ms
        start_time = time.time()
        start_time_ms = int(start_time * 1000)
        
        traj_logger: object | None = None
        trajectory_id: Optional[str] = None
        step_id: Optional[str] = None
        if ELIZAOS_AVAILABLE and self.runtime is not None and TRAJECTORY_LOGGER_AVAILABLE:
            svc = self.runtime.get_service("trajectory_logger")
            if TrajectoryLoggerRuntimeService is not None and isinstance(svc, TrajectoryLoggerRuntimeService):
                traj_logger = svc
                trajectory_id = svc.start_trajectory(
                    agent_id=self.character.name if self.character else "bfcl_agent",
                    scenario_id=f"bfcl_{test_case.category.value}",
                    episode_id=test_case.id,
                    metadata={
                        "test_case_id": test_case.id,
                        "category": test_case.category.value,
                        "question": test_case.question[:2000],
                        "model": self._model_name or "unknown",
                        "provider": self.provider or "unknown",
                        "benchmark": "bfcl",
                    },
                )
                step_id = svc.start_step(
                    trajectory_id,
                    timestamp_ms=start_time_ms,
                    custom={"test_case_id": test_case.id},
                )

        try:
            # Set up test case (registers BFCL action and provider)
            await self.setup_test_case(test_case)

            # Execute based on runtime availability. If we have a step id, bind it so
            # runtime.use_model logs the full prompt/response automatically.
            if ELIZAOS_AVAILABLE and self.runtime and self._has_model_provider:
                from elizaos.trajectory_context import bind_trajectory_step

                with bind_trajectory_step(step_id):
                    response = await self._execute_with_message_service(test_case, timeout_ms)
            else:
                response = await self._execute_mock(test_case)

            latency_ms = (time.time() - start_time) * 1000

            # Extract function calls from captured calls or response
            predicted_calls = self._extract_function_calls(response, test_case)
            
            # Complete trajectory step with action and result (if enabled)
            if (
                traj_logger is not None
                and TrajectoryLoggerRuntimeService is not None
                and isinstance(traj_logger, TrajectoryLoggerRuntimeService)
                and trajectory_id
                and step_id
            ):
                action_success = len(predicted_calls) > 0
                traj_logger.complete_step(
                    trajectory_id=trajectory_id,
                    step_id=step_id,
                    action_type="function_call",
                    action_name="BFCL_CALL",
                    parameters={
                        "calls": str(
                            [{"name": c.name, "arguments": c.arguments} for c in predicted_calls]
                        )[:2000]
                    },
                    success=action_success,
                    reward=1.0 if action_success else 0.0,
                    done=True,
                    result={"predicted_calls": len(predicted_calls)},
                    reasoning=(response[:500] if response else None),
                )

                await traj_logger.end_trajectory(
                    trajectory_id,
                    status="completed",
                    final_metrics={
                        "latency_ms": int(latency_ms),
                        "predicted_calls": int(len(predicted_calls)),
                    },
                )

                # Store completed trajectory for optional export.
                try:
                    get_active = getattr(traj_logger, "get_active_trajectory", None)
                    if callable(get_active):
                        completed = get_active(trajectory_id)
                        if completed is not None:
                            self._trajectories.append(completed)
                except Exception:
                    pass

            return predicted_calls, response, latency_ms

        except asyncio.TimeoutError:
            latency_ms = (time.time() - start_time) * 1000
            # Log timeout in trajectory
            if (
                traj_logger is not None
                and TrajectoryLoggerRuntimeService is not None
                and isinstance(traj_logger, TrajectoryLoggerRuntimeService)
                and trajectory_id
            ):
                await traj_logger.end_trajectory(trajectory_id, status="timeout")
            return [], "TIMEOUT", latency_ms
        except Exception as e:
            latency_ms = (time.time() - start_time) * 1000
            logger.error(f"Query failed for {test_case.id}: {e}")
            # Log error in trajectory
            if (
                traj_logger is not None
                and TrajectoryLoggerRuntimeService is not None
                and isinstance(traj_logger, TrajectoryLoggerRuntimeService)
                and trajectory_id
            ):
                await traj_logger.end_trajectory(
                    trajectory_id, status="error", final_metrics={"error": str(e)[:2000]}
                )
            return [], f"ERROR: {e}", latency_ms

    async def _execute_with_message_service(
        self,
        test_case: BFCLTestCase,
        timeout_ms: int,
    ) -> str:
        """
        Execute query using ElizaOS model handlers.
        
        For benchmarks, we use generate_text directly since:
        1. We don't need memory persistence (no database required)
        2. We handle function call parsing ourselves
        3. The benchmark evaluates raw function call output
        
        This still uses the full ElizaOS model handler system with:
        - Character system prompts
        - Model provider plugins (Groq, OpenAI, etc.)
        - Provider-injected context (via the prompt)
        """
        # Use compose_state approach which works without database
        return await self._execute_with_compose_state(test_case, timeout_ms)

    async def _execute_with_compose_state(
        self,
        test_case: BFCLTestCase,
        timeout_ms: int,
    ) -> str:
        """
        Execute using ElizaOS providers and model handlers.
        
        For benchmarks we don't need database persistence, so we:
        1. Build context from the BFCL functions (already in test_case)
        2. Add the character system prompt
        3. Call generate_text through the registered model handler
        
        This uses the full ElizaOS model handler (Groq, OpenAI, etc.) and
        respects the character configuration.
        """
        from elizaos.types.model import GenerateTextOptions
        
        timeout_seconds = timeout_ms / 1000
        
        # Build the full prompt with:
        # 1. Character system prompt
        # 2. BFCL function definitions  
        # 3. User query
        prompt = self._build_full_prompt(test_case)
        
        # Generate response using the ElizaOS model handler
        options = GenerateTextOptions(
            temperature=self.config.temperature,
            system=self.character.system if self.character else None,
        )
        result = await asyncio.wait_for(
            self.runtime.generate_text(prompt, options=options),
            timeout=timeout_seconds,
        )
        
        return result.text if result else ""
    
    def _build_full_prompt(self, test_case: BFCLTestCase) -> str:
        """
        Build a complete prompt with:
        - Character info (from bootstrap CHARACTER provider concept)
        - BFCL function definitions (from our BFCL_FUNCTIONS provider)
        - User query
        """
        # Get function definitions in OpenAI tools format
        tools = generate_openai_tools_format(test_case.functions)
        
        parts = [
            "# Available Functions for This Query",
            "",
            "You have access to the following functions. Analyze the user's request and call the appropriate function(s).",
            "",
            "```json",
            str(tools),
            "```",
            "",
            "# User Query",
            "",
            test_case.question,
            "",
            "# Instructions",
            "",
            "Based on the available functions and the user's query:",
            "1. Identify which function(s) should be called",
            "2. Extract the required argument values from the query",
            "3. Respond with a valid JSON function call",
            "",
            "Response format for single function:",
            '{"name": "function_name", "arguments": {"param1": value1, "param2": value2}}',
            "",
            "Response format for multiple functions:",
            '[{"name": "func1", "arguments": {...}}, {"name": "func2", "arguments": {...}}]',
            "",
            "IMPORTANT: Numbers should be numbers (not strings), booleans should be true/false (not strings).",
            "Respond ONLY with the JSON function call, no other text.",
        ]
        
        return "\n".join(parts)

    async def _execute_mock(self, test_case: BFCLTestCase) -> str:
        """Execute query in mock mode (no ElizaOS runtime)."""
        logger.debug(f"Mock execution for {test_case.id}")
        return f"MOCK_MODE: Test case {test_case.id}"

    def _extract_function_calls(
        self,
        response: str,
        test_case: BFCLTestCase,
    ) -> list[FunctionCall]:
        """Extract function calls from captured calls or response text."""
        # First check captured calls (from BFCL_CALL action handler)
        captured = get_call_capture().get_calls()
        if captured:
            return captured

        # Fall back to parsing response text
        return self.parser.parse(response)

    def update_trajectory_reward(
        self,
        test_case_id: str,
        reward: float,
        ast_match: bool,
        exec_match: bool,
    ) -> None:
        """
        Update the reward for a trajectory after evaluation.
        
        Called by the runner after comparing predicted vs expected calls.
        
        Args:
            test_case_id: The test case ID (matches episode_id in trajectory)
            reward: The computed reward (0.0 - 1.0)
            ast_match: Whether the AST matched
            exec_match: Whether execution matched
        """
        trajectories = self.get_trajectories()
        if not trajectories:
            return

        for traj in trajectories:
            episode_id = getattr(traj, "episode_id", None)
            if episode_id != test_case_id:
                continue

            # Best-effort update. Trajectory objects are expected to be plugin models,
            # but we avoid hard dependencies here.
            if hasattr(traj, "total_reward"):
                try:
                    setattr(traj, "total_reward", reward)
                except Exception:
                    pass

            metadata_obj = getattr(traj, "metadata", None)
            if isinstance(metadata_obj, dict):
                metadata_obj["ast_match"] = ast_match
                metadata_obj["exec_match"] = exec_match
                metadata_obj["evaluated"] = True
                break
    
    def get_trajectories(self) -> list[object]:
        """Get all collected trajectories for export."""
        if ELIZAOS_AVAILABLE and self.runtime is not None and TRAJECTORY_LOGGER_AVAILABLE:
            svc = self.runtime.get_service("trajectory_logger")
            if (
                TrajectoryLoggerRuntimeService is not None
                and isinstance(svc, TrajectoryLoggerRuntimeService)
                and hasattr(svc, "get_all_trajectories")
            ):
                get_all = getattr(svc, "get_all_trajectories", None)
                if callable(get_all):
                    try:
                        return list(get_all())
                    except Exception:
                        pass

        return self._trajectories
    
    def export_trajectories(
        self,
        output_path: str,
        format: str = "art",
    ) -> Optional[str]:
        """
        Export collected trajectories for training.
        
        Args:
            output_path: Path to save the exported data
            format: Export format ("art" for OpenPipe ART, "jsonl" for raw JSONL)
            
        Returns:
            Path to the exported file, or None if export failed
        """
        if not self._trajectories:
            logger.warning("No trajectories to export")
            return None
            
        if not TRAJECTORY_LOGGER_AVAILABLE:
            logger.warning("Trajectory logger not available for export")
            return None
        
        try:
            if format in ("art", "grpo") and ELIZAOS_AVAILABLE and self.runtime is not None:
                svc = self.runtime.get_service("trajectory_logger")
                if (
                    TrajectoryLoggerRuntimeService is not None
                    and isinstance(svc, TrajectoryLoggerRuntimeService)
                    and TrajectoryExportConfig is not None
                ):
                    trajectories = self.get_trajectories()
                    res = svc.export(
                        TrajectoryExportConfig(
                            dataset_name=Path(output_path).stem,
                            export_format="art" if format == "art" else "grpo",
                            output_dir=str(Path(output_path).parent),
                            max_trajectories=len(trajectories) if trajectories else None,
                        )
                    )
                    logger.info(f"Exported trajectories via service to {res.dataset_url}")
                    return res.dataset_url

            # Fallback: write raw jsonl (best-effort) if model objects are serializable.
            import json

            with open(output_path, "w") as f:
                for traj in self.get_trajectories():
                    if hasattr(traj, "model_dump") and callable(getattr(traj, "model_dump")):
                        f.write(json.dumps(traj.model_dump()) + "\n")
                    else:
                        try:
                            f.write(json.dumps(traj) + "\n")
                        except TypeError:
                            f.write(json.dumps({"trajectory": str(traj)[:2000]}) + "\n")

            logger.info(f"Exported {len(self.get_trajectories())} trajectories to {output_path}")
            return output_path
                
        except Exception as e:
            logger.error(f"Failed to export trajectories: {e}")
            return None
    
    async def close(self) -> None:
        """Clean up agent resources."""
        if self.runtime:
            await self.runtime.stop()
        self._initialized = False
        logger.info("BFCL agent closed")


class MockBFCLAgent:
    """
    Mock agent for testing benchmark infrastructure without ElizaOS.

    Returns expected calls to verify the benchmark harness works correctly.
    """

    def __init__(self, config: BFCLConfig):
        self.config = config
        self._model_name = "mock"

    @property
    def model_name(self) -> Optional[str]:
        return self._model_name

    async def initialize(self) -> None:
        """No-op initialization."""
        pass

    async def setup_test_case(self, test_case: BFCLTestCase) -> None:
        """No-op setup."""
        pass

    async def query(
        self,
        test_case: BFCLTestCase,
        timeout_ms: Optional[int] = None,
    ) -> tuple[list[FunctionCall], str, float]:
        """Return expected calls for testing."""
        import random
        
        # Simulate some latency
        latency = random.uniform(100, 200)
        
        # Return expected calls (for perfect accuracy in mock mode)
        return test_case.expected_calls, "MOCK_RESPONSE", latency

    async def close(self) -> None:
        """No-op cleanup."""
        pass
