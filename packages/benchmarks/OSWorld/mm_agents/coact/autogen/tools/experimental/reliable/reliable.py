# Copyright (c) 2023 - 2025, AG2ai, Inc., AG2ai open-source projects maintainers and core contributors
#
# SPDX-License-Identifier: Apache-2.0
#
# Portions derived from  https://github.com/microsoft/autogen are under the MIT License.
# SPDX-License-Identifier: MIT

import asyncio
import contextlib
import copy
import functools
import inspect
import json
import logging
import time
import warnings
from typing import Annotated, Any, Callable, Dict, List, Optional, Tuple, Type, Union

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ....agentchat import ChatResult, initiate_group_chat
from ....agentchat.agent import Agent
from ....agentchat.conversable_agent import ConversableAgent
from ....agentchat.group import AgentTarget, ReplyResult, TerminateTarget
from ....agentchat.group.context_variables import ContextVariables
from ....agentchat.group.patterns import DefaultPattern
from ....doc_utils import export_module
from ....llm_config import LLMConfig
from ....tools.dependency_injection import Field as AG2Field
from ....tools.tool import Tool

__all__ = ("ReliableTool", "ReliableToolError", "SuccessfulExecutionParameters", "ToolExecutionDetails")

logger = logging.getLogger(__name__)

HYPOTHESIS_DESCRIPTION = (
    "A clear, concise statement about the expected outcome or result format of the function call "
    "based on the provided inputs. This helps in assessing the relevance and potential success "
    "of the call, and guides validation."
)


class ValidationResult(BaseModel):
    """Represents the outcome of a single validation step."""

    model_config = ConfigDict(extra="forbid")
    validation_result: bool
    justification: str

    def __str__(self) -> str:
        status = "Passed" if self.validation_result else "Failed"
        return f"Validation Result: {status}\nJustification: {self.justification}"

    def format(self) -> str:
        """Returns the JSON representation for AutoGen compatibility."""
        return self.model_dump_json()


class ExecutionAttempt(BaseModel):
    """Stores the state of a single attempt to execute and validate the function."""

    model_config = ConfigDict(arbitrary_types_allowed=True)
    timestamp: float = Field(default_factory=time.time)
    attempt_args: List[Any] = Field(default_factory=list)
    attempt_kwargs: Dict[str, Any] = Field(default_factory=dict)
    hypothesis: Optional[str] = None
    error: Optional[str] = None
    result_data: Optional[Any] = None
    result_str: Optional[str] = None
    validation: Optional[ValidationResult] = None

    @property
    def did_execute_successfully(self) -> bool:
        """Check if the attempt executed without raising an error."""
        return self.error is None

    @property
    def did_validate_successfully(self) -> bool:
        """Check if the attempt passed validation."""
        return self.validation is not None and self.validation.validation_result


class ReliableToolContext(BaseModel):
    """Main context object holding the overall state and history of attempts."""

    model_config = ConfigDict(arbitrary_types_allowed=True)
    task: str
    reliable_tool_name: str
    start_time: float = Field(default_factory=time.time)
    dynamic_validation_input: Optional[str] = None
    attempts: List[ExecutionAttempt] = Field(default_factory=list)
    initial_messages: Optional[List[dict[str, Any]]] = Field(
        default=None, description="Initial messages provided to the tool run."
    )
    initial_ground_truth: Optional[List[str]] = Field(
        default=None, description="Initial ground truth strings provided."
    )

    @property
    def attempt_count(self) -> int:
        """Return the number of attempts made."""
        return len(self.attempts)

    @property
    def latest_attempt(self) -> Optional[ExecutionAttempt]:
        """Return the most recent attempt, if any."""
        return self.attempts[-1] if self.attempts else None

    @property
    def is_complete_and_successful(self) -> bool:
        """Check if the process finished with a validated successful attempt."""
        latest = self.latest_attempt
        return latest is not None and latest.did_execute_successfully and latest.did_validate_successfully

    def get_final_result_data(self) -> Any:
        """Return the result_data from the successful and validated attempt."""
        if self.is_complete_and_successful and self.latest_attempt:
            return self.latest_attempt.result_data
        return None

    def get_final_result_str(self) -> Any:
        """Return the result_str from the successful and validated attempt."""
        if self.is_complete_and_successful and self.latest_attempt:
            return self.latest_attempt.result_str
        return None

    def get_failure_summary(self) -> str:
        """Provide a summary of why the overall execution failed."""
        latest = self.latest_attempt
        if latest is None:
            return "No execution attempts were made."
        if not latest.did_execute_successfully:
            return f"Execution failed: {latest.error}"
        if not latest.did_validate_successfully:
            justification = (
                latest.validation.justification if latest.validation else "Validation result missing or invalid"
            )
            return f"Execution succeeded but failed validation (Justification: {justification})"
        return "Execution completed but overall status indicates failure (Internal inconsistency)."


class SuccessfulExecutionParameters(BaseModel):
    """Holds the arguments of a successful tool function execution."""

    model_config = ConfigDict(arbitrary_types_allowed=True)
    attempt_args: List[Any]
    attempt_kwargs: Dict[str, Any]


class ToolExecutionDetails(BaseModel):
    """Provides detailed information about a ReliableTool execution."""

    model_config = ConfigDict(arbitrary_types_allowed=True)
    task: str
    is_overall_successful: bool
    failure_reason: Optional[str] = None
    successful_parameters: Optional[SuccessfulExecutionParameters] = None
    final_tool_context: ReliableToolContext


def _configure_llm_for_structured_output(
    llm_config: Optional[Union[LLMConfig, dict[str, Any]]], structured_output_type: Type[BaseModel]
) -> Union[LLMConfig, dict[str, Any]]:  # Return type changed, False is no longer a valid return
    """Configure LLM config for structured output using a Pydantic model."""
    if llm_config is None or llm_config is False:
        raise ValueError("LLMConfig cannot be None or False for structured output.")
    if not issubclass(structured_output_type, BaseModel):
        raise TypeError(f"{structured_output_type} must be a Pydantic BaseModel subclass.")

    llm_config_obj = ConversableAgent._validate_llm_config(llm_config)

    if llm_config_obj is False:  # Should not happen if input llm_config is not False
        raise ValueError("Validated LLMConfig resolved to False unexpectedly.")

    response_format_set = False

    def _set_format_and_remove_conflicts(config_item: Union[LLMConfig, Dict[str, Any]]) -> None:
        nonlocal response_format_set
        conflicting_keys = ["tools", "tool_choice", "functions"]
        removed_keys = []

        if isinstance(config_item, dict):
            config_item["response_format"] = structured_output_type
            response_format_set = True
            for key in conflicting_keys:
                if key in config_item:
                    del config_item[key]
                    removed_keys.append(key)
        elif hasattr(config_item, "response_format"):  # LLMConfig object
            setattr(config_item, "response_format", structured_output_type)
            response_format_set = True
            for key in conflicting_keys:
                if hasattr(config_item, key) and getattr(config_item, key, None):
                    # Try setting to None or empty list/dict as appropriate
                    default_empty: Optional[List[str]] = [] if key in ["tools", "functions"] else None
                    setattr(config_item, key, default_empty)
                    removed_keys.append(key)
        else:
            # This case implies llm_config_obj is an object not fitting LLMConfig ducktype for response_format
            # or not a dict, which should be caught by _validate_llm_config or earlier checks.
            raise TypeError(f"Unsupported LLM config item type for structured output: {type(config_item)}")

        if removed_keys:
            logger.debug(
                "Removed conflicting keys %s from LLM config for structured output (response_format=%s)",
                removed_keys,
                structured_output_type.__name__,
            )

    _set_format_and_remove_conflicts(llm_config_obj)

    if not response_format_set and not isinstance(llm_config_obj, dict):  # Double check if it's an object
        # if it's an object and response_format could not be set, it's an issue.
        # For dicts, it's assumed to be set by _set_format_and_remove_conflicts.
        raise ValueError(
            f"LLMConfig object type ({type(llm_config_obj).__name__}) "
            "could not have 'response_format' set. Structured output may fail."
        )

    # Handle config_list if present
    config_list_attr_name = "config_list"
    original_config_list = None

    if isinstance(llm_config_obj, dict):
        original_config_list = llm_config_obj.get(config_list_attr_name)
    elif hasattr(llm_config_obj, config_list_attr_name):
        original_config_list = getattr(llm_config_obj, config_list_attr_name, None)

    if isinstance(original_config_list, list):
        new_config_list = []
        for item in original_config_list:
            item_copy = copy.deepcopy(item)
            # Assuming items in config_list are dicts or LLMConfig-like objects
            _set_format_and_remove_conflicts(item_copy)
            new_config_list.append(item_copy)

        if isinstance(llm_config_obj, dict):
            llm_config_obj[config_list_attr_name] = new_config_list
        else:  # Must be an object if hasattr was true
            setattr(llm_config_obj, config_list_attr_name, new_config_list)

    logger.debug("Prepared LLM config for validator (response_format=%s)", structured_output_type.__name__)
    return llm_config_obj


def _get_last_non_empty_message_content(messages: Optional[List[dict[str, Any]]]) -> Optional[str]:
    """Get content of the last message with non-empty content."""
    if not messages:
        return None
    for message in reversed(messages):
        content = message.get("content")
        if isinstance(content, str) and content.strip():
            return content.strip()
        if isinstance(content, list) and content:  # Handle multimodal content
            # Prioritize text parts
            text_parts = [
                item["text"].strip()
                for item in content
                if isinstance(item, dict)
                and item.get("type") == "text"
                and isinstance(item.get("text"), str)
                and item["text"].strip()
            ]
            if text_parts:
                return "\n".join(text_parts)

            # If no text parts, serialize the first non-empty item
            for item in content:
                if item:  # Ensure item is not None or empty
                    if isinstance(item, dict):
                        return json.dumps(item)
                    else:
                        return str(item).strip()
    return None


def _get_reliable_tool_context(context_variables: ContextVariables, context_key: str) -> ReliableToolContext:
    """Retrieve and validate the ReliableToolContext from ContextVariables."""
    context_data = context_variables.get(context_key)
    if context_data is None:
        raise KeyError(f"ReliableToolContext key '{context_key}' not found in ContextVariables.")
    try:
        if isinstance(context_data, str):
            return ReliableToolContext.model_validate_json(context_data)
        raise TypeError(
            f"Unexpected type {type(context_data)} for context key '{context_key}'. Expected ReliableToolContext, str, or dict."
        )
    except (ValidationError, json.JSONDecodeError, TypeError) as e:
        preview = f" Preview: '{str(context_data)[:100]}...'" if isinstance(context_data, (str, dict)) else ""
        # Logged error level changed to warning as this function re-raises.
        logger.warning(
            "Failed loading ReliableToolContext '%s'. Error: %s. Type: %s.%s",
            context_key,
            e,
            type(context_data).__name__,
            preview,
        )
        raise ValueError(f"Failed loading ReliableToolContext key '{context_key}': {e}") from e


def _set_reliable_tool_context(
    context_variables: ContextVariables, context_key: str, context: ReliableToolContext
) -> None:
    """Serialize and store the ReliableToolContext in ContextVariables."""
    if not isinstance(context, ReliableToolContext):
        raise TypeError(f"Object to set must be a ReliableToolContext, got {type(context)}.")
    try:
        context_variables[context_key] = context.model_dump_json(warnings="warn")
    except (ValidationError, TypeError) as e:  # More specific exceptions
        context_dict_str = "N/A"
        try:  # Best effort to get some context info for logging
            context_dict_str = str(context.model_dump(warnings="warn", exclude={"attempts"}))[:500]
        except Exception:
            contextlib.suppress(Exception)
        logger.error(  # Log as error as this is a critical serialization failure
            "Failed serializing ReliableToolContext key '%s': %s. Context (partial): %s",
            context_key,
            e,
            context_dict_str,
        )
        raise ValueError(f"Critical error serializing ReliableToolContext: {e}") from e


def get_runner_prompt(task: str, agent_system_message: str, internal_tool_name: str) -> str:
    """Generate the system prompt for the internal runner agent."""
    return f"""
You are an AI assistant responsible for invoking a specific function based on the user's task and conversation history.
Function to call: '{internal_tool_name}'
Analyze the previous attempt's outcome (if any, visible in history) and adjust the function arguments accordingly for this retry. If this is the first attempt, determine the best initial arguments based on the task and initial context.

You MUST invoke the function '{internal_tool_name}' exactly one time per response using a tool call format that the system can execute.
Do NOT just output text explaining what you would do, or asking for confirmation. Directly make the tool call.
Analyze the task description and *full conversation history* carefully to determine the correct arguments for the function call.
You MUST provide a 'hypothesis' argument summarizing the expected outcome or result format of the function call based on the inputs.

Base Instructions:
{agent_system_message}

Current Task:
{task}
"""


def get_validator_prompt(
    task: str, base_validator_system_message: str, dynamic_validation_addition: Optional[str] = None
) -> str:
    """Generate the system prompt for the internal validator agent."""
    dynamic_section = (
        f"\n\nAdditional Dynamic Requirements for This Specific Run:\n{dynamic_validation_addition.strip()}"
        if dynamic_validation_addition and dynamic_validation_addition.strip()
        else ""
    )
    return f"""
You are an AI validation assistant. You will receive a curated message list containing:
1. Initial context messages (original request, potentially prior conversation).
2. Provided ground truth information (if any).
3. The final result of a function call intended to accomplish the task.

Your goal is to validate if the *final function call result* meets ALL requirements based on the *entire context provided in the message list*. Consider the base task description, base validation rules, initial context/ground truth, and any dynamic requirements below.

Evaluate the *final function call result* (presented at the end of the message list) based on *all* information provided.

Base Validation Rules/Context:
{base_validator_system_message}{dynamic_section}

Base Task Description (for reference):
{task}
"""


def reliable_function_wrapper(
    tool_function: Callable[..., Any], validator: ConversableAgent, runner: ConversableAgent, context_variables_key: str
) -> Callable[..., Any]:
    """Wraps the target function, returning a sync or async wrapper.

    Adds 'hypothesis' and 'context_variables' keyword-only arguments.
    Returns a ReplyResult targeting the validator.
    """
    is_original_func_async = inspect.iscoroutinefunction(tool_function)
    tool_sig = inspect.signature(tool_function)
    wrapper_func: Callable[..., Any]  # Declare type for wrapper_func

    def _handle_execution_error(
        attempt: ExecutionAttempt, context_vars: ContextVariables, context: ReliableToolContext, e: Exception
    ) -> ReplyResult:
        """Shared logic to handle tool_function execution error."""
        err_msg = f"{type(e).__name__}: {e}"
        logger.error(  # Log the error from the wrapped function
            "Wrapped function '%s' execution error: %s",
            getattr(tool_function, "__name__", "unknown_func"),
            err_msg,
            exc_info=True,  # Include traceback for wrapped function error
        )
        attempt.error = err_msg
        if attempt not in context.attempts:
            context.attempts.append(attempt)

        _set_reliable_tool_context(context_vars, context_variables_key, context)

        # Go to runner in this scenario because an error can just be handled by the runner again
        return ReplyResult(
            context_variables=context_vars,
            target=AgentTarget(runner),
            message=f"Function execution failed with error: {err_msg}.",
        )

    def _process_successful_execution(
        attempt: ExecutionAttempt, result: Any, context_vars: ContextVariables, context: ReliableToolContext
    ) -> ReplyResult:
        value_to_stringify: Any = None

        if isinstance(result, tuple):
            if len(result) >= 2:
                attempt.result_data = result[0]
                value_to_stringify = result[1]
            elif len(result) == 1:
                attempt.result_data = result[0]
                value_to_stringify = result[0]
            else:
                attempt.result_data = None
                value_to_stringify = ""

        else:
            attempt.result_data = result
            value_to_stringify = result

        try:
            attempt.result_str = str(value_to_stringify) if value_to_stringify is not None else ""
        except Exception as str_e:
            logger.warning(
                "Could not convert result string part to string, using repr() \n %s",
                str_e,
            )
            attempt.result_str = repr(value_to_stringify)

        if attempt not in context.attempts:
            context.attempts.append(attempt)

        _set_reliable_tool_context(context_vars, context_variables_key, context)

        return ReplyResult(
            context_variables=context_vars,
            target=AgentTarget(validator),
            message=attempt.result_str,
        )

    if not is_original_func_async:

        @functools.wraps(tool_function)
        def sync_wrapper(
            *args: Any, hypothesis: str, context_variables: ContextVariables, **kwargs: Any
        ) -> ReplyResult:
            context = _get_reliable_tool_context(context_variables, context_variables_key)
            attempt = ExecutionAttempt(attempt_args=list(args), attempt_kwargs=kwargs, hypothesis=hypothesis)
            try:
                result = tool_function(*args, **kwargs)
                return _process_successful_execution(attempt, result, context_variables, context)
            except Exception as e:
                return _handle_execution_error(attempt, context_variables, context, e)

        wrapper_func = sync_wrapper
    else:

        @functools.wraps(tool_function)
        async def async_wrapper(
            *args: Any, hypothesis: str, context_variables: ContextVariables, **kwargs: Any
        ) -> ReplyResult:
            context = _get_reliable_tool_context(context_variables, context_variables_key)
            attempt = ExecutionAttempt(attempt_args=list(args), attempt_kwargs=kwargs, hypothesis=hypothesis)
            try:
                result = await tool_function(*args, **kwargs)
                return _process_successful_execution(attempt, result, context_variables, context)
            except Exception as e:
                return _handle_execution_error(attempt, context_variables, context, e)

        wrapper_func = async_wrapper

    params = list(tool_sig.parameters.values())
    pos_or_kw_params, kw_only_params, var_pos_param, var_kw_param = [], [], None, None
    for p in params:
        if p.kind == inspect.Parameter.POSITIONAL_ONLY or p.kind == inspect.Parameter.POSITIONAL_OR_KEYWORD:
            pos_or_kw_params.append(p)
        elif p.kind == inspect.Parameter.VAR_POSITIONAL:
            var_pos_param = p
        elif p.kind == inspect.Parameter.KEYWORD_ONLY:
            kw_only_params.append(p)
        elif p.kind == inspect.Parameter.VAR_KEYWORD:
            var_kw_param = p

    new_kw_only_params = [
        inspect.Parameter(
            "hypothesis",
            inspect.Parameter.KEYWORD_ONLY,
            annotation=Annotated[str, AG2Field(description=HYPOTHESIS_DESCRIPTION)],
            default=inspect.Parameter.empty,
        ),
        inspect.Parameter(
            "context_variables",
            inspect.Parameter.KEYWORD_ONLY,
            annotation=ContextVariables,
            default=inspect.Parameter.empty,
        ),
    ]

    wrapper_params = (
        pos_or_kw_params
        + ([var_pos_param] if var_pos_param else [])
        + kw_only_params
        + new_kw_only_params
        + ([var_kw_param] if var_kw_param else [])
    )
    setattr(wrapper_func, "__signature__", inspect.Signature(parameters=wrapper_params, return_annotation=ReplyResult))
    return wrapper_func


@export_module("autogen.tools.experimental")
class ReliableToolError(Exception):
    """Custom exception for errors during ReliableTool execution."""

    def __init__(self, message: str, final_context: Optional[ReliableToolContext] = None):
        super().__init__(message)
        self.final_context = final_context


@export_module("autogen.tools.experimental")
class ReliableTool(Tool):
    INTERNAL_TOOL_NAME_PREFIX = "execute_"

    def __init__(
        self,
        name: str,
        func_or_tool: Union[Callable[..., Any], Tool],
        runner_llm_config: Union[LLMConfig, dict[str, Any]],
        validator_llm_config: Union[LLMConfig, dict[str, Any]],
        description: Optional[str] = None,
        system_message_addition_for_tool_calling: str = "",
        system_message_addition_for_result_validation: str = "",
        max_tool_invocations: int = 3,
        enable_dynamic_validation: bool = False,
        messages: Optional[List[dict[str, Any]]] = None,
        ground_truth: Optional[List[str]] = None,
    ) -> None:
        """
        A ReliableTool wraps an existing function or tool.
        When the ReliableTool is invoked, it kicks off an internal Group Chat where a Runner
        and Validator agent will iteratively invoke the wrapped function or tool until
        *the output of a single invocation of the original function or tool satisfies the provided validation criteria.*
        Reliable Tools are best used when the LLM used or the function or tool itself is unreliable.
        Commonly this happens when using small, local LLMs, <32b params
        Or when functions/tools are used to "explore" (doing many web searches, exploring a database with SQL)
        The Reliable Tool allows the user to bake a result validation strategy into the tool itself
        so that the broader group chat/agentic system can be built more clearly around the intended flow
        instead of needing to focus so much on retry and validation loops.

        Additionally, the .run() and .a_run() methods serve as a way to use LLMs to invoke a specific tool outside
        of a Group Chat or similar structure to provide a more traditional programming method of using LLMs and tools in code.

        Args:
            name (str):
                A unique and descriptive name for this ReliableTool instance.
                This name is used for logging, internal context management, and can be
                how other agents or systems refer to this specific reliable capability.
                Example: `"AccurateWeatherForecaster"`, `"ValidatedCustomerLookup"`

            func_or_tool (Union[Callable[..., Any], Tool]):
                The core Python function or an existing AG2 `Tool` instance that this
                `ReliableTool` will manage and execute. This is the underlying capability
                you want to enhance with reliability features like retries and validation.
                The `ReliableTool` will handle calling this function with arguments
                determined by its internal Runner Agent based on the provided `task`.
                Example: `my_api_call_function`, `existing_search_tool_instance`

            runner_llm_config (Union[LLMConfig, dict[str, Any]]):
                The LLM configuration for the internal "Runner Agent". This agent is
                responsible for interpreting the high-level `task` provided when the
                `ReliableTool` is invoked, deciding the appropriate arguments for the
                `func_or_tool`, and initiating its execution.
                This configuration dictates the model, API keys, temperature, etc., for
                the LLM that attempts to call your function. It must support tool/function calling.
                Example: `LLMConfig(config_list=oai_config_list, model="gpt-4o-mini")`
                         `{"config_list": [{"model": "gpt-3.5-turbo", "api_key": "..."}], "temperature": 0.5}`

            validator_llm_config (Union[LLMConfig, dict[str, Any]]):
                The LLM configuration for the internal "Validator Agent". After the
                `func_or_tool` executes successfully, this agent receives its string output
                and assesses whether it meets defined validation criteria. It is
                configured for structured output (Pydantic model `ValidationResult`)
                to provide a boolean validation status and a justification.
                This configuration dictates the model, etc., for the LLM that validates
                the function's result. It can be the same as `runner_llm_config` or different.
                Example: `LLMConfig(config_list=oai_config_list, model="gpt-4o-mini")`

            description (Optional[str], default: None):
                A human-readable description of what this `ReliableTool` achieves.
                If `None`, the description is inferred from the docstring of the
                provided `func_or_tool`. This description is primarily for the public-facing
                `ReliableTool` (e.g., when registered with an outer agent for it to decide
                when to use this tool).
                Example: `"Reliably fetches and validates current weather information for a specified city."`

            system_message_addition_for_tool_calling (str, default: ""):
                Additional text appended to the system message of the internal "Runner Agent".
                This allows you to provide specific instructions, context, or constraints
                to the LLM responsible for deciding *how* to call your underlying `func_or_tool`.
                Use this when the Runner Agent needs more guidance than just the task
                description and the function's signature to correctly formulate arguments.
                Example: `"When calling 'search_products', if the task mentions 'budget', ensure the 'max_price' argument is set accordingly. Prioritize items in stock."`

            system_message_addition_for_result_validation (str, default: ""):
                Additional text appended to the system message of the internal "Validator Agent".
                This is where you define the *base* or *static* criteria for validating the
                *result* (string representation) of your `func_or_tool`. These criteria
                are applied on every validation attempt unless overridden or supplemented by
                dynamic validation.
                Example: `"The stock price must be a positive number. The company name in the result must match the one in the task. If data is unavailable, the result should explicitly state 'Data not found'."`

            max_tool_invocations (int, default: 3):
                The maximum number of times the internal "Runner Agent" can attempt to
                call the underlying `func_or_tool`. This limit includes the initial attempt
                and any subsequent retries that occur due to:
                1. Direct execution errors from `func_or_tool`.
                2. The Runner Agent failing to generate a valid tool call.
                3. The Validator Agent deeming a successful execution's result as invalid.
                Adjust this to control retries and prevent excessive LLM calls, considering
                the potential flakiness of the `func_or_tool` or complexity of parameterization.
                Example: `max_tool_invocations=2` (allows one initial attempt and one retry if needed).

            enable_dynamic_validation (bool, default: False):
                If `True`, the public-facing `run` (or `a_run`) method of this `ReliableTool`
                (accessible via its `func` attribute after initialization) will accept an
                additional optional argument: `validation_prompt_addition: Optional[str]`.
                If a string is provided for this argument during a call, it will be appended
                to the Validator Agent's system message *for that specific run*, allowing
                validation criteria to be tailored on-the-fly based on the task.
                Example: If `True`, `my_tool.func(task="search for AG2 examples", validation_prompt_addition="Result must include Python code snippets.")`

            messages (Optional[List[dict[str, Any]]], default: None):
                A list of initial messages (e.g., from a prior conversation history) to
                provide context to the internal Runner and Validator agents. These messages
                are prepended to the message history seen by these agents during their
                internal chat, helping them understand the `task` in a broader context.
                Use when the `task` for the `ReliableTool` might refer to entities or
                intentions established in preceding turns of a conversation.
                Example: `messages=[{"role": "user", "content": "I'm interested in large-cap tech stocks."}, {"role": "assistant", "content": "Okay, any specific ones?"}]`
                         (Then a task like "Fetch the latest price for 'the one we just discussed'.")

            ground_truth (Optional[List[str]], default: None):
                A list of strings representing factual information, examples, or specific
                constraints that should be considered by the internal Runner and Validator
                agents. These are injected into the conversation history as distinct user
                messages (e.g., "[[Provided Ground Truth 1]]: ...").
                Use to provide specific, factual data or strong hints that might not fit
                naturally into system messages or prior conversation history, guiding the
                agents towards correct interpretation or validation.
                Example: `ground_truth=["The API rate limit is 10 requests per minute.", "User preference: only show results from the last 7 days."]`
        """
        self._original_func, original_name, original_description = self._extract_func_details(func_or_tool)
        self._is_original_func_async = inspect.iscoroutinefunction(self._original_func)

        self._runner_llm_config = ConversableAgent._validate_llm_config(runner_llm_config)
        if self._runner_llm_config is False:
            raise ValueError("Runner LLM config failed validation.")
        # Validate validator_llm_config and store it. It can be LLMConfig | dict | False.
        self._validator_llm_config = ConversableAgent._validate_llm_config(validator_llm_config)
        if self._validator_llm_config is False:  # Check before use in _setup_validator_agent
            raise ValueError("Validator LLM config failed validation.")

        self._runner_system_message_addition = system_message_addition_for_tool_calling
        self._validator_system_message_addition = system_message_addition_for_result_validation
        self.max_tool_invocations = max_tool_invocations
        self._context_variables_key = f"{name}_ReliableToolContext_{id(self)}"

        self._original_func_name = original_name
        self.enable_dynamic_validation = enable_dynamic_validation

        self._init_messages = copy.deepcopy(messages) if messages is not None else None
        self._init_ground_truth = copy.deepcopy(ground_truth) if ground_truth else None

        self._tool_description = description if description is not None else original_description

        public_entry_point_func = self._define_public_entry_point(
            self._is_original_func_async, self.enable_dynamic_validation
        )

        super().__init__(
            name=name,
            description=self._tool_description,
            func_or_tool=public_entry_point_func,
        )

        self._validator_name = f"{self.name}_Validator"
        self._runner_name = f"{self.name}_Runner"

        self._validator = self._setup_validator_agent()
        self._runner = self._setup_runner_agent()
        self._reliable_func_wrapper = reliable_function_wrapper(
            self._original_func, self._validator, self._runner, self._context_variables_key
        )
        self._setup_runner_tool()
        self._register_internal_hooks()

    def _define_public_entry_point(self, is_async: bool, enable_dynamic: bool) -> Callable[..., Any]:
        if not is_async:
            if enable_dynamic:

                def sync_entry_point_with_validation(
                    task: str, validation_prompt_addition: Optional[str] = None
                ) -> Any:
                    return self.run(task=task, validation_prompt_addition=validation_prompt_addition)

                return sync_entry_point_with_validation
            else:

                def sync_entry_point_without_validation(task: str) -> Any:
                    return self.run(task=task, validation_prompt_addition=None)

                return sync_entry_point_without_validation
        else:
            if enable_dynamic:

                async def async_entry_point_with_validation(
                    task: str, validation_prompt_addition: Optional[str] = None
                ) -> Any:
                    return await self.a_run(task=task, validation_prompt_addition=validation_prompt_addition)

                return async_entry_point_with_validation
            else:

                async def async_entry_point_without_validation(task: str) -> Any:
                    return await self.a_run(task=task, validation_prompt_addition=None)

                return async_entry_point_without_validation

    def _extract_func_details(
        self, func_or_tool: Union[Callable[..., Any], Tool]
    ) -> Tuple[Callable[..., Any], str, str]:
        default_desc_template = "Executes the '{name}' function."
        if isinstance(func_or_tool, Tool):
            func = getattr(func_or_tool, "func", None)
            if not callable(func):
                raise TypeError(
                    f"Tool '{func_or_tool.name}' provided but its 'func' attribute is not callable or missing."
                )
            name = func_or_tool.name
            desc = func_or_tool.description
            if not desc or desc == f"Tool '{name}'." or desc == "No description provided.":
                func_doc = inspect.getdoc(func)
                desc = func_doc.strip() if func_doc else f"{default_desc_template.format(name=name)}"
            return func, name, desc
        elif callable(func_or_tool):
            name = getattr(func_or_tool, "__name__", "callable_function")
            doc = inspect.getdoc(func_or_tool)
            desc = doc.strip() if doc else f"{default_desc_template.format(name=name)}"
            # For raw callables, we don't have a pre-computed schema like Tool object might
            return func_or_tool, name, desc
        raise TypeError(
            "Input 'func_or_tool' must be a callable or an autogen.Tool instance with a callable 'func' attribute."
        )

    def _setup_validator_agent(self) -> ConversableAgent:
        # _configure_llm_for_structured_output will raise ValueError if config is bad
        # Use a local variable for type narrowing after the False check.
        current_validator_config = self._validator_llm_config
        if current_validator_config is False:
            # This case should have been caught in __init__, but as a safeguard:
            raise ValueError("Validator LLM config is False, cannot proceed.")

        structured_llm_config = _configure_llm_for_structured_output(
            copy.deepcopy(current_validator_config),  # current_validator_config is not False here
            ValidationResult,
        )
        return ConversableAgent(
            name=self._validator_name,
            system_message="[Validator Prompt Updated Per Run]",
            llm_config=structured_llm_config,
            human_input_mode="NEVER",
        )

    def _setup_runner_agent(self) -> ConversableAgent:
        runner_llm_config_copy = copy.deepcopy(self._runner_llm_config)
        runner = ConversableAgent(
            name=self._runner_name,
            system_message="[Runner Prompt Updated Per Run]",
            llm_config=runner_llm_config_copy,
            human_input_mode="NEVER",
        )
        return runner

    def _setup_runner_tool(self) -> None:
        internal_tool_name = f"{self.INTERNAL_TOOL_NAME_PREFIX}{self._original_func_name}"
        internal_tool = Tool(
            name=internal_tool_name, description=self._tool_description, func_or_tool=self._reliable_func_wrapper
        )
        internal_tool.register_tool(self._runner)
        logger.info(
            "Successfully registered internal tool '%s' with runner '%s'", internal_tool_name, self._runner.name
        )

    def _register_internal_hooks(self) -> None:
        self._validator.register_hook(
            hookable_method="process_message_before_send", hook=self._validator_structured_output_hook
        )
        self._validator.register_hook(
            hookable_method="process_all_messages_before_reply", hook=self._validator_construct_context_hook
        )
        self._runner.register_hook(hookable_method="process_message_before_send", hook=self._ensure_function_call_hook)

    def _validator_structured_output_hook(
        self, sender: Agent, message: Union[dict[str, Any], str], recipient: Agent, silent: bool
    ) -> Union[dict[str, Any], str]:
        if not isinstance(message, str):
            logger.error(
                f"Validator Hook: Expected a JSON string message from LLM, but got {type(message)}. Content: {str(message)[:200]}"
            )
            # This indicates a misconfiguration or unexpected LLM output format.
            raise TypeError(f"Validator hook expected str from LLM, got {type(message)}")

        validation_result_obj: ValidationResult = ValidationResult.model_validate_json(message)
        status = "PASSED" if validation_result_obj.validation_result else "FAILED"
        log_level = logging.INFO if status == "PASSED" else logging.WARNING
        logger.log(
            log_level,
            f"Validator Hook: Parsed Validation - {status}. Justification: {validation_result_obj.justification}",
        )

        self._try_update_context_validation(sender, validation_result_obj)
        # sender is self._validator in this hook context
        self._set_validator_handoff(self._validator, validation_result_obj.validation_result)
        return validation_result_obj.format()  # Return JSON string

    def _set_validator_handoff(self, validator_agent: ConversableAgent, validation_passed: bool) -> None:
        if not validation_passed:
            logger.info("Validation failed, setting handoff to runner: %s", self._runner_name)
            validator_agent.handoffs.set_after_work(target=AgentTarget(self._runner))
        else:
            logger.info("Validation passed, setting handoff to TerminateTarget.")
            validator_agent.handoffs.set_after_work(target=TerminateTarget())

    def _try_update_context_validation(self, sender: Agent, validation_result: ValidationResult) -> None:
        """Helper to attempt updating the validation state in the ReliableToolContext."""
        context_vars = getattr(sender, "context_variables")

        tool_context = _get_reliable_tool_context(context_vars, self._context_variables_key)
        latest_attempt = tool_context.latest_attempt

        if not latest_attempt:
            # This implies a logical error in the execution flow.
            raise RuntimeError(
                f"Validator hook: No execution attempt found in context '{self._context_variables_key}' to update validation for."
            )

        latest_attempt.validation = validation_result
        _set_reliable_tool_context(context_vars, self._context_variables_key, tool_context)
        logger.info(
            "Validator hook: Updated validation status in context: %s",
            "Passed" if validation_result.validation_result else "Failed",
        )

    def _validator_construct_context_hook(self, messages: list[dict[str, Any]], **kwargs: Any) -> list[dict[str, Any]]:
        sender = self._validator  # Assuming self._validator is the agent instance
        logger.debug("Validator Construct Context Hook running for agent %s.", sender.name)

        context_vars = getattr(sender, "context_variables")

        tool_context = _get_reliable_tool_context(context_vars, self._context_variables_key)
        initial_messages_to_inject = (
            copy.deepcopy(tool_context.initial_messages) if tool_context.initial_messages else []
        )

        ground_truth_messages_to_inject = []
        if tool_context.initial_ground_truth:
            for i, gt in enumerate(tool_context.initial_ground_truth):
                ground_truth_messages_to_inject.append({
                    "role": "user",
                    "content": f"[[Provided Ground Truth {i + 1}]]:\n{gt}",
                })

        last_content = _get_last_non_empty_message_content(messages)
        result_message_dict = {
            "role": "user",
            "content": f"--- Function Result to Validate ---\n```\n{last_content}\n```\n--- End of Result ---",
        }

        final_messages = initial_messages_to_inject + ground_truth_messages_to_inject + [result_message_dict]
        return final_messages

    def _ensure_function_call_hook(
        self, sender: Agent, message: Union[dict[str, Any], str], recipient: Agent, silent: bool
    ) -> Union[dict[str, Any], str]:
        if sender.name != self._runner_name:
            return message

        tool_calls_list = None
        if isinstance(message, dict):
            tool_calls_list = message.get("tool_calls")

        tool_name_expected = f"{self.INTERNAL_TOOL_NAME_PREFIX}{self._original_func_name}"
        correct_tool_called = False
        if isinstance(tool_calls_list, list):
            for call in tool_calls_list:
                if (
                    isinstance(call, dict)
                    and call.get("type") == "function"
                    and isinstance(call.get("function"), dict)
                    and call["function"].get("name") == tool_name_expected
                ):
                    correct_tool_called = True
                    break

        if not correct_tool_called:
            if not hasattr(self._runner, "handoffs"):
                raise AttributeError(f"Runner agent '{self._runner.name}' missing 'handoffs' attribute for reminder.")
            self._runner.handoffs.set_after_work(target=AgentTarget(self._runner))  # Retry with runner

            logger.warning(
                "Runner '%s' did not generate required tool call for '%s'. Appending reminder.",
                self._runner_name,
                tool_name_expected,
            )
            reminder = (
                f"\n\n[[System Reminder: You MUST invoke the function '{tool_name_expected}' using a tool call. "
                "Provide all required arguments including 'hypothesis'.]]\n"
                "Correct your mistake and make a new attempt at invoking the tool."
            )

            current_content = ""
            if isinstance(message, str):
                current_content = message
            elif isinstance(message, dict):
                current_content = message.get("content") or ""

            # Return a new message dict to ensure it's processed correctly by the agent
            return {
                "role": "assistant",  # The LLM's previous turn was as assistant
                "content": (current_content or "") + reminder,
                "tool_calls": [] if isinstance(message, dict) else None,
            }
        return message

    def _execute_internal_group_chat(
        self,
        task: str,
        initial_context_vars: ContextVariables,  # Renamed for clarity
        dynamic_validation_str: Optional[str] = None,
    ) -> Tuple[ChatResult, ContextVariables, Agent]:
        internal_tool_name = f"{self.INTERNAL_TOOL_NAME_PREFIX}{self._original_func_name}"

        # update_system_message should not fail if agent is properly initialized
        runner_prompt = get_runner_prompt(task, self._runner_system_message_addition, internal_tool_name)
        self._runner.update_system_message(runner_prompt)

        validator_prompt = get_validator_prompt(task, self._validator_system_message_addition, dynamic_validation_str)
        self._validator.update_system_message(validator_prompt)

        # Store context ref on agents for hooks. Crucial for hooks to access shared state.
        self._validator.context_variables = initial_context_vars
        self._runner.context_variables = initial_context_vars

        messages_for_runner_history = []
        # Retrieve tool_context again to build runner history with potentially updated initial messages/GT
        # This is vital if _process_run (the caller) modifies them in initial_context_vars.
        tool_context = _get_reliable_tool_context(initial_context_vars, self._context_variables_key)

        if tool_context.initial_messages:
            messages_for_runner_history.extend(copy.deepcopy(tool_context.initial_messages))
        if tool_context.initial_ground_truth:
            for i, gt in enumerate(tool_context.initial_ground_truth):
                messages_for_runner_history.append({
                    "role": "user",
                    "content": f"[[Provided Ground Truth {i + 1}]]:\n{gt}",
                })

        task_message = {
            "role": "user",
            "content": f"[[Task Kickoff]]: Please execute the required function call for the task: {task}",
        }
        final_initial_messages_for_runner = messages_for_runner_history + [task_message]

        agent_pattern = DefaultPattern(
            agents=[self._runner, self._validator],
            initial_agent=self._runner,
            context_variables=initial_context_vars,
        )

        max_internal_rounds = 1 + (self.max_tool_invocations * 3)
        logger.debug(
            f"Setting max internal chat rounds to {max_internal_rounds} for {self.max_tool_invocations} tool invocations."
        )

        logger.info(
            f"--- Starting ReliableTool '{self.name}' Internal Chat (Max Invocations: {self.max_tool_invocations}) ---"
        )

        last_reply, final_context_vars, last_agent = initiate_group_chat(
            pattern=agent_pattern,
            messages=final_initial_messages_for_runner,
            max_rounds=max_internal_rounds,
        )
        logger.info(
            f"--- ReliableTool '{self.name}' Internal Chat Finished (Last Agent: {getattr(last_agent, 'name', 'N/A')}) ---"
        )
        if not isinstance(final_context_vars, ContextVariables):
            # This would be an unexpected issue with initiate_group_chat or pattern
            raise TypeError(f"Internal chat returned invalid context_variables type: {type(final_context_vars)}")
        return last_reply, final_context_vars, last_agent

    def _prepare_tool_context(
        self,
        task: str,
        current_context_variables: ContextVariables,
        validation_prompt_addition: Optional[str] = None,
        messages: Optional[list[dict[str, Any]]] = None,
        ground_truth: Optional[List[str]] = None,
    ) -> ReliableToolContext:
        """Initializes or updates the ReliableToolContext for the current run."""
        effective_messages = copy.deepcopy(messages) if messages is not None else self._init_messages
        effective_ground_truth = copy.deepcopy(ground_truth) if ground_truth is not None else self._init_ground_truth

        tool_context = ReliableToolContext(task=task, reliable_tool_name=self.name)

        tool_context.task = task
        tool_context.dynamic_validation_input = validation_prompt_addition
        tool_context.initial_messages = effective_messages
        tool_context.initial_ground_truth = effective_ground_truth

        _set_reliable_tool_context(current_context_variables, self._context_variables_key, tool_context)
        return tool_context

    def _process_run(
        self,
        task: str,
        context_variables: Optional[ContextVariables] = None,
        validation_prompt_addition: Optional[str] = None,
        messages: Optional[list[dict[str, Any]]] = None,
        ground_truth: Optional[List[str]] = None,
    ) -> Any:
        current_context_variables = context_variables if context_variables is not None else ContextVariables()
        if not isinstance(current_context_variables, ContextVariables):
            raise TypeError(f"Expected context_variables as ContextVariables or None, got {type(context_variables)}")

        self._prepare_tool_context(task, current_context_variables, validation_prompt_addition, messages, ground_truth)

        final_tool_context: ReliableToolContext
        _, chat_context_variables, _ = self._execute_internal_group_chat(
            task=task,
            initial_context_vars=current_context_variables,
            dynamic_validation_str=validation_prompt_addition,
        )
        current_context_variables = chat_context_variables

        final_tool_context = _get_reliable_tool_context(current_context_variables, self._context_variables_key)
        latest_attempt_obj = final_tool_context.latest_attempt

        if not latest_attempt_obj:
            raise ReliableToolError(
                "Critical internal error: No execution attempt recorded after chat cycle.",
                final_context=final_tool_context,
            )

        # If execution was successful BUT validation is missing (e.g. validator hook failed to set it)
        if latest_attempt_obj.did_execute_successfully and latest_attempt_obj.validation is None:
            logger.warning(
                "[%s]: Validation result missing after successful execution. Assuming validation failed.", self.name
            )
            latest_attempt_obj.validation = ValidationResult(
                validation_result=False,
                justification="Validation result was not recorded after successful execution. Usually due to group chat reaching maximum runs",
            )
            _set_reliable_tool_context(current_context_variables, self._context_variables_key, final_tool_context)

        if final_tool_context.is_complete_and_successful:
            logger.info("ReliableTool '%s' succeeded.", self.name)
            return final_tool_context.get_final_result_data()
        else:
            failure_reason = final_tool_context.get_failure_summary()
            logger.warning("ReliableTool '%s' failed. Reason: %s", self.name, failure_reason)
            raise ReliableToolError(
                f"ReliableTool '{self.name}' failed. Last failure: {failure_reason}",
                final_context=final_tool_context,
            )

    def run(
        self,
        task: str,
        context_variables: Optional[ContextVariables] = None,
        validation_prompt_addition: Optional[str] = None,
        messages: Optional[list[dict[str, Any]]] = None,
        ground_truth: Optional[List[str]] = None,
    ) -> Any:
        if self._is_original_func_async:
            raise TypeError(f"Sync 'run()' called for async tool '{self.name}'. Use 'a_run()'.")
        return self._process_run(
            task=task,
            context_variables=context_variables,
            validation_prompt_addition=validation_prompt_addition,
            messages=messages,
            ground_truth=ground_truth,
        )

    async def a_run(
        self,
        task: str,
        context_variables: Optional[ContextVariables] = None,
        validation_prompt_addition: Optional[str] = None,
        messages: Optional[list[dict[str, Any]]] = None,
        ground_truth: Optional[List[str]] = None,
    ) -> Any:
        if not self._is_original_func_async:
            warnings.warn(
                f"Running sync function '{self._original_func_name}' wrapped by ReliableTool '{self.name}' "
                f"asynchronously using 'a_run()'. The underlying execution of _process_run will be synchronous "
                f"within an executor.",
                UserWarning,
            )

        loop = asyncio.get_running_loop()
        func_call = functools.partial(
            self._process_run,
            task=task,
            context_variables=context_variables,
            validation_prompt_addition=validation_prompt_addition,
            messages=messages,
            ground_truth=ground_truth,
        )
        return await loop.run_in_executor(None, func_call)

    def _process_run_with_details(
        self,
        task: str,
        context_variables: Optional[ContextVariables] = None,
        validation_prompt_addition: Optional[str] = None,
        messages: Optional[list[dict[str, Any]]] = None,
        ground_truth: Optional[List[str]] = None,
    ) -> ToolExecutionDetails:
        current_context_variables = context_variables if context_variables is not None else ContextVariables()
        if not isinstance(current_context_variables, ContextVariables):
            err_msg = f"Invalid ContextVariables type: {type(context_variables)}"
            # Create a minimal context for reporting
            err_ctx = ReliableToolContext(task=task, reliable_tool_name=self.name)
            err_ctx.attempts.append(ExecutionAttempt(error=f"Initialization error: {err_msg}"))
            return ToolExecutionDetails(
                task=task, is_overall_successful=False, failure_reason=err_msg, final_tool_context=err_ctx
            )

        tool_context_for_run: ReliableToolContext
        try:
            # Initialize or update tool context state. Raises on ser/de errors.
            tool_context_for_run = self._prepare_tool_context(
                task, current_context_variables, validation_prompt_addition, messages, ground_truth
            )
        except (ValueError, TypeError) as e_ctx_setup:
            err_msg = f"Error during ReliableToolContext setup: {e_ctx_setup}"
            logger.error("[%s] %s", self.name, err_msg, exc_info=True)
            err_ctx = ReliableToolContext(task=task, reliable_tool_name=self.name)
            err_ctx.attempts.append(ExecutionAttempt(error=f"Context setup error: {e_ctx_setup}"))
            return ToolExecutionDetails(
                task=task, is_overall_successful=False, failure_reason=err_msg, final_tool_context=err_ctx
            )

        # Variables for ToolExecutionDetails
        is_successful_val = False
        failure_reason_val = None
        successful_params_val = None
        final_tool_context_val: ReliableToolContext = tool_context_for_run  # Start with prepared context

        try:
            _, chat_context_variables, _ = self._execute_internal_group_chat(
                task=task,
                initial_context_vars=current_context_variables,  # This contains the prepared tool_context_for_run
                dynamic_validation_str=validation_prompt_addition,
            )
            current_context_variables = chat_context_variables  # Update with context from chat

            final_tool_context_val = _get_reliable_tool_context(current_context_variables, self._context_variables_key)
            latest_attempt = final_tool_context_val.latest_attempt

            if not latest_attempt:
                failure_reason_val = "Critical internal error: No execution attempt recorded after chat cycle."
                # final_tool_context_val already reflects this state if attempts list is empty
            elif latest_attempt.did_execute_successfully and latest_attempt.validation is None:
                logger.warning(
                    "[%s]: Validation result missing after successful execution. Assuming validation failed.", self.name
                )
                latest_attempt.validation = ValidationResult(
                    validation_result=False,
                    justification="Validation result was not recorded after successful execution.",
                )
                _set_reliable_tool_context(
                    current_context_variables, self._context_variables_key, final_tool_context_val
                )

            if final_tool_context_val.is_complete_and_successful:
                is_successful_val = True
                # latest_attempt must exist if is_complete_and_successful is true
                # Re-fetch or assert to help Mypy understand it's not None
                confirmed_latest_attempt = final_tool_context_val.latest_attempt
                assert confirmed_latest_attempt is not None, (
                    "Internal logic error: is_complete_and_successful is True but latest_attempt is None"
                )
                successful_params_val = SuccessfulExecutionParameters(
                    attempt_args=confirmed_latest_attempt.attempt_args,
                    attempt_kwargs=confirmed_latest_attempt.attempt_kwargs,
                )
            else:
                failure_reason_val = final_tool_context_val.get_failure_summary()

        except ReliableToolError as e:
            is_successful_val = False
            failure_reason_val = f"ReliableTool execution failed: {e}"
            logger.warning("[%s] %s", self.name, failure_reason_val)  # Log the failure reason from ReliableToolError
            final_tool_context_val = e.final_context or final_tool_context_val  # Use context from error if available
            if not final_tool_context_val.attempts:  # Ensure some attempt is logged if context is minimal
                final_tool_context_val.attempts.append(ExecutionAttempt(error=str(e)))

        except (KeyError, ValueError, TypeError) as e_ctx_final:  # Context errors after chat
            is_successful_val = False
            failure_reason_val = f"Critical error involving context after chat: {e_ctx_final}"
            logger.error("[%s] %s", self.name, failure_reason_val, exc_info=True)
            try:  # Try to get the latest context, otherwise use what we had
                final_tool_context_val = _get_reliable_tool_context(
                    current_context_variables, self._context_variables_key
                )
            except (
                Exception
            ):  # If still fails, final_tool_context_val remains as tool_context_for_run or from a prior partial update
                if not final_tool_context_val.attempts or final_tool_context_val.attempts[-1].error is None:
                    final_tool_context_val.attempts.append(ExecutionAttempt(error=failure_reason_val))

        except Exception as e_unexp:  # Unexpected errors during the process
            is_successful_val = False
            failure_reason_val = f"Unexpected error during reliable execution: {e_unexp}"
            logger.error("[%s] %s", self.name, failure_reason_val, exc_info=True)
            try:  # Try to get the latest context
                final_tool_context_val = _get_reliable_tool_context(
                    current_context_variables, self._context_variables_key
                )
            except (
                Exception
            ):  # If still fails, final_tool_context_val remains as tool_context_for_run or from a prior partial update
                if not final_tool_context_val.attempts or final_tool_context_val.attempts[-1].error is None:
                    final_tool_context_val.attempts.append(ExecutionAttempt(error=failure_reason_val))

        return ToolExecutionDetails(
            task=task,
            is_overall_successful=is_successful_val,
            failure_reason=failure_reason_val,
            successful_parameters=successful_params_val,
            final_tool_context=final_tool_context_val,
        )

    def run_and_get_details(
        self,
        task: str,
        context_variables: Optional[ContextVariables] = None,
        validation_prompt_addition: Optional[str] = None,
        messages: Optional[list[dict[str, Any]]] = None,
        ground_truth: Optional[List[str]] = None,
    ) -> ToolExecutionDetails:
        if self._is_original_func_async:
            raise TypeError(
                f"Synchronous 'run_and_get_details()' called for an async tool '{self.name}'. "
                f"Use 'a_run_and_get_details()' instead."
            )
        return self._process_run_with_details(
            task=task,
            context_variables=context_variables,
            validation_prompt_addition=validation_prompt_addition,
            messages=messages,
            ground_truth=ground_truth,
        )

    async def a_run_and_get_details(
        self,
        task: str,
        context_variables: Optional[ContextVariables] = None,
        validation_prompt_addition: Optional[str] = None,
        messages: Optional[list[dict[str, Any]]] = None,
        ground_truth: Optional[List[str]] = None,
    ) -> ToolExecutionDetails:
        if not self._is_original_func_async:
            warnings.warn(
                f"Running sync function '{self._original_func_name}' (wrapped by ReliableTool '{self.name}') "
                f"asynchronously using 'a_run_and_get_details()'. The underlying execution will be synchronous "
                f"within an executor.",
                UserWarning,
            )

        loop = asyncio.get_running_loop()
        try:
            func_call = functools.partial(
                self._process_run_with_details,
                task=task,
                context_variables=context_variables,
                validation_prompt_addition=validation_prompt_addition,
                messages=messages,
                ground_truth=ground_truth,
            )
            details: ToolExecutionDetails = await loop.run_in_executor(None, func_call)
            return details
        except Exception as e:
            logger.critical(
                "[%s] a_run_and_get_details encountered an unhandled exception from executor: %s",
                self.name,
                e,
                exc_info=True,
            )
            fallback_ctx = ReliableToolContext(task=task, reliable_tool_name=self.name)
            fallback_ctx.attempts.append(
                ExecutionAttempt(error=f"Unhandled executor/process error: {type(e).__name__}: {e}")
            )
            return ToolExecutionDetails(
                task=task,
                is_overall_successful=False,
                failure_reason=f"Critical unhandled exception during async execution: {type(e).__name__}: {e}",
                final_tool_context=fallback_ctx,
            )
