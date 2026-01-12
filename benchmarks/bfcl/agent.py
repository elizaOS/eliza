"""
BFCL Agent Wrapper

Wraps the ElizaOS runtime to handle BFCL benchmark queries.

This module integrates with ElizaOS to run BFCL benchmarks using real LLM providers.
It supports OpenAI, Anthropic, and other model providers via the plugin system.
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


# Import ElizaOS types - optional dependency
try:
    from elizaos.runtime import AgentRuntime
    from elizaos.types.agent import Character
    from elizaos.types.memory import Memory
    from elizaos.types.model import GenerateTextOptions
    from elizaos.types.plugin import Plugin
    from elizaos.types.primitives import Content, string_to_uuid

    ELIZAOS_AVAILABLE = True
except ImportError:
    AgentRuntime = None  # type: ignore[misc, assignment]
    Character = None  # type: ignore[misc, assignment]
    Memory = None  # type: ignore[misc, assignment]
    GenerateTextOptions = None  # type: ignore[misc, assignment]
    Plugin = None  # type: ignore[misc, assignment]
    Content = None  # type: ignore[misc, assignment]
    string_to_uuid = None  # type: ignore[misc, assignment]
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
            # LocalAI doesn't have elizaos integration, would need custom
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
    Agent wrapper for BFCL benchmark execution.

    Handles:
    - Runtime initialization with benchmark functions
    - Query execution with function context
    - Response parsing for function calls
    
    Architecture:
    - Uses ElizaOS AgentRuntime for LLM interaction
    - Supports multiple model providers: Groq (default), OpenAI, Anthropic, etc.
    - Dynamically registers BFCL test functions as ElizaOS Actions
    - Parses function calls from LLM responses
    
    Default Model:
    - Groq with llama-3.1-8b-instant (fast and efficient for function calling)
    - Can be overridden via BFCL_MODEL or BFCL_PROVIDER env vars
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
        Initialize BFCL agent.

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
        self._model_name: Optional[str] = None  # Track which model is being used

    async def initialize(self) -> None:
        """
        Initialize the agent runtime.
        
        This sets up:
        1. The ElizaOS AgentRuntime with a character configuration
        2. A model provider plugin (Groq default, or other providers)
        3. The bootstrap plugin for basic capabilities
        
        Default model: Groq llama-3.1-8b-instant (fast, efficient for function calling)
        Override with BFCL_MODEL or BFCL_PROVIDER env vars, or constructor args.
        
        Raises:
            RuntimeError: If no model provider is available
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
            # Create default character for benchmark
            if self.character is None:
                self.character = Character(
                    name="BFCLBenchmarkAgent",
                    bio="An AI agent specialized in function calling for BFCL benchmark evaluation.",
                    system="""You are a function-calling AI assistant being evaluated on the Berkeley Function-Calling Leaderboard (BFCL).

Your task is to analyze user queries and determine which function(s) to call with what arguments.

CRITICAL INSTRUCTIONS:
1. Carefully read the available functions, their descriptions, and ALL parameters
2. Match the user's intent to the most appropriate function(s)
3. Extract the correct argument values from the query
4. ALWAYS include ALL parameters in your response, including optional ones:
   - If a parameter has a default value specified, use that default
   - If a parameter is optional without a default, use sensible defaults:
     - For integers: 0
     - For floats: 0.0
     - For strings: ""
     - For booleans: false
     - For arrays: []
     - For objects: {}
5. Use correct types - numbers should be numbers (not strings), booleans should be booleans
6. If multiple functions are needed, call them all in a JSON array
7. If no function is relevant, respond with: {"no_function": true, "reason": "..."}

RESPONSE FORMAT:
- For single function: {"name": "function_name", "arguments": {"arg1": value1, "arg2": value2}}
- For multiple functions: [{"name": "func1", "arguments": {...}}, {"name": "func2", "arguments": {...}}]
- For no applicable function: {"no_function": true, "reason": "explanation"}

IMPORTANT:
- Numbers should NOT be quoted: use 100 not "100"
- Booleans should be true/false not "true"/"false"
- Always respond ONLY with valid JSON. No additional text.""",
                )

            # Create runtime with plugins
            self.runtime = AgentRuntime(
                character=self.character,
                plugins=[self.model_plugin],
                log_level="INFO",
            )

        await self.runtime.initialize()
        self._has_model_provider = self.runtime.has_model("TEXT_LARGE")
        
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

        Registers the test case's functions as actions.
        """
        if not ELIZAOS_AVAILABLE or self.runtime is None:
            return

        # Clear previous call captures
        get_call_capture().clear()

        # Create and register plugin with test functions
        plugin = self.plugin_factory.create_plugin(test_case)
        await self.runtime.register_plugin(plugin)

        logger.debug(f"Set up test case {test_case.id} with {len(test_case.functions)} functions")

    async def query(
        self,
        test_case: BFCLTestCase,
        timeout_ms: Optional[int] = None,
    ) -> tuple[list[FunctionCall], str, float]:
        """
        Execute a query for a test case.

        Args:
            test_case: The test case to execute
            timeout_ms: Optional timeout override

        Returns:
            Tuple of (predicted_calls, raw_response, latency_ms)
        """
        timeout = timeout_ms or self.config.timeout_per_test_ms
        start_time = time.time()

        try:
            # Set up the test case
            await self.setup_test_case(test_case)

            # Build prompt with function context
            prompt = self._build_prompt(test_case)

            # Execute query - use runtime if model is available, otherwise mock
            if ELIZAOS_AVAILABLE and self.runtime and self._has_model_provider:
                response = await self._execute_with_runtime(
                    prompt,
                    test_case,
                    timeout,
                )
            else:
                response = await self._execute_mock(prompt, test_case)

            # Calculate latency
            latency_ms = (time.time() - start_time) * 1000

            # Parse function calls from response
            predicted_calls = self._extract_function_calls(response, test_case)

            return predicted_calls, response, latency_ms

        except asyncio.TimeoutError:
            latency_ms = (time.time() - start_time) * 1000
            return [], "TIMEOUT", latency_ms
        except Exception as e:
            latency_ms = (time.time() - start_time) * 1000
            logger.error(f"Query failed for {test_case.id}: {e}")
            return [], f"ERROR: {e}", latency_ms

    def _build_prompt(self, test_case: BFCLTestCase) -> str:
        """Build the prompt with function context."""
        # Generate tools/functions JSON
        tools = generate_openai_tools_format(test_case.functions)

        prompt_parts = [
            "You are a function-calling assistant. Given the following available functions:",
            "",
            "```json",
            str(tools),
            "```",
            "",
            "User Query:",
            test_case.question,
            "",
            "If a function should be called, respond with the function call in JSON format:",
            '{"name": "function_name", "arguments": {"arg1": "value1"}}',
            "",
            "If multiple functions should be called, respond with a JSON array.",
            "If no function is relevant, explain why and do not make a function call.",
        ]

        return "\n".join(prompt_parts)

    async def _execute_with_runtime(
        self,
        prompt: str,
        test_case: BFCLTestCase,
        timeout_ms: int,
    ) -> str:
        """Execute query using ElizaOS runtime."""
        timeout_seconds = timeout_ms / 1000

        # Create options with proper type
        options = GenerateTextOptions(temperature=self.config.temperature)

        # Generate response using the runtime's model
        result = await asyncio.wait_for(
            self.runtime.generate_text(prompt, options=options),
            timeout=timeout_seconds,
        )

        return result.text if result else ""

    async def _execute_mock(
        self,
        prompt: str,
        test_case: BFCLTestCase,
    ) -> str:
        """Execute query in mock mode (no ElizaOS runtime)."""
        # In mock mode, we can't actually generate responses
        # This is useful for testing the benchmark infrastructure
        logger.debug(f"Mock execution for {test_case.id}")

        # Return a placeholder that indicates mock mode
        return f"MOCK_MODE: Test case {test_case.id}"

    def _extract_function_calls(
        self,
        response: str,
        test_case: BFCLTestCase,
    ) -> list[FunctionCall]:
        """Extract function calls from response."""
        # First check captured calls (from action handlers)
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

    Returns expected calls to verify benchmark correctness.
    """

    def __init__(self, config: BFCLConfig):
        self.config = config
        self.parser = FunctionCallParser()

    async def initialize(self) -> None:
        """No-op initialization."""
        pass

    async def setup_test_case(self, test_case: BFCLTestCase) -> None:
        """No-op setup."""
        pass

    async def query(
        self,
        test_case: BFCLTestCase,
        return_expected: bool = True,
        timeout_ms: Optional[int] = None,
    ) -> tuple[list[FunctionCall], str, float]:
        """
        Mock query that optionally returns expected calls.

        Args:
            test_case: The test case
            return_expected: If True, return the expected calls
            timeout_ms: Ignored in mock mode

        Returns:
            Tuple of (calls, response, latency_ms)
        """
        import random

        # Simulate some latency
        latency = random.uniform(50, 200)
        await asyncio.sleep(latency / 1000)

        if return_expected:
            return test_case.expected_calls, "MOCK_EXPECTED", latency
        else:
            return [], "MOCK_EMPTY", latency

    async def close(self) -> None:
        """No-op cleanup."""
        pass
