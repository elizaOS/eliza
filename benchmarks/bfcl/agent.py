"""
BFCL Agent Wrapper - Full ElizaOS Integration

Uses the canonical ElizaOS runtime with:
- message_service.handle_message() for full pipeline
- Actions registered for BFCL functions  
- Providers giving context
- Basic capabilities enabled (default)

This is NOT a bypass - it uses the full ElizaOS agent flow.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
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
                logger.warning("Anthropic plugin not fully installed")
        
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
        from elizaos.types.runtime import IAgentRuntime
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
            runtime: IAgentRuntime,
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
            runtime: IAgentRuntime,
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
                ModelType.TEXT_LARGE.value: text_large_handler,
                ModelType.TEXT_SMALL.value: text_small_handler,
            },
        )
    
    except ImportError as e:
        logger.warning(f"Failed to create Groq plugin: {e}")
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

            # Create runtime with model plugin and bootstrap (basic capabilities)
            # disable_basic_capabilities=False is the default - ensures full agent pipeline
            self.runtime = AgentRuntime(
                character=self.character,
                plugins=[self.model_plugin],
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
        
        bfcl_call_action = Action(
            name="BFCL_CALL",
            description="Make function calls for BFCL benchmark evaluation. Use this action to call any of the available BFCL functions.",
            similes=["CALL_FUNCTION", "INVOKE_FUNCTION", "EXECUTE_FUNCTION"],
            validate=bfcl_call_validate,
            handler=bfcl_call_handler,
            examples=[
                [
                    {
                        "name": "{{user}}",
                        "content": {"text": "What's the weather in San Francisco?"},
                    },
                    {
                        "name": "{{agentName}}",
                        "content": {
                            "text": "I'll check the weather for you.",
                            "actions": ["BFCL_CALL"],
                        },
                    },
                ],
            ],
            parameters=[
                {
                    "name": "calls",
                    "type": "array",
                    "description": "Array of function calls to make",
                    "required": True,
                },
                {
                    "name": "reason",
                    "type": "string",
                    "description": "Reason if no function call is appropriate",
                    "required": False,
                },
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

        try:
            # Set up test case (registers BFCL action and provider)
            await self.setup_test_case(test_case)

            # Execute based on runtime availability
            if ELIZAOS_AVAILABLE and self.runtime and self._has_model_provider:
                response = await self._execute_with_message_service(
                    test_case, timeout_ms
                )
            else:
                response = await self._execute_mock(test_case)

            latency_ms = (time.time() - start_time) * 1000

            # Extract function calls from captured calls or response
            predicted_calls = self._extract_function_calls(response, test_case)

            return predicted_calls, response, latency_ms

        except asyncio.TimeoutError:
            latency_ms = (time.time() - start_time) * 1000
            return [], "TIMEOUT", latency_ms
        except Exception as e:
            latency_ms = (time.time() - start_time) * 1000
            logger.error(f"Query failed for {test_case.id}: {e}")
            return [], f"ERROR: {e}", latency_ms

    async def _execute_with_message_service(
        self,
        test_case: BFCLTestCase,
        timeout_ms: int,
    ) -> str:
        """
        Execute query using the FULL ElizaOS message service pipeline.
        
        This is the canonical ElizaOS flow:
        1. Create a Memory for the user message
        2. Call message_service.handle_message()
        3. This triggers: compose_state -> providers -> LLM -> actions -> response
        """
        timeout_seconds = timeout_ms / 1000
        
        # Create user message Memory
        message = Memory(
            id=string_to_uuid(f"bfcl_msg_{test_case.id}_{time.time()}"),
            entity_id=self._entity_id,
            room_id=self._room_id,
            agent_id=self.runtime.agent_id,
            content=Content(
                text=test_case.question,
                source="bfcl_benchmark",
            ),
        )
        
        # Capture response through callback
        response_text = ""
        
        async def response_callback(content: Content) -> list[Memory]:
            nonlocal response_text
            if content and content.text:
                response_text = content.text
            return []
        
        # Use message service if available (full pipeline)
        if hasattr(self.runtime, 'message_service') and self.runtime.message_service:
            await asyncio.wait_for(
                self.runtime.message_service.handle_message(
                    self.runtime,
                    message,
                    response_callback,
                ),
                timeout=timeout_seconds,
            )
        else:
            # Fallback: use simplified flow with compose_state
            response_text = await self._execute_with_compose_state(
                test_case, timeout_ms
            )
        
        return response_text

    async def _execute_with_compose_state(
        self,
        test_case: BFCLTestCase,
        timeout_ms: int,
    ) -> str:
        """
        Fallback execution using compose_state for context.
        
        This still uses the provider system but without full message service.
        """
        from elizaos.types.model import GenerateTextOptions
        
        timeout_seconds = timeout_ms / 1000
        
        # Create message for state composition
        message = Memory(
            id=string_to_uuid(f"bfcl_msg_{test_case.id}"),
            entity_id=self._entity_id,
            room_id=self._room_id,
            agent_id=self.runtime.agent_id,
            content=Content(text=test_case.question, source="bfcl"),
        )
        
        # Compose state - this runs all providers including BFCL_FUNCTIONS
        state = await self.runtime.compose_state(message)
        
        # Build prompt from state (includes provider context)
        prompt = self._build_prompt_from_state(state, test_case)
        
        # Generate response
        options = GenerateTextOptions(temperature=self.config.temperature)
        result = await asyncio.wait_for(
            self.runtime.generate_text(prompt, options=options),
            timeout=timeout_seconds,
        )
        
        return result.text if result else ""

    def _build_prompt_from_state(
        self,
        state: State,
        test_case: BFCLTestCase,
    ) -> str:
        """Build prompt including provider context from state."""
        # Get provider context
        provider_text = state.text if hasattr(state, 'text') and state.text else ""
        
        # Build prompt with function context
        tools = generate_openai_tools_format(test_case.functions)
        
        parts = [
            provider_text,
            "",
            "# Available Functions",
            "```json",
            str(tools),
            "```",
            "",
            "# User Query",
            test_case.question,
            "",
            "# Instructions",
            "Analyze the query and respond with function calls in JSON format:",
            '{"name": "function_name", "arguments": {"arg1": value1}}',
            "",
            "For multiple calls, use an array. Respond ONLY with valid JSON.",
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
