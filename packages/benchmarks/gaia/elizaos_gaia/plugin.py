"""
GAIA Benchmark ElizaOS Plugin

Provides proper ElizaOS integration for the GAIA benchmark with:
- Multi-provider model support (Groq, OpenAI, Anthropic, etc.)
- Actions for tool execution (web_search, browse, calculate, etc.)
- Provider for question context
- Evaluator for answer validation
"""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING

from elizaos_gaia.providers import (
    ModelConfig,
    ModelProvider,
    call_provider,
    get_default_config,
)
from elizaos_gaia.tools import (
    Calculator,
    CodeExecutor,
    FileProcessor,
    WebBrowserTool,
    WebSearchTool,
)

if TYPE_CHECKING:
    from elizaos.runtime import AgentRuntime
    from elizaos.types.plugin import Plugin

logger = logging.getLogger(__name__)

# Shared tool instances (initialized on plugin load)
_web_search: WebSearchTool | None = None
_web_browser: WebBrowserTool | None = None
_file_processor: FileProcessor | None = None
_code_executor: CodeExecutor | None = None
_calculator: Calculator | None = None


async def close_gaia_plugin_tools() -> None:
    """Close any lazily-created tool instances held by this plugin."""
    global _web_search, _web_browser, _file_processor, _code_executor, _calculator

    if _web_search is not None:
        try:
            await _web_search.close()
        finally:
            _web_search = None

    if _web_browser is not None:
        try:
            await _web_browser.close()
        finally:
            _web_browser = None

    # FileProcessor doesn't currently hold resources, but reset for cleanliness.
    _file_processor = None
    _code_executor = None
    _calculator = None


async def multi_provider_model_handler(
    runtime: AgentRuntime,
    params: dict[str, object],
) -> str:
    """
    Multi-provider model handler for TEXT_LARGE and TEXT_SMALL requests.

    Supports: Groq (default), OpenAI, Anthropic, Ollama, LocalAI,
    OpenRouter, Google GenAI, XAI

    Args:
        runtime: The agent runtime
        params: Parameters including 'prompt' or 'messages', 'temperature', etc.

    Returns:
        Generated text response
    """
    # Build messages from params
    messages: list[dict[str, str]] = []

    if "messages" in params and isinstance(params["messages"], list):
        messages = params["messages"]  # type: ignore
    else:
        # Build messages from prompt/system
        system = params.get("system")
        if system:
            messages.append({"role": "system", "content": str(system)})

        prompt = params.get("prompt")
        if prompt:
            messages.append({"role": "user", "content": str(prompt)})

    if not messages:
        raise ValueError("No messages or prompt provided to model handler")

    # Determine provider and model
    provider_str = params.get("provider")
    model_name = str(params.get("model", ""))

    # Allow runtime settings to provide defaults (used by canonical runtime benchmark runs)
    runtime_provider = runtime.get_setting("GAIA_PROVIDER")
    runtime_model = runtime.get_setting("GAIA_MODEL")
    runtime_temperature = runtime.get_setting("GAIA_TEMPERATURE")
    runtime_max_tokens = runtime.get_setting("GAIA_MAX_TOKENS")

    if not provider_str and isinstance(runtime_provider, str) and runtime_provider.strip():
        provider_str = runtime_provider.strip()
    if not model_name and isinstance(runtime_model, str) and runtime_model.strip():
        model_name = runtime_model.strip()

    # Resolve temperature/max tokens with precedence:
    # - For canonical runtime usage, we prefer runtime settings (benchmark config)
    # - Otherwise, fall back to params or defaults
    temp_default = 0.7
    max_tokens_default = 4096
    has_runtime_temp = runtime_temperature is not None
    has_runtime_max_tokens = runtime_max_tokens is not None

    if isinstance(runtime_temperature, (int, float)) and not isinstance(runtime_temperature, bool):
        temp_default = float(runtime_temperature)
    if isinstance(runtime_temperature, str):
        try:
            temp_default = float(runtime_temperature)
            has_runtime_temp = True
        except ValueError:
            pass

    if isinstance(runtime_max_tokens, int) and not isinstance(runtime_max_tokens, bool):
        max_tokens_default = int(runtime_max_tokens)
    if isinstance(runtime_max_tokens, float) and not isinstance(runtime_max_tokens, bool):
        max_tokens_default = int(runtime_max_tokens)
    if isinstance(runtime_max_tokens, str):
        try:
            max_tokens_default = int(float(runtime_max_tokens))
            has_runtime_max_tokens = True
        except ValueError:
            pass

    temperature = temp_default if has_runtime_temp else float(params.get("temperature", temp_default))
    max_tokens = (
        max_tokens_default
        if has_runtime_max_tokens
        else int(params.get("max_tokens", params.get("maxTokens", max_tokens_default)))
    )

    if provider_str and model_name:
        # Explicit provider and model
        model_config = ModelConfig.from_model_string(
            f"{provider_str}/{model_name}",
            temperature=temperature,
            max_tokens=max_tokens,
        )
    elif model_name:
        # Just model name - infer provider
        model_config = ModelConfig.from_model_string(
            model_name,
            temperature=temperature,
            max_tokens=max_tokens,
        )
    else:
        # Use default configuration based on available API keys
        model_config = get_default_config()
        model_config.temperature = temperature
        model_config.max_tokens = max_tokens

    # Try to get API key from runtime settings if not in environment
    if not model_config.effective_api_key:
        env_var_map = {
            ModelProvider.GROQ: "GROQ_API_KEY",
            ModelProvider.OPENAI: "OPENAI_API_KEY",
            ModelProvider.ANTHROPIC: "ANTHROPIC_API_KEY",
            ModelProvider.OPENROUTER: "OPENROUTER_API_KEY",
            ModelProvider.GOOGLE: "GOOGLE_API_KEY",
            ModelProvider.XAI: "XAI_API_KEY",
        }
        env_var = env_var_map.get(model_config.provider)
        if env_var:
            key_from_runtime = runtime.get_setting(env_var)
            if isinstance(key_from_runtime, str):
                model_config.api_key = key_from_runtime

    # Call the provider
    response_text, tokens = await call_provider(model_config, messages)

    # Track token usage on the runtime for benchmark accounting
    try:
        prev_total = getattr(runtime, "_gaia_total_tokens", 0)
        if isinstance(prev_total, int):
            setattr(runtime, "_gaia_total_tokens", prev_total + int(tokens))
        else:
            setattr(runtime, "_gaia_total_tokens", int(tokens))
        setattr(runtime, "_gaia_last_tokens", int(tokens))
    except Exception:
        # Never fail the request due to accounting
        pass

    return response_text


def create_gaia_actions() -> list:
    """
    Create ElizaOS Action objects for GAIA tools.

    These actions wrap the tool implementations and make them available
    through the standard ElizaOS action framework.
    """
    from elizaos.types.components import (
        Action,
        ActionParameter,
        ActionParameterSchema,
        ActionResult,
        HandlerCallback,
        HandlerOptions,
    )
    from elizaos.types.memory import Memory
    from elizaos.types.state import State

    actions: list[Action] = []

    # Web Search Action
    async def web_search_validate(
        runtime: AgentRuntime,
        message: Memory,
        state: State | None = None,
    ) -> bool:
        return True

    async def web_search_handler(
        runtime: AgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        global _web_search
        if _web_search is None:
            api_key = os.getenv("SERPER_API_KEY")
            _web_search = WebSearchTool(
                api_key=api_key,
                engine="serper" if api_key else "duckduckgo",
            )

        query = ""
        if options and options.parameters:
            query = str(options.parameters.get("query", ""))

        if not query and message.content and message.content.text:
            query = message.content.text

        result = await _web_search.search(query)

        if result.success:
            output = f"Found {len(result.results)} results:\n"
            for r in result.results[:5]:
                output += f"\n{r.position}. {r.title}\n   {r.url}\n   {r.snippet}\n"

            return ActionResult(
                text=output,
                data={"actionName": "WEB_SEARCH", "results": len(result.results)},
                success=True,
            )
        else:
            return ActionResult(
                text=f"Search failed: {result.error}",
                error=result.error,
                success=False,
            )

    actions.append(Action(
        name="WEB_SEARCH",
        description="Search the web for information using a query string",
        similes=["search", "google", "look up", "find online"],
        handler=web_search_handler,
        validate=web_search_validate,
        parameters=[
            ActionParameter(
                name="query",
                description="The search query to execute",
                required=True,
                schema=ActionParameterSchema(type="string"),
            ),
        ],
    ))

    # Web Browse Action
    async def browse_validate(
        runtime: AgentRuntime,
        message: Memory,
        state: State | None = None,
    ) -> bool:
        return True

    async def browse_handler(
        runtime: AgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        global _web_browser
        if _web_browser is None:
            _web_browser = WebBrowserTool()

        url = ""
        if options and options.parameters:
            url = str(options.parameters.get("url", ""))

        result = await _web_browser.navigate(url)

        if result.success:
            return ActionResult(
                text=f"Title: {result.title}\n\nContent:\n{result.text[:5000]}",
                data={"actionName": "BROWSE", "url": url},
                success=True,
            )
        else:
            return ActionResult(
                text=f"Browse failed: {result.error}",
                error=result.error,
                success=False,
            )

    actions.append(Action(
        name="BROWSE",
        description="Navigate to a URL and extract the page content",
        similes=["navigate", "open url", "visit website", "go to"],
        handler=browse_handler,
        validate=browse_validate,
        parameters=[
            ActionParameter(
                name="url",
                description="The URL to navigate to",
                required=True,
                schema=ActionParameterSchema(type="string"),
            ),
        ],
    ))

    # Calculate Action
    async def calculate_validate(
        runtime: AgentRuntime,
        message: Memory,
        state: State | None = None,
    ) -> bool:
        return True

    async def calculate_handler(
        runtime: AgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        global _calculator
        if _calculator is None:
            _calculator = Calculator()

        expression = ""
        if options and options.parameters:
            expression = str(options.parameters.get("expression", ""))

        result = _calculator.calculate(expression)

        if result.success:
            return ActionResult(
                text=f"Result: {result.formatted}",
                data={"actionName": "CALCULATE", "result": result.result},
                success=True,
            )
        else:
            return ActionResult(
                text=f"Calculation failed: {result.error}",
                error=result.error,
                success=False,
            )

    actions.append(Action(
        name="CALCULATE",
        description="Evaluate a mathematical expression",
        similes=["compute", "math", "evaluate", "solve"],
        handler=calculate_handler,
        validate=calculate_validate,
        parameters=[
            ActionParameter(
                name="expression",
                description="The mathematical expression to evaluate",
                required=True,
                schema=ActionParameterSchema(type="string"),
            ),
        ],
    ))

    # Execute Code Action
    async def code_validate(
        runtime: AgentRuntime,
        message: Memory,
        state: State | None = None,
    ) -> bool:
        return True

    async def code_handler(
        runtime: AgentRuntime,
        message: Memory,
        state: State | None = None,
        options: HandlerOptions | None = None,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> ActionResult:
        global _code_executor
        if _code_executor is None:
            _code_executor = CodeExecutor(timeout_seconds=30)

        code = ""
        if options and options.parameters:
            code = str(options.parameters.get("code", ""))

        result = await _code_executor.execute_python(code)
        output = _code_executor.format_result(result)

        return ActionResult(
            text=output,
            data={"actionName": "EXECUTE_CODE", "success": result.success},
            success=result.success,
            error=result.error if not result.success else None,
        )

    actions.append(Action(
        name="EXECUTE_CODE",
        description="Execute Python code and return the output",
        similes=["run code", "python", "execute", "run script"],
        handler=code_handler,
        validate=code_validate,
        parameters=[
            ActionParameter(
                name="code",
                description="The Python code to execute",
                required=True,
                schema=ActionParameterSchema(type="string"),
            ),
        ],
    ))

    return actions


def create_gaia_plugin(
    enable_web_search: bool = True,
    enable_web_browse: bool = True,
    enable_code_execution: bool = True,
    enable_calculator: bool = True,
) -> Plugin:
    """
    Create the GAIA benchmark ElizaOS plugin.

    This plugin provides:
    - OpenAI model handler for TEXT_LARGE
    - Actions for web search, browsing, calculation, and code execution

    Args:
        enable_web_search: Enable web search action
        enable_web_browse: Enable web browse action
        enable_code_execution: Enable code execution action
        enable_calculator: Enable calculator action

    Returns:
        Plugin configured for GAIA benchmark
    """
    from elizaos.types.model import ModelType
    from elizaos.types.plugin import Plugin

    actions = create_gaia_actions()

    # Filter actions based on configuration
    filtered_actions = []
    for action in actions:
        if action.name == "WEB_SEARCH" and enable_web_search:
            filtered_actions.append(action)
        elif action.name == "BROWSE" and enable_web_browse:
            filtered_actions.append(action)
        elif action.name == "EXECUTE_CODE" and enable_code_execution:
            filtered_actions.append(action)
        elif action.name == "CALCULATE" and enable_calculator:
            filtered_actions.append(action)

    async def init_plugin(
        config: dict[str, str | int | float | bool | None],
        runtime: AgentRuntime,
    ) -> None:
        """Initialize the GAIA plugin."""
        runtime.logger.info("Initializing GAIA benchmark plugin")

        # Check for any available API keys
        available_keys = []
        key_checks = [
            ("GROQ_API_KEY", "Groq"),
            ("OPENAI_API_KEY", "OpenAI"),
            ("ANTHROPIC_API_KEY", "Anthropic"),
            ("OPENROUTER_API_KEY", "OpenRouter"),
            ("GOOGLE_API_KEY", "Google"),
            ("XAI_API_KEY", "XAI"),
        ]

        for key, name in key_checks:
            if os.getenv(key) or runtime.get_setting(key):
                available_keys.append(name)

        if not available_keys:
            runtime.logger.warning(
                "No LLM API keys found. Set one of: GROQ_API_KEY, OPENAI_API_KEY, "
                "ANTHROPIC_API_KEY, OPENROUTER_API_KEY, GOOGLE_API_KEY, or XAI_API_KEY. "
                "Ollama can be used for local models without a key."
            )
        else:
            runtime.logger.info(f"Available providers: {', '.join(available_keys)}")

        runtime.logger.info(
            "GAIA plugin initialized",
            actionCount=len(filtered_actions),
        )

    return Plugin(
        name="gaia-benchmark",
        description="GAIA Benchmark plugin for evaluating AI assistants on real-world tasks",
        init=init_plugin,
        config={},
        actions=filtered_actions,
        models={
            ModelType.TEXT_LARGE: multi_provider_model_handler,
            ModelType.TEXT_SMALL: multi_provider_model_handler,
        },
    )


# Default plugin instance
gaia_plugin = create_gaia_plugin()
