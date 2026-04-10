from __future__ import annotations

import re
import time
import uuid
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator, Callable, Coroutine
from dataclasses import dataclass, field
from threading import Lock
from typing import TYPE_CHECKING, Any

from google.protobuf.struct_pb2 import Struct

from elizaos.types.memory import Memory
from elizaos.types.model import ModelType
from elizaos.types.primitives import ChannelType, Content, as_uuid
from elizaos.types.state import SchemaRow, State

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime

HandlerCallback = Callable[[Content], Coroutine[Any, Any, list[Memory]]]
StreamChunkCallback = Callable[[str], Coroutine[Any, Any, None]]

_latest_response_ids: dict[str, dict[str, str]] = {}
_latest_response_ids_lock = Lock()


@dataclass
class MessageProcessingOptions:
    continue_after_actions: bool | None = None
    keep_existing_responses: bool | None = None


@dataclass
class MessageProcessingResult:
    did_respond: bool
    response_content: Content | None
    response_messages: list[Memory] = field(default_factory=list)
    state: State | None = None


@dataclass
class StreamingMessageResult:
    """Result metadata for streaming message processing."""

    response_memory: Memory
    state: State | None = None


class IMessageService(ABC):
    @abstractmethod
    async def handle_message(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        callback: HandlerCallback | None = None,
        options: MessageProcessingOptions | None = None,
    ) -> MessageProcessingResult: ...

    @abstractmethod
    def handle_message_stream(
        self,
        runtime: IAgentRuntime,
        message: Memory,
    ) -> AsyncIterator[str | StreamingMessageResult]:
        """
        Process a message and stream the response token by token.

        Yields:
            str: Text chunks as they are generated
            StreamingMessageResult: Final result with metadata (yielded last)
        """
        ...


def _parse_actions_from_xml(xml_response: str) -> list[str]:
    """Parse actions from XML response."""
    import re

    # Try to find <actions> tag
    match = re.search(r"<actions>\s*([^<]+)\s*</actions>", xml_response, re.IGNORECASE)
    if match:
        actions_text = match.group(1).strip()
        if actions_text:
            # Split by comma and clean up
            actions = [a.strip().upper() for a in actions_text.split(",") if a.strip()]
            return actions
    return []


def _parse_providers_from_xml(xml_response: str) -> list[str]:
    """Parse providers from XML response."""
    import re

    match = re.search(r"<providers>\s*([^<]+)\s*</providers>", xml_response, re.IGNORECASE)
    if match:
        providers_text = match.group(1).strip()
        if providers_text:
            providers = [p.strip() for p in providers_text.split(",") if p.strip()]
            return providers
    return []


def _parse_tag(xml: str, tag: str) -> str | None:
    open_tag = f"<{tag}>"
    close_tag = f"</{tag}>"
    start = xml.find(open_tag)
    if start == -1:
        return None
    inner_start = start + len(open_tag)
    end = xml.find(close_tag, inner_start)
    if end == -1:
        return None
    return xml[inner_start:end].strip()


def _parse_bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("true", "yes", "1", "on")
    return False


def _parse_int(value: object, *, default: int) -> int:
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value.strip())
        except Exception:
            return default
    return default


def _normalize_env_list(value: object) -> list[str]:
    if not isinstance(value, str):
        return []
    cleaned = value.strip().removeprefix("[").removesuffix("]")
    return [item.strip() for item in cleaned.split(",") if item.strip()]


def _text_contains_agent_name(
    text: str | None,
    names: list[str | None],
) -> bool:
    if not text:
        return False

    for name in names:
        candidate = (name or "").strip()
        if not candidate:
            continue
        pattern = re.compile(
            rf"(^|[^\w]){re.escape(candidate)}(?=$|[^\w])",
            re.IGNORECASE,
        )
        if pattern.search(text):
            return True
    return False


def _text_contains_user_tag(text: str | None) -> bool:
    if not text:
        return False
    return re.search(r"<@!?[^>]+>|@\w+", text) is not None


def _should_respond_prefilter(
    runtime: IAgentRuntime,
    message: Memory,
) -> tuple[bool, bool, str]:
    content = message.content
    channel_type = str(getattr(content, "channel_type", "") or "").strip().lower()
    source = str(getattr(content, "source", "") or "").strip().lower()
    mention_context = getattr(content, "mention_context", None)
    text = str(getattr(content, "text", "") or "")

    custom_channels = _normalize_env_list(
        runtime.get_setting("ALWAYS_RESPOND_CHANNELS")
        or runtime.get_setting("SHOULD_RESPOND_BYPASS_TYPES")
    )
    custom_sources = _normalize_env_list(
        runtime.get_setting("ALWAYS_RESPOND_SOURCES")
        or runtime.get_setting("SHOULD_RESPOND_BYPASS_SOURCES")
    )

    respond_channels = {
        ChannelType.DM.value.lower(),
        ChannelType.VOICE_DM.value.lower(),
        ChannelType.SELF.value.lower(),
        ChannelType.API.value.lower(),
        *[value.lower() for value in custom_channels],
    }
    respond_sources = [
        "client_chat",
        *[value.lower() for value in custom_sources],
    ]

    text_mentions_agent_by_name = _text_contains_agent_name(
        text,
        [
            getattr(runtime.character, "name", None),
            getattr(runtime.character, "username", None),
        ],
    )
    text_mentions_tagged_participants = _text_contains_user_tag(text)
    has_platform_mention = bool(
        mention_context
        and (
            getattr(mention_context, "is_mention", False)
            or getattr(mention_context, "is_reply", False)
        )
    )

    if channel_type in respond_channels:
        return True, True, f"private channel: {channel_type}"

    if any(pattern and pattern in source for pattern in respond_sources):
        return True, True, f"whitelisted source: {source}"

    if has_platform_mention:
        mention_type = "mention" if getattr(mention_context, "is_mention", False) else "reply"
        return True, True, f"platform {mention_type}"

    if text_mentions_tagged_participants and text_mentions_agent_by_name:
        return True, True, "text address with tagged participants"

    if text_mentions_agent_by_name:
        return False, False, "agent named in text requires LLM evaluation"

    return False, False, "needs LLM evaluation"


def _set_latest_response_id(agent_id: str, room_id: str, response_id: str) -> None:
    with _latest_response_ids_lock:
        agent_map = _latest_response_ids.setdefault(agent_id, {})
        agent_map[room_id] = response_id


def _get_latest_response_id(agent_id: str, room_id: str) -> str | None:
    with _latest_response_ids_lock:
        return _latest_response_ids.get(agent_id, {}).get(room_id)


def _clear_latest_response_id(agent_id: str, room_id: str, response_id: str) -> None:
    with _latest_response_ids_lock:
        agent_map = _latest_response_ids.get(agent_id)
        if not agent_map:
            return
        if agent_map.get(room_id) != response_id:
            return
        agent_map.pop(room_id, None)
        if not agent_map:
            _latest_response_ids.pop(agent_id, None)


def _format_action_results(results: list[object]) -> str:
    # Avoid importing ActionResult at module import time.
    if not results:
        return ""
    lines: list[str] = []
    for r in results:
        # ActionResult has fields: success, text, data
        name = ""
        success = True
        text = ""
        data = getattr(r, "data", None)
        if isinstance(data, dict):
            v = data.get("actionName")
            if isinstance(v, str):
                name = v
        s = getattr(r, "success", None)
        if isinstance(s, bool):
            success = s
        t = getattr(r, "text", None)
        if isinstance(t, str):
            text = t
        status = "success" if success else "failed"
        lines.append(f"- {name} ({status}): {text}".strip())
    return "\n".join(lines)


def _parse_text_from_xml(xml_response: str) -> str:
    """Parse text content from XML response."""
    import re

    # Try <text> tag first
    match = re.search(r"<text>\s*(.*?)\s*</text>", xml_response, re.DOTALL | re.IGNORECASE)
    if match:
        return match.group(1).strip()
    return ""


def _parse_thought_from_xml(xml_response: str) -> str:
    """Parse thought from XML response."""
    import re

    match = re.search(r"<thought>\s*(.*?)\s*</thought>", xml_response, re.DOTALL | re.IGNORECASE)
    if match:
        return match.group(1).strip()
    return ""


def _parse_params_from_xml(xml_response: str) -> dict[str, list[dict[str, str]]]:
    """Parse action parameters from an XML response.

    The canonical template recommends nested XML:
      <params><ACTION><param>value</param></ACTION></params>

    In practice, some models return JSON inside <params>:
      <params>{"ACTION":{"param":"value"}}</params>

    This parser supports both.
    """
    import json
    import re
    import xml.etree.ElementTree as ET

    result: dict[str, list[dict[str, str]]] = {}

    params_match = re.search(
        r"<params>\s*(.*?)\s*</params>", xml_response, re.DOTALL | re.IGNORECASE
    )

    # If there's no <params> wrapper, some models return JSON directly (optionally in fences
    # or nested inside other tags). Attempt to recover a JSON object.
    if not params_match:
        stripped = xml_response.strip()
        # Try fenced JSON (```json ...``` or ``` ... ```)
        fenced = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", stripped, re.IGNORECASE)
        if fenced:
            stripped = fenced.group(1).strip()

        # Try extracting a JSON object substring (first {...} block)
        if not (stripped.startswith("{") and stripped.endswith("}")):
            obj_match = re.search(r"(\{[\s\S]*\})", stripped)
            if obj_match:
                stripped = obj_match.group(1).strip()

        if stripped.startswith("[") and stripped.endswith("]"):
            try:
                loaded_any = json.loads(stripped)
            except json.JSONDecodeError:
                return result
            if isinstance(loaded_any, list):
                for item in loaded_any:
                    if not isinstance(item, dict):
                        continue
                    for action_name, action_params_raw in item.items():
                        if not isinstance(action_params_raw, dict):
                            continue
                        params_out: dict[str, str] = {}
                        for k, v in action_params_raw.items():
                            params_out[str(k)] = str(v)
                        if params_out:
                            result.setdefault(str(action_name).upper(), []).append(params_out)
            return result

        if stripped.startswith("{") and stripped.endswith("}"):
            try:
                loaded_any = json.loads(stripped)
            except json.JSONDecodeError:
                # Some models emit a sequence of JSON objects separated by commas:
                #   {...},{...},{...}
                # which is not valid JSON unless wrapped in an array. Try that.
                try:
                    loaded_any = json.loads(f"[{stripped}]")
                except json.JSONDecodeError:
                    return result
            if isinstance(loaded_any, dict):
                for action_name, action_params_raw in loaded_any.items():
                    if not isinstance(action_params_raw, dict):
                        continue
                    params_out: dict[str, str] = {}
                    for k, v in action_params_raw.items():
                        params_out[str(k)] = str(v)
                    if params_out:
                        result.setdefault(str(action_name).upper(), []).append(params_out)
            elif isinstance(loaded_any, list):
                for item in loaded_any:
                    if not isinstance(item, dict):
                        continue
                    for action_name, action_params_raw in item.items():
                        if not isinstance(action_params_raw, dict):
                            continue
                        params_out: dict[str, str] = {}
                        for k, v in action_params_raw.items():
                            params_out[str(k)] = str(v)
                        if params_out:
                            result.setdefault(str(action_name).upper(), []).append(params_out)
        return result

    params_content = params_match.group(1).strip()
    if not params_content:
        return result

    # First try XML parsing of the inner params content
    try:
        root = ET.fromstring(f"<params>{params_content}</params>")
        for action_elem in list(root):
            action_name = action_elem.tag.upper()
            action_params: dict[str, str] = {}

            for param_elem in list(action_elem):
                value_text = (param_elem.text or "").strip()
                action_params[param_elem.tag] = value_text

            # If the action block contains text but no nested tags, try JSON-in-action.
            if not action_params:
                action_text = (action_elem.text or "").strip()
                if action_text.startswith("{"):
                    try:
                        loaded = json.loads(action_text)
                        if isinstance(loaded, dict):
                            for k, v in loaded.items():
                                action_params[str(k)] = str(v)
                    except json.JSONDecodeError:
                        return result

            if action_params:
                result.setdefault(action_name, []).append(action_params)

        return result
    except ET.ParseError:
        return result

    # Fall back to JSON inside <params>...</params>
    if not params_content.startswith("{"):
        return result

    try:
        loaded = json.loads(params_content)
    except json.JSONDecodeError:
        return result

    if not isinstance(loaded, dict):
        return result

    for action_name, action_params_raw in loaded.items():
        if not isinstance(action_params_raw, dict):
            continue
        params: dict[str, str] = {}
        for k, v in action_params_raw.items():
            params[str(k)] = str(v)
        if params:
            result.setdefault(str(action_name).upper(), []).append(params)

    return result


class DefaultMessageService(IMessageService):
    """Canonical message service that processes the full Eliza agent loop.

    This service implements the canonical flow:
    1. Save incoming message to memory
    2. Compose state from providers
    3. Generate response with MESSAGE_HANDLER_TEMPLATE (includes action selection)
    4. Parse actions from XML response
    5. Process actions via runtime.process_actions()
    6. Run evaluators via runtime.evaluate()
    7. Return result

    """

    async def handle_message(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        callback: HandlerCallback | None = None,
        options: MessageProcessingOptions | None = None,
    ) -> MessageProcessingResult:
        """Handle an incoming message through the full agent loop.

        Args:
            runtime: The Eliza runtime.
            message: The incoming message.
            callback: Optional callback for streaming responses.

        Returns:
            MessageProcessingResult with response content and state.

        """
        from elizaos.prompts import (
            MESSAGE_HANDLER_TEMPLATE,
            MULTI_STEP_DECISION_TEMPLATE,
            MULTI_STEP_SUMMARY_TEMPLATE,
            POST_ACTION_DECISION_TEMPLATE,
            SHOULD_RESPOND_TEMPLATE,
        )
        from elizaos.runtime import DynamicPromptOptions
        from elizaos.utils import compose_prompt_from_state

        _ = runtime.start_run(message.room_id)
        response_id = str(uuid.uuid4())
        agent_id = str(runtime.agent_id)
        room_id = str(message.room_id)
        keep_existing_responses = (
            options.keep_existing_responses
            if options and options.keep_existing_responses is not None
            else _parse_bool(runtime.get_setting("BASIC_CAPABILITIES_KEEP_RESP"))
        )
        _set_latest_response_id(agent_id, room_id, response_id)

        # Check for custom message handler template from character
        template = MESSAGE_HANDLER_TEMPLATE
        if runtime.character.templates and "messageHandlerTemplate" in runtime.character.templates:
            template = runtime.character.templates["messageHandlerTemplate"]
        start_time = time.time()

        # Optional trajectory logging (end-to-end capture)
        traj_step_id: str | None = None
        if message.metadata is not None:
            maybe_step = getattr(message.metadata, "trajectoryStepId", None)
            if isinstance(maybe_step, str) and maybe_step:
                traj_step_id = maybe_step

        from typing import Protocol, runtime_checkable

        @runtime_checkable
        class _TrajectoryLogger(Protocol):
            def log_llm_call(
                self,
                *,
                step_id: str,
                model: str,
                system_prompt: str,
                user_prompt: str,
                response: str,
                purpose: str,
                action_type: str | None = None,
                model_version: str | None = None,
                temperature: float = 0.7,
                max_tokens: int = 2048,
                top_p: float | None = None,
                prompt_tokens: int | None = None,
                completion_tokens: int | None = None,
                latency_ms: int | None = None,
                reasoning: str | None = None,
            ) -> str: ...

            def log_provider_access(
                self,
                *,
                step_id: str,
                provider_name: str,
                data: dict[str, str | int | float | bool | None],
                purpose: str,
                query: dict[str, str | int | float | bool | None] | None = None,
            ) -> None: ...

        traj_svc = runtime.get_service("trajectories")
        traj_logger = traj_svc if isinstance(traj_svc, _TrajectoryLogger) else None

        def _as_json_scalar(value: object) -> str | int | float | bool | None:
            if value is None:
                return None
            if isinstance(value, (str, int, float, bool)):
                if isinstance(value, str):
                    return value[:2000]
                return value
            return str(value)[:2000]

        from elizaos.trajectory_context import CURRENT_TRAJECTORY_STEP_ID

        token = CURRENT_TRAJECTORY_STEP_ID.set(traj_step_id)
        try:
            check_should_respond = runtime.is_check_should_respond_enabled()
            if not check_should_respond:
                runtime.logger.debug(
                    "check_should_respond disabled, always responding (ChatGPT mode)"
                )

            # Step 1: Save incoming message to memory (if adapter available)
            if not message.id:
                message.id = as_uuid(str(uuid.uuid4()))
            try:
                existing_memory = await runtime.get_memory_by_id(message.id)
                if not existing_memory:
                    await runtime.create_memory(message, "messages")
            except RuntimeError:
                # No database adapter - skip persistence (benchmark mode)
                runtime.logger.debug("No database adapter, skipping message persistence")

            if check_should_respond:
                should_respond, skip_evaluation, _reason = _should_respond_prefilter(
                    runtime, message
                )

                # Compose state only once we know the message will either go
                # through the classifier or continue into response generation.
                state = await runtime.compose_state(message)

                if skip_evaluation:
                    if not should_respond:
                        return await self._handle_terminal_decision(
                            runtime=runtime,
                            message=message,
                            state=state,
                            callback=callback,
                            terminal_action="IGNORE",
                            keep_existing_responses=keep_existing_responses,
                            response_id=response_id,
                        )
                else:
                    decision_schema = [
                        SchemaRow(
                            field="name",
                            description="The name of the agent responding",
                            validate_field=False,
                            stream_field=False,
                        ),
                        SchemaRow(
                            field="reasoning",
                            description="Your reasoning for this decision",
                            validate_field=False,
                            stream_field=False,
                        ),
                        SchemaRow(
                            field="action",
                            description="RESPOND | IGNORE | STOP",
                            validate_field=False,
                            stream_field=False,
                        ),
                    ]
                    decision_result = await runtime.dynamic_prompt_exec_from_state(
                        state=state,
                        prompt=runtime.character.templates.get(
                            "shouldRespondTemplate", SHOULD_RESPOND_TEMPLATE
                        )
                        if runtime.character.templates
                        else SHOULD_RESPOND_TEMPLATE,
                        schema=decision_schema,
                        options=DynamicPromptOptions(
                            model_size="small",
                            force_format="xml",
                        ),
                    )
                    decision_action = (
                        str(decision_result.get("action", "RESPOND")).strip().upper()
                        if decision_result
                        else "RESPOND"
                    )
                    if decision_action in {"IGNORE", "STOP"}:
                        return await self._handle_terminal_decision(
                            runtime=runtime,
                            message=message,
                            state=state,
                            callback=callback,
                            terminal_action=decision_action,
                            keep_existing_responses=keep_existing_responses,
                            response_id=response_id,
                        )
            else:
                # Step 2: Compose state from providers
                state = await runtime.compose_state(message)

            if check_should_respond:
                runtime.logger.debug("shouldRespond prefilter passed")

            # Optional: multi-step strategy (TypeScript parity)
            use_multi_step = _parse_bool(runtime.get_setting("USE_MULTI_STEP"))
            max_multi_step_iterations = _parse_int(
                runtime.get_setting("MAX_MULTISTEP_ITERATIONS"), default=6
            )
            if use_multi_step:
                return await self._run_multi_step_core(
                    runtime=runtime,
                    message=message,
                    state=state,
                    callback=callback,
                    keep_existing_responses=keep_existing_responses,
                    response_id=response_id,
                    max_iterations=max_multi_step_iterations,
                    decision_template=runtime.character.templates.get(
                        "multiStepDecisionTemplate", MULTI_STEP_DECISION_TEMPLATE
                    )
                    if runtime.character.templates
                    else MULTI_STEP_DECISION_TEMPLATE,
                    summary_template=runtime.character.templates.get(
                        "multiStepSummaryTemplate", MULTI_STEP_SUMMARY_TEMPLATE
                    )
                    if runtime.character.templates
                    else MULTI_STEP_SUMMARY_TEMPLATE,
                    compose_prompt_from_state=compose_prompt_from_state,
                )

            # Step 3-5: Use dynamicPromptExecFromState for structured message response
            schema = [
                SchemaRow(
                    field="thought",
                    description="Your internal reasoning about the message and what to do",
                    required=True,
                    validate_field=False,
                    stream_field=False,
                ),
                SchemaRow(
                    field="providers",
                    description="List of providers to use for additional context (comma-separated)",
                    validate_field=False,
                    stream_field=False,
                ),
                SchemaRow(
                    field="actions",
                    description="List of actions to take (comma-separated)",
                    required=True,
                    validate_field=False,
                    stream_field=False,
                ),
                SchemaRow(
                    field="params",
                    description='JSON object with action parameters, e.g. {"ACTION_NAME": {"param": "value"}}',
                    validate_field=False,
                    stream_field=False,
                ),
                SchemaRow(
                    field="text",
                    description="The text response to send to the user",
                    stream_field=True,
                ),
                SchemaRow(
                    field="simple",
                    description="Whether this is a simple response (true/false)",
                    validate_field=False,
                    stream_field=False,
                ),
            ]

            parsed_response = await runtime.dynamic_prompt_exec_from_state(
                state=state,
                prompt=template,
                schema=schema,
                options=DynamicPromptOptions(
                    model_size="large",
                    force_format="xml",
                    required_fields=["thought", "actions"],
                ),
            )

            # Handle complete generation failure
            if parsed_response is None:
                runtime.logger.error("Generation failed completely - returning did_respond=False")
                return MessageProcessingResult(
                    did_respond=False,
                    response_content=None,
                    response_messages=[],
                    state=state,
                )

            thought, actions, providers, response_text, params, raw_response_str = (
                self._extract_response_fields(parsed_response)
            )
            actions = self._normalize_actions(actions, response_text)

            if not runtime.is_action_planning_enabled() and len(actions) > 1:
                actions = actions[:1]

            if self._is_terminal_control(actions):
                return await self._handle_terminal_decision(
                    runtime=runtime,
                    message=message,
                    state=state,
                    callback=callback,
                    terminal_action=actions[0],
                    keep_existing_responses=keep_existing_responses,
                    response_id=response_id,
                )

            # Step 5b: If actions require params but none were provided, run a parameter-repair pass
            # using the SAME model. This keeps behavior canonical while preventing "action without params"
            # failures from stalling the agent.
            if actions:
                params = await self._repair_missing_action_params(
                    runtime=runtime,
                    message=message,
                    state=state,
                    actions=actions,
                    providers=providers,
                    raw_response=raw_response_str,
                    params=params,
                    template=template,
                )

            # Log parsed action selection / params as a structured provider access
            if traj_step_id and traj_logger is not None:
                try:
                    traj_logger.log_provider_access(
                        step_id=traj_step_id,
                        provider_name="MESSAGE_SERVICE",
                        data={
                            "actions": _as_json_scalar(",".join(actions)),
                            "providers": _as_json_scalar(",".join(providers)),
                            "hasParams": _as_json_scalar(bool(params)),
                            "params": _as_json_scalar(str(params)[:2000]),
                        },
                        purpose="parsed_response",
                        query={"roomId": _as_json_scalar(str(message.room_id))},
                    )
                except Exception as e:
                    runtime.logger.debug(f"Trajectory logger failed: {e}")

            # If no text parsed, use raw response (fallback for non-XML responses)
            if not response_text:
                response_text = raw_response_str

            # Benchmark mode: force action-based response generation.
            # If the context-bench provider is active, require REPLY to run so the
            # full Provider -> Model -> Action -> Evaluator loop is exercised.
            benchmark_mode = False
            if state.values:
                # Handle both dict-like and protobuf StateValues
                if hasattr(state.values, "get") and callable(state.values.get):
                    benchmark_mode = bool(state.values.get("benchmark_has_context"))
                elif hasattr(state.values, "extra"):
                    # Protobuf - check extra map field
                    extra = state.values.extra
                    if hasattr(extra, "get") and callable(extra.get):
                        benchmark_mode = bool(extra.get("benchmark_has_context", ""))
            if benchmark_mode:
                if not actions:
                    actions = ["REPLY"]
                if not providers:
                    providers = ["CONTEXT_BENCH"]
                # Suppress any direct planner answer; the REPLY action should generate
                # the final user-visible answer (captured via callback).
                if "REPLY" in actions:
                    response_text = ""

            runtime.logger.debug(
                f"Parsed response: actions={actions}, providers={providers}, "
                f"text_length={len(response_text)}, thought_length={len(thought)}"
            )

            # Step 6: Create response content with actions
            response_content = self._build_response_content(
                thought=thought,
                actions=actions,
                providers=providers,
                response_text=response_text,
                params=params,
            )

            if (
                not keep_existing_responses
                and _get_latest_response_id(agent_id, room_id) != response_id
            ):
                runtime.logger.info("Response discarded - newer message being processed")
                return MessageProcessingResult(
                    did_respond=False,
                    response_content=None,
                    response_messages=[],
                    state=state,
                )

            response_memory = self._build_response_memory(runtime, message, response_content)

            # Save response memory (if adapter available)
            try:
                await runtime.create_memory(response_memory, "messages")
            except RuntimeError:
                # No database adapter - skip persistence (benchmark mode)
                runtime.logger.debug("No database adapter, skipping response persistence")

            # Emit MESSAGE_SENT event after successfully creating response memory
            await runtime.emit_event(
                "MESSAGE_SENT",
                {
                    "runtime": runtime,
                    "source": "message-service",
                    "message": response_memory,
                },
            )

            responses = [response_memory]

            # Step 7: Process actions via runtime.process_actions()
            # By default, we treat a plain REPLY as a chat-style response.
            # In benchmark mode (context-bench), we WANT to execute REPLY so the full
            # Provider -> Model -> Action -> Evaluator loop is exercised.
            if actions and (benchmark_mode or not (len(actions) == 1 and actions[0] == "REPLY")):
                runtime.logger.debug(f"Processing {len(actions)} actions: {actions}")
                await runtime.process_actions(message, responses, state, callback)

                if (
                    message.id
                    and self._continue_after_actions_enabled(runtime)
                    and self._should_continue_after_actions(actions)
                ):
                    (
                        continuation_content,
                        continuation_messages,
                        state,
                    ) = await self._run_post_action_continuation(
                        runtime=runtime,
                        message=message,
                        state=state,
                        callback=callback,
                        template=runtime.character.templates.get(
                            "postActionDecisionTemplate", POST_ACTION_DECISION_TEMPLATE
                        )
                        if runtime.character.templates
                        else POST_ACTION_DECISION_TEMPLATE,
                        initial_action_results=runtime.get_action_results(message.id),
                    )
                    if continuation_messages:
                        responses.extend(continuation_messages)
                    if continuation_content is not None:
                        response_content = continuation_content
            elif callback:
                # Simple chat-style response
                await callback(response_content)

            # Step 8: Run evaluators via runtime.evaluate()
            runtime.logger.debug("Running evaluators")
            did_respond = not self._is_terminal_control(
                list(response_content.actions) if response_content.actions else []
            )
            await runtime.evaluate(
                message,
                state,
                did_respond=did_respond,
                callback=callback,
                responses=responses,
            )

            _ = time.time() - start_time

            return MessageProcessingResult(
                did_respond=did_respond,
                response_content=response_content,
                response_messages=responses,
                state=state,
            )

        except Exception as e:
            import traceback as _tb

            runtime.logger.error(
                f"Error processing message: {e}\n{''.join(_tb.format_exception(e))}"
            )
            raise
        finally:
            _clear_latest_response_id(agent_id, room_id, response_id)
            CURRENT_TRAJECTORY_STEP_ID.reset(token)
            runtime.end_run()

    def _extract_response_fields(
        self,
        parsed_response: dict[str, object] | None,
    ) -> tuple[str, list[str], list[str], str, dict[str, list[dict[str, str]]], str]:
        import json as json_module

        thought = str(parsed_response.get("thought", "")) if parsed_response else ""
        actions_raw = str(parsed_response.get("actions", "REPLY")) if parsed_response else "REPLY"
        providers_raw = str(parsed_response.get("providers", "")) if parsed_response else ""
        response_text = str(parsed_response.get("text", "")) if parsed_response else ""

        actions = [a.strip().upper() for a in actions_raw.split(",") if a.strip()]
        providers = [p.strip() for p in providers_raw.split(",") if p.strip()]

        params: dict[str, list[dict[str, str]]] = {}
        if parsed_response:
            params_raw = parsed_response.get("params", "")
            if params_raw:
                if isinstance(params_raw, str):
                    try:
                        params_parsed = json_module.loads(params_raw)
                        if isinstance(params_parsed, dict):
                            for action_name, action_params in params_parsed.items():
                                if isinstance(action_params, dict):
                                    params[str(action_name).upper()] = [action_params]
                    except json_module.JSONDecodeError:
                        pass
                elif isinstance(params_raw, dict):
                    for action_name, action_params in params_raw.items():
                        if isinstance(action_params, dict):
                            params[str(action_name).upper()] = [action_params]

        raw_response_str = json_module.dumps(parsed_response) if parsed_response else ""
        return thought, actions, providers, response_text, params, raw_response_str

    def _normalize_actions(self, actions: list[str], response_text: str) -> list[str]:
        normalized = [a.strip().upper() for a in actions if a.strip()]
        if not normalized:
            return ["IGNORE"]

        if len(normalized) > 1 and "IGNORE" in normalized:
            if response_text.strip():
                normalized = [a for a in normalized if a != "IGNORE"] or ["REPLY"]
            else:
                normalized = ["IGNORE"]

        if len(normalized) > 1 and "STOP" in normalized:
            normalized = [a for a in normalized if a != "STOP"] or ["STOP"]

        return normalized

    def _is_terminal_control(self, actions: list[str]) -> bool:
        return len(actions) == 1 and actions[0].upper() in {"IGNORE", "STOP"}

    def _is_stop_response(self, content: Content | None) -> bool:
        return bool(
            content
            and content.actions
            and len(content.actions) == 1
            and str(content.actions[0]).upper() == "STOP"
        )

    def _should_continue_after_actions(self, actions: list[str]) -> bool:
        return any(a.upper() not in {"REPLY", "IGNORE", "STOP"} for a in actions)

    def _continue_after_actions_enabled(self, runtime: IAgentRuntime) -> bool:
        setting = runtime.get_setting("CONTINUE_AFTER_ACTIONS")
        if setting is None:
            return True
        return _parse_bool(setting)

    def _build_response_content(
        self,
        *,
        thought: str,
        actions: list[str],
        providers: list[str],
        response_text: str,
        params: dict[str, list[dict[str, str]]],
    ) -> Content:
        response_content = Content(
            text=response_text,
            thought=thought if thought else None,
            actions=actions if actions else None,
            providers=providers if providers else None,
        )
        if params:
            if not response_content.data:
                response_content.data = Struct()
            response_content.data.update({"params": params})
        return response_content

    def _build_response_memory(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        response_content: Content,
    ) -> Memory:
        return Memory(
            id=as_uuid(str(uuid.uuid4())),
            entity_id=runtime.agent_id,
            agent_id=runtime.agent_id,
            room_id=message.room_id,
            content=response_content,
            created_at=int(time.time() * 1000),
        )

    async def _handle_terminal_decision(
        self,
        *,
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        callback: HandlerCallback | None,
        terminal_action: str,
        keep_existing_responses: bool,
        response_id: str,
    ) -> MessageProcessingResult:
        if (
            not keep_existing_responses
            and _get_latest_response_id(str(runtime.agent_id), str(message.room_id)) != response_id
        ):
            runtime.logger.info("Ignore response discarded - newer message being processed")
            await runtime.evaluate(
                message,
                state,
                did_respond=False,
                callback=callback,
                responses=[],
            )
            return MessageProcessingResult(
                did_respond=False,
                response_content=None,
                response_messages=[],
                state=state,
            )

        terminal_action = terminal_action.upper()
        terminal_content = Content(
            thought=(
                "Agent decided to stop and end the run."
                if terminal_action == "STOP"
                else "Agent decided not to respond to this message."
            ),
            actions=[terminal_action],
            simple=True,
        )

        if callback:
            await callback(terminal_content)

        terminal_memory = self._build_response_memory(runtime, message, terminal_content)
        try:
            await runtime.create_memory(terminal_memory, "messages")
        except RuntimeError:
            runtime.logger.debug("No database adapter, skipping terminal persistence")

        await runtime.evaluate(
            message,
            state,
            did_respond=False,
            callback=callback,
            responses=[],
        )

        return MessageProcessingResult(
            did_respond=False,
            response_content=None,
            response_messages=[],
            state=state,
        )

    async def _run_post_action_continuation(
        self,
        *,
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        callback: HandlerCallback | None,
        template: str,
        initial_action_results: list[object],
    ) -> tuple[Content | None, list[Memory], State]:
        from elizaos.runtime import DynamicPromptOptions

        if not message.id or not initial_action_results:
            return None, [], state

        trace_action_results = list(initial_action_results)
        response_messages: list[Memory] = []
        response_content: Content | None = None
        accumulated_state = state
        max_iterations = _parse_int(runtime.get_setting("MAX_MULTISTEP_ITERATIONS"), default=6)

        continuation_schema = [
            SchemaRow(
                field="thought",
                description="Your internal reasoning about the next step",
                validate_field=False,
                stream_field=False,
            ),
            SchemaRow(
                field="providers",
                description="List of providers to use for additional context (comma-separated)",
                validate_field=False,
                stream_field=False,
            ),
            SchemaRow(
                field="actions",
                description="List of actions to take (comma-separated)",
                required=True,
                validate_field=False,
                stream_field=False,
            ),
            SchemaRow(
                field="params",
                description='JSON object with action parameters, e.g. {"ACTION_NAME": {"param": "value"}}',
                validate_field=False,
                stream_field=False,
            ),
            SchemaRow(
                field="text",
                description="The text response to send to the user",
                stream_field=True,
            ),
            SchemaRow(
                field="simple",
                description="Whether this is a simple response (true/false)",
                validate_field=False,
                stream_field=False,
            ),
        ]

        for _ in range(max(1, int(max_iterations))):
            accumulated_state = await runtime.compose_state(
                message,
                include_list=["RECENT_MESSAGES", "ACTION_STATE", "ACTIONS", "PROVIDERS"],
                only_include=True,
                skip_cache=True,
            )
            accumulated_state.data.ClearField("action_results")
            accumulated_state.data.action_results.extend(trace_action_results)
            accumulated_state.values.extra["actionResults"] = _format_action_results(
                trace_action_results
            )

            parsed_response = await runtime.dynamic_prompt_exec_from_state(
                state=accumulated_state,
                prompt=template,
                schema=continuation_schema,
                options=DynamicPromptOptions(
                    model_size="large",
                    force_format="xml",
                    required_fields=["actions"],
                ),
            )
            if parsed_response is None:
                break

            thought, actions, providers, response_text, params, raw_response_str = (
                self._extract_response_fields(parsed_response)
            )
            actions = self._normalize_actions(actions, response_text)

            if not runtime.is_action_planning_enabled() and len(actions) > 1:
                actions = actions[:1]

            if self._is_terminal_control(actions):
                response_content = self._build_response_content(
                    thought=thought,
                    actions=actions,
                    providers=providers,
                    response_text=response_text,
                    params=params,
                )
                break

            if actions:
                params = await self._repair_missing_action_params(
                    runtime=runtime,
                    message=message,
                    state=accumulated_state,
                    actions=actions,
                    providers=providers,
                    raw_response=raw_response_str,
                    params=params,
                    template=template,
                )

            response_content = self._build_response_content(
                thought=thought,
                actions=actions,
                providers=providers,
                response_text=response_text,
                params=params,
            )
            response_memory = self._build_response_memory(runtime, message, response_content)

            try:
                await runtime.create_memory(response_memory, "messages")
            except RuntimeError:
                runtime.logger.debug(
                    "No database adapter, skipping continuation response persistence"
                )

            await runtime.emit_event(
                "MESSAGE_SENT",
                {
                    "runtime": runtime,
                    "source": "message-service",
                    "message": response_memory,
                },
            )
            response_messages.append(response_memory)

            if len(actions) == 1 and actions[0] == "REPLY":
                if callback:
                    await callback(response_content)
                break

            await runtime.process_actions(
                message,
                [response_memory],
                accumulated_state,
                callback,
            )

            if not self._should_continue_after_actions(actions):
                break

            latest_results = runtime.get_action_results(message.id)
            if len(latest_results) <= len(trace_action_results):
                break
            trace_action_results = list(latest_results)

        return response_content, response_messages, accumulated_state

    def _build_canonical_prompt(
        self,
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        template: str,
    ) -> str:
        """Build the canonical prompt using MESSAGE_HANDLER_TEMPLATE.

        Args:
            runtime: The Eliza runtime.
            message: The incoming message.
            state: Composed state from providers.
            template: The message handler template.

        Returns:
            Formatted prompt string.

        """
        character = runtime.character
        user_text = message.content.text or ""

        # Get provider context from state
        context = state.text if state.text else ""
        # Always include the current user message explicitly so the model has the
        # latest instruction even when RECENT_MESSAGES is unavailable (e.g. no DB adapter).
        if user_text:
            context = f"{context}\n\n# Current Message\nUser: {user_text}".strip()

        # Build values for template substitution
        # Handle both dict-like and protobuf StateValues
        if state.values:
            if hasattr(state.values, "agent_name"):
                # Protobuf StateValues
                values = {
                    "agentName": state.values.agent_name or character.name,
                    "actionNames": state.values.action_names or "",
                    "providers": state.values.providers or context,
                }
            elif hasattr(state.values, "items"):
                # Dict-like
                values = dict(state.values)
            else:
                values = {}
        else:
            values = {}

        values["agentName"] = character.name
        values["providers"] = context

        # Add user message to context
        if "recentMessages" not in values:
            values["recentMessages"] = f"User: {user_text}"

        # Simple template substitution
        prompt = template
        for key, value in values.items():
            placeholder = "{{" + key + "}}"
            prompt = prompt.replace(placeholder, str(value))

        return prompt

    async def _run_multi_step_core(
        self,
        *,
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        callback: HandlerCallback | None,
        keep_existing_responses: bool,
        response_id: str,
        max_iterations: int,
        decision_template: str,
        summary_template: str,
        compose_prompt_from_state: Callable[..., str],
    ) -> MessageProcessingResult:
        """Iterative multi-step workflow (TypeScript parity).

        Each iteration:
        - (Re)compose core state (RECENT_MESSAGES/ACTIONS/PROVIDERS/ACTION_STATE)
        - Ask the model for the next providers + at most one action
        - Run selected providers (optional)
        - Execute selected action (optional)
        - Accumulate action results
        """
        import json

        from elizaos.runtime import DynamicPromptOptions
        from elizaos.types.components import ActionResult

        trace_results: list[ActionResult] = []
        last_action_results_len = 0
        last_thought = ""

        iteration = 0
        while iteration < max(1, int(max_iterations)):
            iteration += 1

            # Keep state fresh each iteration; include descriptions lists
            state = await runtime.compose_state(
                message,
                include_list=["RECENT_MESSAGES", "ACTION_STATE", "ACTIONS", "PROVIDERS"],
                only_include=True,
                skip_cache=True,
            )
            state.data.ClearField("action_results")
            state.data.action_results.extend(trace_results)
            state.values.extra["actionResults"] = _format_action_results(trace_results)

            # Use dynamicPromptExecFromState for multi-step decision
            decision_schema = [
                SchemaRow(
                    field="thought",
                    description="Your reasoning for the selected providers and/or action",
                    validate_field=False,
                    stream_field=False,
                ),
                SchemaRow(
                    field="providers",
                    description="Comma-separated list of providers to call",
                    validate_field=False,
                    stream_field=False,
                ),
                SchemaRow(
                    field="action",
                    description="Name of the action to execute (can be empty)",
                    validate_field=False,
                    stream_field=False,
                ),
                SchemaRow(
                    field="parameters",
                    description="JSON object with parameter names and values",
                    validate_field=False,
                    stream_field=False,
                ),
                SchemaRow(
                    field="isFinish",
                    description="true if task is complete, false otherwise",
                    validate_field=False,
                    stream_field=False,
                ),
            ]

            decision_result = await runtime.dynamic_prompt_exec_from_state(
                state=state,
                prompt=decision_template,
                schema=decision_schema,
                options=DynamicPromptOptions(
                    model_size="large",
                    force_format="xml",
                ),
            )

            thought = str(decision_result.get("thought", "")) if decision_result else ""
            action_name = str(decision_result.get("action", "")).strip() if decision_result else ""
            providers_csv = (
                str(decision_result.get("providers", "")).strip() if decision_result else ""
            )
            parameters_raw = decision_result.get("parameters", "") if decision_result else ""
            is_finish_raw = (
                str(decision_result.get("isFinish", "")).strip().lower() if decision_result else ""
            )
            is_finish = is_finish_raw in ("true", "yes", "1")

            # Parse parameters (may be JSON string or dict)
            action_params: dict[str, Any] = {}
            if parameters_raw:
                if isinstance(parameters_raw, str):
                    try:
                        parsed_params = json.loads(parameters_raw)
                        if isinstance(parsed_params, dict):
                            action_params = parsed_params
                    except json.JSONDecodeError:
                        pass
                elif isinstance(parameters_raw, dict):
                    action_params = parameters_raw

            last_thought = thought

            if is_finish:
                break

            providers = [p.strip() for p in providers_csv.split(",") if p.strip()]
            if providers:
                # Execute selected providers only; bypass cache so they run
                state = await runtime.compose_state(
                    message,
                    include_list=providers,
                    only_include=True,
                    skip_cache=True,
                )

            if action_name:
                # Synthetic response memory to drive runtime.process_actions()
                response_id = as_uuid(str(uuid.uuid4()))
                response_content = Content(
                    text="",
                    thought=thought if thought else None,
                    actions=[action_name],
                    providers=providers if providers else None,
                    params=json.dumps(action_params) if action_params else None,
                )
                response_memory = Memory(
                    id=response_id,
                    entity_id=runtime.agent_id,
                    agent_id=runtime.agent_id,
                    room_id=message.room_id,
                    content=response_content,
                    created_at=int(time.time() * 1000),
                )
                await runtime.process_actions(message, [response_memory], state, callback)

                # Pull newly recorded action results from runtime (if message.id is set)
                if message.id:
                    all_results = runtime.get_action_results(message.id)
                    if len(all_results) > last_action_results_len:
                        trace_results.extend(all_results[last_action_results_len:])
                        last_action_results_len = len(all_results)

        # Final summary
        state = await runtime.compose_state(
            message,
            include_list=["RECENT_MESSAGES", "ACTION_STATE", "ACTIONS", "PROVIDERS"],
            only_include=True,
            skip_cache=True,
        )
        state.data.ClearField("action_results")
        state.data.action_results.extend(trace_results)
        state.values.extra["actionResults"] = _format_action_results(trace_results)
        state.values.extra["recentMessage"] = last_thought
        # Best-effort fill template values
        bio_val = runtime.character.bio if isinstance(runtime.character.bio, str) else ""
        state.values.extra["bio"] = bio_val
        state.values.extra["system"] = runtime.character.system or ""
        state.values.extra["messageDirections"] = ""

        # Use dynamicPromptExecFromState for final summary
        summary_schema = [
            SchemaRow(
                field="thought",
                description="Your internal reasoning about the summary",
                validate_field=False,
                stream_field=False,
            ),
            SchemaRow(
                field="text",
                description="The final summary message to send to the user",
                required=True,
                stream_field=True,
            ),
        ]

        summary_result = await runtime.dynamic_prompt_exec_from_state(
            state=state,
            prompt=summary_template,
            schema=summary_schema,
            options=DynamicPromptOptions(
                model_size="large",
                force_format="xml",
                required_fields=["text"],
            ),
        )

        # Handle summary generation failure
        if summary_result is None:
            runtime.logger.error(
                "Multi-step summary generation failed - returning did_respond=False"
            )
            return MessageProcessingResult(
                did_respond=False,
                response_content=None,
                response_messages=[],
                state=state,
            )

        final_thought = str(summary_result.get("thought", ""))
        final_text = str(summary_result.get("text", ""))

        # If text is empty, treat as failure
        if not final_text.strip():
            runtime.logger.error(
                "Multi-step summary returned empty text - returning did_respond=False"
            )
            return MessageProcessingResult(
                did_respond=False,
                response_content=None,
                response_messages=[],
                state=state,
            )

        if (
            not keep_existing_responses
            and _get_latest_response_id(str(runtime.agent_id), str(message.room_id)) != response_id
        ):
            runtime.logger.info("Response discarded - newer message being processed")
            return MessageProcessingResult(
                did_respond=False,
                response_content=None,
                response_messages=[],
                state=state,
            )

        final_content = Content(text=final_text, thought=final_thought)
        if callback:
            await callback(final_content)

        return MessageProcessingResult(
            did_respond=True,
            response_content=final_content,
            response_messages=[],
            state=state,
        )

    async def _repair_missing_action_params(
        self,
        *,
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        actions: list[str],
        providers: list[str],
        raw_response: str,
        params: dict[str, list[dict[str, str]]],
        template: str,
    ) -> dict[str, list[dict[str, str]]]:
        """
        Ensure required action parameters are present.

        If the model selected actions that require parameters but omitted <params>,
        we ask the same model to return ONLY a <params> block.
        """
        # Build a requirement map for actions that have parameters
        required_by_action: dict[str, list[str]] = {}
        for a in runtime.actions:
            action_name = a.name.upper()
            if action_name not in [x.upper() for x in actions]:
                continue
            if not a.parameters:
                continue
            required: list[str] = []
            for p in a.parameters:
                if p.required:
                    required.append(p.name)
            if required:
                required_by_action[action_name] = required

        if not required_by_action:
            return params

        action_counts: dict[str, int] = {}
        for a in actions:
            action_counts[a.upper()] = action_counts.get(a.upper(), 0) + 1

        def _entry_has_required(entry: dict[str, str], req: list[str]) -> bool:
            for r in req:
                if r in entry:
                    continue
                found = False
                for k in entry:
                    if isinstance(k, str) and k.lower() == r.lower():
                        found = True
                        break
                if not found:
                    return False
            return True

        missing_actions: dict[str, list[str]] = {}
        for action_name, req in required_by_action.items():
            expected = action_counts.get(action_name, 0)
            existing_entries = params.get(action_name, [])
            if len(existing_entries) < expected:
                missing_actions[action_name] = req
                continue
            for entry in existing_entries[:expected]:
                if not _entry_has_required(entry, req):
                    missing_actions[action_name] = req
                    break

        if not missing_actions:
            return params

        runtime.logger.warning(
            f"Missing required action params for: {', '.join(sorted(missing_actions.keys()))}. "
            "Attempting param repair."
        )

        # Compose a minimal "repair" prompt. Prefer JSON output for robustness.
        missing_lines = "\n".join(
            f"- {a}: required params = {', '.join(req)}" for a, req in missing_actions.items()
        )
        user_text = message.content.text or ""

        actions_json = ", ".join([f'"{a.upper()}"' for a in actions if isinstance(a, str)])
        repair_prompt = (
            "You previously selected actions that require parameters, but you did not provide them.\n\n"
            f"Missing params:\n{missing_lines}\n\n"
            "Return ONLY JSON (no code fences).\n"
            "IMPORTANT: return a JSON ARRAY of action-parameter objects IN THE SAME ORDER as the action list.\n"
            "Action list:\n"
            f"[{actions_json}]\n\n"
            "Examples:\n"
            '[{"EXECUTE": {"command": "ls -la /workspace"}}]\n'
            '[{"WRITE_FILE": {"path": "/workspace/x.txt", "content": "line1\\nline2\\n"}}]\n\n'
            "IMPORTANT:\n"
            "- The JSON must be directly parseable.\n"
            "- For WRITE_FILE.content, include real newlines using \\n escapes.\n\n"
            f"Current message:\n{user_text}\n\n"
            "Your previous response (for reference):\n"
            f"{raw_response}\n"
        )

        # Use the same model handler as the main message handler.
        repaired_raw = await runtime.use_model(
            ModelType.TEXT_LARGE.value,
            {
                "prompt": repair_prompt,
                "system": runtime.character.system,
                "temperature": 0.0,
            },
        )
        repaired_str = str(repaired_raw)
        repaired_params = _parse_params_from_xml(repaired_str)
        if not repaired_params:
            runtime.logger.warning(
                "Param repair failed to parse. "
                f"Repair model output (truncated): {repaired_str[:500]!r}"
            )
            return params

        merged: dict[str, list[dict[str, str]]] = {**params}
        for action_name, entries in repaired_params.items():
            merged.setdefault(action_name, [])
            merged[action_name].extend(entries)

        return merged

    async def _handle_message_stream_impl(
        self,
        runtime: IAgentRuntime,
        message: Memory,
    ) -> AsyncIterator[str | StreamingMessageResult]:
        """Internal implementation of streaming message handling."""
        _ = runtime.start_run(message.room_id)

        try:
            check_should_respond = runtime.is_check_should_respond_enabled()
            if not check_should_respond:
                runtime.logger.debug(
                    "check_should_respond disabled, always responding (ChatGPT mode)"
                )

            runtime.logger.debug("Saving incoming message to memory")
            if message.id:
                existing_memory = await runtime.get_memory_by_id(message.id)
                if not existing_memory:
                    await runtime.create_memory(message, "messages")
            else:
                message.id = as_uuid(str(uuid.uuid4()))
                await runtime.create_memory(message, "messages")

            # Compose state from providers
            state = await runtime.compose_state(message)

            # Build the prompt using canonical template
            from elizaos.prompts import MESSAGE_HANDLER_TEMPLATE

            template = MESSAGE_HANDLER_TEMPLATE
            if (
                runtime.character.templates
                and "messageHandlerTemplate" in runtime.character.templates
            ):
                template = runtime.character.templates["messageHandlerTemplate"]
            prompt = self._build_canonical_prompt(runtime, message, state, template)

            # Collect full response while streaming
            full_response_parts: list[str] = []

            # Stream response using the streaming model
            async for chunk in runtime.use_model_stream(
                ModelType.TEXT_LARGE_STREAM.value,
                {
                    "prompt": prompt,
                    "system": runtime.character.system,
                    "temperature": 0.7,
                },
            ):
                full_response_parts.append(chunk)
                yield chunk

            # Build the complete response
            full_response = "".join(full_response_parts)
            response_content = Content(text=full_response)
            response_id = as_uuid(str(uuid.uuid4()))
            response_memory = Memory(
                id=response_id,
                entityId=runtime.agent_id,
                agentId=runtime.agent_id,
                roomId=message.room_id,
                content=response_content,
                createdAt=int(time.time() * 1000),
            )

            # Save response memory
            runtime.logger.debug("Saving response to memory")
            await runtime.create_memory(response_memory, "messages")

            # Yield final result with metadata
            yield StreamingMessageResult(
                response_memory=response_memory,
                state=state,
            )

        except Exception as e:
            runtime.logger.error(f"Error processing streaming message: {e}")
            raise
        finally:
            runtime.end_run()

    def handle_message_stream(
        self,
        runtime: IAgentRuntime,
        message: Memory,
    ) -> AsyncIterator[str | StreamingMessageResult]:
        """
        Process a message and stream the response token by token.

        Yields:
            str: Text chunks as they are generated
            StreamingMessageResult: Final result with metadata (yielded last)
        """
        return self._handle_message_stream_impl(runtime, message)
