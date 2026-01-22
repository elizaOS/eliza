from __future__ import annotations

import asyncio
import re
import uuid
import xml.etree.ElementTree as ET
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from elizaos.action_docs import with_canonical_action_docs, with_canonical_evaluator_docs
from elizaos.logger import Logger, create_logger
from elizaos.settings import decrypt_secret, get_salt
from elizaos.types.agent import Character, TemplateType
from elizaos.types.components import (
    Action,
    ActionResult,
    Evaluator,
    HandlerCallback,
    HandlerOptions,
    Provider,
)
from elizaos.types.database import AgentRunSummaryResult, IDatabaseAdapter, Log
from elizaos.types.environment import Entity, Room, World
from elizaos.types.events import EventType
from elizaos.types.memory import Memory
from elizaos.types.model import GenerateTextOptions, GenerateTextResult, LLMMode, ModelType
from elizaos.types.plugin import Plugin, Route
from elizaos.types.primitives import UUID, Content, as_uuid, string_to_uuid
from elizaos.types.runtime import (
    IAgentRuntime,
    RuntimeSettings,
    SendHandlerFunction,
    StreamingModelHandler,
    TargetInfo,
)
from elizaos.types.service import Service
from elizaos.types.state import State, StateData
from elizaos.types.task import TaskWorker
from elizaos.utils import compose_prompt_from_state as _compose_prompt_from_state
from elizaos.utils import get_current_time_ms as _get_current_time_ms

_message_service_class: type | None = None


def _get_message_service_class() -> type:
    global _message_service_class
    if _message_service_class is None:
        from elizaos.services.message_service import DefaultMessageService

        _message_service_class = DefaultMessageService
    return _message_service_class


class ModelHandler:
    def __init__(
        self,
        handler: Callable[[IAgentRuntime, dict[str, Any]], Awaitable[Any]],
        provider: str,
        priority: int = 0,
    ) -> None:
        self.handler = handler
        self.provider = provider
        self.priority = priority


class StreamingModelHandlerWrapper:
    """Wrapper for streaming model handlers."""

    def __init__(
        self,
        handler: StreamingModelHandler,
        provider: str,
        priority: int = 0,
    ) -> None:
        self.handler = handler
        self.provider = provider
        self.priority = priority


_anonymous_agent_counter = 0


class AgentRuntime(IAgentRuntime):
    def __init__(
        self,
        character: Character | None = None,
        agent_id: UUID | None = None,
        adapter: IDatabaseAdapter | None = None,
        plugins: list[Plugin] | None = None,
        settings: RuntimeSettings | None = None,
        conversation_length: int = 32,
        log_level: str = "ERROR",
        disable_basic_capabilities: bool = False,
        enable_extended_capabilities: bool = False,
        action_planning: bool | None = None,
        llm_mode: LLMMode | None = None,
        check_should_respond: bool | None = None,
        enable_autonomy: bool = False,
    ) -> None:
        global _anonymous_agent_counter
        if character is not None:
            resolved_character = character
            is_anonymous = False
        else:
            _anonymous_agent_counter += 1
            resolved_character = Character(
                name=f"Agent-{_anonymous_agent_counter}",
                bio="An anonymous agent",
            )
            is_anonymous = True

        self._capability_disable_basic = disable_basic_capabilities
        self._capability_enable_extended = enable_extended_capabilities
        self._capability_enable_autonomy = enable_autonomy
        self._is_anonymous_character = is_anonymous
        self._action_planning_option = action_planning
        self._llm_mode_option = llm_mode
        self._check_should_respond_option = check_should_respond
        self._agent_id = (
            agent_id or resolved_character.id or string_to_uuid(resolved_character.name)
        )
        self._character = resolved_character
        self._adapter = adapter
        self._conversation_length = conversation_length
        self._settings: RuntimeSettings = settings or {}
        self._enable_autonomy = enable_autonomy or (
            self._settings.get("ENABLE_AUTONOMY") in (True, "true")
        )

        self._providers: list[Provider] = []
        self._actions: list[Action] = []
        self._evaluators: list[Evaluator] = []
        self._plugins: list[Plugin] = []
        self._services: dict[str, list[Service]] = {}
        self._routes: list[Route] = []
        self._events: dict[str, list[Callable[[Any], Awaitable[None]]]] = {}
        self._models: dict[str, list[ModelHandler]] = {}
        self._streaming_models: dict[str, list[StreamingModelHandlerWrapper]] = {}
        self._task_workers: dict[str, TaskWorker] = {}
        self._send_handlers: dict[str, SendHandlerFunction] = {}
        self._state_cache: dict[str, State] = {}
        self._current_run_id: UUID | None = None
        self._current_room_id: UUID | None = None
        self._action_results: dict[str, list[ActionResult]] = {}
        self._logger = create_logger(namespace=resolved_character.name, level=log_level.upper())
        self._initial_plugins = plugins or []
        self._init_complete = False
        self._init_event = asyncio.Event()
        self._message_service: Any = None

    @property
    def logger(self) -> Logger:
        return self._logger

    @property
    def message_service(self) -> Any:
        if self._message_service is None:
            service_class = _get_message_service_class()
            self._message_service = service_class()
        return self._message_service

    @property
    def enable_autonomy(self) -> bool:
        return self._enable_autonomy

    @enable_autonomy.setter
    def enable_autonomy(self, value: bool) -> None:
        self._enable_autonomy = value

    @property
    def agent_id(self) -> UUID:
        return self._agent_id

    @property
    def character(self) -> Character:
        return self._character

    @property
    def providers(self) -> list[Provider]:
        return self._providers

    @property
    def actions(self) -> list[Action]:
        return self._actions

    @property
    def evaluators(self) -> list[Evaluator]:
        return self._evaluators

    @property
    def plugins(self) -> list[Plugin]:
        return self._plugins

    @property
    def services(self) -> dict[str, list[Service]]:
        return self._services

    @property
    def routes(self) -> list[Route]:
        return self._routes

    @property
    def events(self) -> dict[str, list[Callable[[Any], Awaitable[None]]]]:
        """Get registered event handlers."""
        return self._events

    @property
    def state_cache(self) -> dict[str, State]:
        return self._state_cache

    def register_database_adapter(self, adapter: IDatabaseAdapter) -> None:
        self._adapter = adapter

    @property
    def db(self) -> Any:
        if not self._adapter:
            raise RuntimeError("Database adapter not set")
        return self._adapter.db

    async def initialize(self, config: dict[str, str | int | bool | None] | None = None) -> None:
        _ = config
        self.logger.info("Initializing AgentRuntime...")

        if self._adapter:
            await self._adapter.initialize()
            self.logger.debug("Database adapter initialized")

        has_bootstrap = any(p.name == "bootstrap" for p in self._initial_plugins)
        if not has_bootstrap:
            from elizaos.bootstrap import bootstrap_plugin

            self._initial_plugins.insert(0, bootstrap_plugin)

        # Advanced planning is built into core, but only loaded when enabled on the character.
        if getattr(self._character, "advanced_planning", None) is True:
            has_adv = any(p.name == "advanced-planning" for p in self._initial_plugins)
            if not has_adv:
                from elizaos.advanced_planning import advanced_planning_plugin

                # Register after bootstrap so core providers/actions are available.
                insert_at = (
                    1
                    if self._initial_plugins and self._initial_plugins[0].name == "bootstrap"
                    else 0
                )
                self._initial_plugins.insert(insert_at, advanced_planning_plugin)

        # Advanced memory is built into core, but only loaded when enabled on the character.
        if getattr(self._character, "advanced_memory", None) is True:
            has_adv = any(p.name == "memory" for p in self._initial_plugins)
            if not has_adv:
                from elizaos.advanced_memory import advanced_memory_plugin

                insert_at = (
                    1
                    if self._initial_plugins and self._initial_plugins[0].name == "bootstrap"
                    else 0
                )
                self._initial_plugins.insert(insert_at, advanced_memory_plugin)

        for plugin in self._initial_plugins:
            await self.register_plugin(plugin)

        self._init_complete = True
        self._init_event.set()
        self.logger.info("AgentRuntime initialized successfully")

    async def register_plugin(self, plugin: Plugin) -> None:
        from elizaos.plugin import register_plugin

        plugin_to_register = plugin

        if plugin.name == "bootstrap":
            char_settings: dict[str, object] = self._character.settings or {}
            disable_basic = self._capability_disable_basic or (
                char_settings.get("DISABLE_BASIC_CAPABILITIES") in (True, "true")
            )
            enable_extended = self._capability_enable_extended or (
                char_settings.get("ENABLE_EXTENDED_CAPABILITIES") in (True, "true")
            )
            skip_character_provider = self._is_anonymous_character

            enable_autonomy = self._capability_enable_autonomy or (
                char_settings.get("ENABLE_AUTONOMY") in (True, "true")
            )

            if disable_basic or enable_extended or skip_character_provider or enable_autonomy:
                from elizaos.bootstrap import CapabilityConfig, create_bootstrap_plugin

                config = CapabilityConfig(
                    disable_basic=disable_basic,
                    enable_extended=enable_extended,
                    skip_character_provider=skip_character_provider,
                    enable_autonomy=enable_autonomy,
                )
                plugin_to_register = create_bootstrap_plugin(config)

        await register_plugin(self, plugin_to_register)
        self._plugins.append(plugin_to_register)

    def get_service(self, service: str) -> Service | None:
        services = self._services.get(service)
        return services[0] if services else None

    def get_services_by_type(self, service: str) -> list[Service]:
        return self._services.get(service, [])

    def get_all_services(self) -> dict[str, list[Service]]:
        return self._services

    async def register_service(self, service_class: type[Service]) -> None:
        service_type = service_class.service_type
        service = await service_class.start(self)

        if service_type not in self._services:
            self._services[service_type] = []
        self._services[service_type].append(service)

        self.logger.debug(f"Service registered: {service_type}")

    async def get_service_load_promise(self, service_type: str) -> Service:
        if not self._init_complete:
            await self._init_event.wait()

        service = self.get_service(service_type)
        if not service:
            raise RuntimeError(f"Service not found: {service_type}")
        return service

    def get_registered_service_types(self) -> list[str]:
        return list(self._services.keys())

    def has_service(self, service_type: str) -> bool:
        return service_type in self._services and len(self._services[service_type]) > 0

    def set_setting(self, key: str, value: object | None, secret: bool = False) -> None:
        if value is None:
            return

        if secret:
            if self._character.secrets is None:
                self._character.secrets = {}
            self._character.secrets[key] = value  # type: ignore[assignment]
            return

        if self._character.settings is None:
            self._character.settings = {}
        self._character.settings[key] = value  # type: ignore[assignment]

    def get_setting(self, key: str) -> object | None:
        settings = self._character.settings
        secrets = self._character.secrets

        nested_secrets: dict[str, object] | None = None
        if isinstance(settings, dict):
            nested = settings.get("secrets")
            if isinstance(nested, dict):
                nested_secrets = nested

        value: object | None
        if isinstance(secrets, dict) and key in secrets:
            value = secrets.get(key)
        elif isinstance(settings, dict) and key in settings:
            value = settings.get(key)
        elif isinstance(nested_secrets, dict) and key in nested_secrets:
            value = nested_secrets.get(key)
        else:
            value = self._settings.get(key)

        if value is None:
            return None

        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value
        if isinstance(value, str):
            decrypted = decrypt_secret(value, get_salt())
            if decrypted == "true":
                return True
            if decrypted == "false":
                return False
            # Cast to str since decrypt_secret returns object for type flexibility
            return str(decrypted) if decrypted is not None else None

        # Allow non-primitive runtime settings (e.g. objects used by providers/actions).
        return value

    def get_all_settings(self) -> dict[str, object | None]:
        keys: set[str] = set(self._settings.keys())
        if isinstance(self._character.settings, dict):
            keys.update(self._character.settings.keys())
            nested = self._character.settings.get("secrets")
            if isinstance(nested, dict):
                keys.update(nested.keys())
        if isinstance(self._character.secrets, dict):
            keys.update(self._character.secrets.keys())

        return {k: self.get_setting(k) for k in keys}

    def compose_prompt(self, *, state: State, template: TemplateType) -> str:
        return _compose_prompt_from_state(state=state, template=template)

    def compose_prompt_from_state(self, *, state: State, template: TemplateType) -> str:
        return _compose_prompt_from_state(state=state, template=template)

    def get_current_time_ms(self) -> int:
        return _get_current_time_ms()

    def get_conversation_length(self) -> int:
        return self._conversation_length

    def is_action_planning_enabled(self) -> bool:
        if self._action_planning_option is not None:
            return self._action_planning_option

        setting = self.get_setting("ACTION_PLANNING")
        if setting is not None:
            if isinstance(setting, bool):
                return setting
            if isinstance(setting, str):
                return setting.lower() == "true"

        return True

    def get_llm_mode(self) -> LLMMode:
        if self._llm_mode_option is not None:
            return self._llm_mode_option

        setting = self.get_setting("LLM_MODE")
        if setting is not None and isinstance(setting, str):
            upper = setting.upper()
            if upper == "SMALL":
                return LLMMode.SMALL
            elif upper == "LARGE":
                return LLMMode.LARGE
            elif upper == "DEFAULT":
                return LLMMode.DEFAULT

        # Default to DEFAULT (no override)
        return LLMMode.DEFAULT

    def is_check_should_respond_enabled(self) -> bool:
        """
        Check if the shouldRespond evaluation is enabled.

        When enabled (default: True), the agent evaluates whether to respond to each message.
        When disabled, the agent always responds (ChatGPT mode) - useful for direct chat interfaces.

        Priority: constructor option > character setting CHECK_SHOULD_RESPOND > default (True)
        """
        # Constructor option takes precedence
        if self._check_should_respond_option is not None:
            return self._check_should_respond_option

        setting = self.get_setting("CHECK_SHOULD_RESPOND")
        if setting is not None:
            if isinstance(setting, bool):
                return setting
            if isinstance(setting, str):
                return setting.lower() != "false"

        # Default to True (check should respond is enabled)
        return True

    # Component registration
    def register_provider(self, provider: Provider) -> None:
        self._providers.append(provider)

    def register_action(self, action: Action) -> None:
        self._actions.append(with_canonical_action_docs(action))

    def register_evaluator(self, evaluator: Evaluator) -> None:
        self._evaluators.append(with_canonical_evaluator_docs(evaluator))

    @staticmethod
    def _parse_param_value(value: str) -> str | int | float | bool | None:
        raw = value.strip()
        if raw == "":
            return None
        lower = raw.lower()
        if lower == "true":
            return True
        if lower == "false":
            return False
        if lower == "null":
            return None
        # Try int first, then float
        try:
            if re.fullmatch(r"-?\d+", raw):
                return int(raw)
            if re.fullmatch(r"-?\d+\.\d+", raw):
                return float(raw)
        except Exception:
            return raw
        return raw

    def _parse_action_params(self, params_raw: object | None) -> dict[str, list[dict[str, object]]]:
        """
        Parse action parameters from either:
        - Nested dict structure (e.g. {"MOVE": {"direction": "north"}})
        - XML string (inner content of <params> or full <params>...</params>)
        """
        if params_raw is None:
            return {}

        if isinstance(params_raw, str):
            xml_text = params_raw if "<params" in params_raw else f"<params>{params_raw}</params>"
            try:
                root = ET.fromstring(xml_text)
            except ET.ParseError:
                return {}

            if root.tag.lower() != "params":
                return {}

            result: dict[str, list[dict[str, object]]] = {}
            for action_elem in list(root):
                action_name = action_elem.tag.upper()
                action_params: dict[str, object] = {}
                for param_elem in list(action_elem):
                    action_params[param_elem.tag] = self._parse_param_value(param_elem.text or "")
                if action_params:
                    result.setdefault(action_name, []).append(action_params)
            return result

        if isinstance(params_raw, dict):
            result_dict: dict[str, list[dict[str, object]]] = {}
            for action_name, params_value in params_raw.items():
                action_key = str(action_name).upper()

                entries: list[dict[str, object]] = []
                if isinstance(params_value, list):
                    for item in params_value:
                        if not isinstance(item, dict):
                            continue
                        inner_action_params: dict[str, object] = {}
                        for param_name, raw_value in item.items():
                            key = str(param_name)
                            if isinstance(raw_value, str):
                                inner_action_params[key] = self._parse_param_value(raw_value)
                            else:
                                inner_action_params[key] = raw_value
                        if inner_action_params:
                            entries.append(inner_action_params)
                elif isinstance(params_value, dict):
                    inner_action_params = {}
                    for param_name, raw_value in params_value.items():
                        key = str(param_name)
                        if isinstance(raw_value, str):
                            inner_action_params[key] = self._parse_param_value(raw_value)
                        else:
                            inner_action_params[key] = raw_value
                    if inner_action_params:
                        entries.append(inner_action_params)
                else:
                    continue

                if entries:
                    result_dict[action_key] = entries
            return result_dict

        return {}

    def _validate_action_params(
        self, action: Action, extracted: dict[str, object] | None
    ) -> tuple[bool, dict[str, object] | None, list[str]]:
        errors: list[str] = []
        validated: dict[str, object] = {}

        if not action.parameters:
            return True, None, []

        for param_def in action.parameters:
            extracted_value = extracted.get(param_def.name) if extracted else None
            if extracted_value is None and extracted:
                # Be tolerant to parameter name casing produced by models (e.g. "Expression" vs "expression")
                for k, v in extracted.items():
                    if isinstance(k, str) and k.lower() == param_def.name.lower():
                        extracted_value = v
                        break

            # Treat explicit None as missing
            if extracted_value is None:
                if param_def.required:
                    errors.append(
                        f"Required parameter '{param_def.name}' was not provided for action {action.name}"
                    )
                elif param_def.schema_def.default is not None:
                    validated[param_def.name] = param_def.schema_def.default
                continue

            schema_type = param_def.schema_def.type

            if schema_type == "string":
                # Parameters often come from XML and may be parsed into scalars
                # (e.g., "200" -> int 200). For string-typed params, coerce
                # scalars back to strings rather than failing validation.
                if isinstance(extracted_value, bool):
                    extracted_value = "true" if extracted_value else "false"
                elif isinstance(extracted_value, (int, float)):
                    extracted_value = str(extracted_value)
                if not isinstance(extracted_value, str):
                    errors.append(
                        f"Parameter '{param_def.name}' expected string, got {type(extracted_value).__name__}"
                    )
                    continue
                if param_def.schema_def.enum and extracted_value not in param_def.schema_def.enum:
                    errors.append(
                        f"Parameter '{param_def.name}' value '{extracted_value}' not in allowed values: {', '.join(param_def.schema_def.enum)}"
                    )
                    continue
                if param_def.schema_def.pattern and not re.fullmatch(
                    param_def.schema_def.pattern, extracted_value
                ):
                    errors.append(
                        f"Parameter '{param_def.name}' value '{extracted_value}' does not match pattern: {param_def.schema_def.pattern}"
                    )
                    continue
                validated[param_def.name] = extracted_value
                continue

            if schema_type == "number":
                if isinstance(extracted_value, bool) or not isinstance(
                    extracted_value, (int, float)
                ):
                    errors.append(
                        f"Parameter '{param_def.name}' expected number, got {type(extracted_value).__name__}"
                    )
                    continue
                if param_def.schema_def.minimum is not None and float(extracted_value) < float(
                    param_def.schema_def.minimum
                ):
                    errors.append(
                        f"Parameter '{param_def.name}' value {extracted_value} is below minimum {param_def.schema_def.minimum}"
                    )
                    continue
                if param_def.schema_def.maximum is not None and float(extracted_value) > float(
                    param_def.schema_def.maximum
                ):
                    errors.append(
                        f"Parameter '{param_def.name}' value {extracted_value} is above maximum {param_def.schema_def.maximum}"
                    )
                    continue
                validated[param_def.name] = extracted_value
                continue

            if schema_type == "boolean":
                if not isinstance(extracted_value, bool):
                    errors.append(
                        f"Parameter '{param_def.name}' expected boolean, got {type(extracted_value).__name__}"
                    )
                    continue
                validated[param_def.name] = extracted_value
                continue

            if schema_type == "array":
                if not isinstance(extracted_value, list):
                    errors.append(
                        f"Parameter '{param_def.name}' expected array, got {type(extracted_value).__name__}"
                    )
                    continue
                validated[param_def.name] = extracted_value
                continue

            if schema_type == "object":
                if not isinstance(extracted_value, dict):
                    errors.append(
                        f"Parameter '{param_def.name}' expected object, got {type(extracted_value).__name__}"
                    )
                    continue
                validated[param_def.name] = extracted_value
                continue

            validated[param_def.name] = extracted_value

        return (len(errors) == 0, validated if validated else None, errors)

    async def process_actions(
        self,
        message: Memory,
        responses: list[Memory],
        state: State | None = None,
        callback: HandlerCallback | None = None,
        _options: dict[str, Any] | None = None,
    ) -> None:
        """Process actions selected by the model response (supports optional <params>)."""
        if not responses:
            return

        actions_to_process: list[str] = []
        if self.is_action_planning_enabled():
            for response in responses:
                if response.content.actions:
                    actions_to_process.extend(
                        [a for a in response.content.actions if isinstance(a, str)]
                    )
        else:
            for response in responses:
                if response.content.actions:
                    first = response.content.actions[0]
                    if isinstance(first, str):
                        actions_to_process = [first]
                    break

        if not actions_to_process:
            return

        for response in responses:
            if not response.content.actions:
                continue

            # Track Nth occurrence of each action within this response so repeated actions
            # (e.g., multiple WRITE_FILE actions) consume the corresponding Nth params entry.
            param_index: dict[str, int] = {}

            for response_action in response.content.actions:
                if not isinstance(response_action, str):
                    continue

                # Respect single-action mode: only execute the first collected action
                if not self.is_action_planning_enabled() and actions_to_process:
                    if response_action != actions_to_process[0]:
                        continue

                action = self._get_action_by_name(response_action)
                if not action:
                    self.logger.error(f"Action not found: {response_action}")
                    continue

                options_obj = HandlerOptions()

                if action.parameters:
                    params_raw = getattr(response.content, "params", None)
                    params_by_action = self._parse_action_params(params_raw)
                    action_key = response_action.upper()
                    extracted_list = params_by_action.get(action_key) or params_by_action.get(
                        action.name.upper()
                    )

                    idx = param_index.get(action_key, 0)
                    extracted: dict[str, object] | None = None
                    if isinstance(extracted_list, list):
                        if idx < len(extracted_list):
                            entry = extracted_list[idx]
                            if isinstance(entry, dict):
                                extracted = entry
                        param_index[action_key] = idx + 1
                    elif isinstance(extracted_list, dict):
                        extracted = extracted_list
                    valid, validated_params, errors = self._validate_action_params(
                        action, extracted
                    )
                if not valid:
                    self.logger.warning(
                        "Action parameter validation incomplete",
                        src="runtime:actions",
                        actionName=action.name,
                        errors=errors,
                    )
                    options_obj.parameter_errors = errors

                if validated_params:
                    from google.protobuf import struct_pb2

                    from elizaos.types.components import ActionParameters

                    struct_values = struct_pb2.Struct()
                    for k, v in validated_params.items():
                        if v is None:
                            struct_values.fields[k].null_value = 0
                        elif isinstance(v, bool):
                            struct_values.fields[k].bool_value = v
                        elif isinstance(v, (int, float)):
                            struct_values.fields[k].number_value = float(v)
                        elif isinstance(v, str):
                            struct_values.fields[k].string_value = v
                        else:
                            struct_values.fields[k].string_value = str(v)
                    options_obj.parameters.CopyFrom(ActionParameters(values=struct_values))

                result = await action.handler(
                    self,
                    message,
                    state,
                    options_obj,
                    callback,
                    responses,
                )

                # Store result
                if message.id:
                    message_id = str(message.id)
                    if message_id not in self._action_results:
                        self._action_results[message_id] = []
                    if result:
                        self._action_results[message_id].append(result)

    def _get_action_by_name(self, name: str) -> Action | None:
        for action in self._actions:
            if action.name == name:
                return action
        return None

    def get_action_results(self, message_id: UUID) -> list[ActionResult]:
        return self._action_results.get(str(message_id), [])

    def get_available_actions(self) -> list[Action]:
        """Get all registered actions."""
        return self._actions

    async def evaluate(
        self,
        message: Memory,
        state: State | None = None,
        did_respond: bool = False,
        callback: HandlerCallback | None = None,
        responses: list[Memory] | None = None,
    ) -> list[Evaluator] | None:
        """Run evaluators on a message."""
        ran_evaluators: list[Evaluator] = []

        for evaluator in self._evaluators:
            should_run = evaluator.always_run or did_respond

            if should_run:
                try:
                    is_valid = await evaluator.validate(self, message, state)
                    if is_valid:
                        await evaluator.handler(
                            self,
                            message,
                            state,
                            HandlerOptions(),
                            callback,
                            responses,
                        )
                        ran_evaluators.append(evaluator)
                except Exception as e:
                    self.logger.error(f"Evaluator {evaluator.name} failed: {e}")

        return ran_evaluators if ran_evaluators else None

    async def ensure_connections(
        self,
        entities: list[Entity],
        rooms: list[Room],
        _source: str,
        world: World,
    ) -> None:
        """Ensure connections are set up."""
        # Ensure world exists
        await self.ensure_world_exists(world)

        # Ensure rooms exist
        for room in rooms:
            await self.ensure_room_exists(room)

        for entity in entities:
            if entity.id:
                await self.create_entities([entity])
                for room in rooms:
                    await self.ensure_participant_in_room(entity.id, room.id)

    async def ensure_connection(
        self,
        entity_id: UUID,
        room_id: UUID,
        world_id: UUID,
        user_name: str | None = None,
        name: str | None = None,
        world_name: str | None = None,
        source: str | None = None,
        channel_id: str | None = None,
        message_server_id: UUID | None = None,
        channel_type: str | None = None,
        user_id: UUID | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """Ensure a connection is set up."""
        # Implementation depends on database adapter
        pass

    async def ensure_participant_in_room(self, entity_id: UUID, room_id: UUID) -> None:
        """Ensure an entity is a participant in a room."""
        if self._adapter:
            is_participant = await self._adapter.is_room_participant(room_id, entity_id)
            if not is_participant:
                await self._adapter.add_participants_room([entity_id], room_id)

    async def ensure_world_exists(self, world: World) -> None:
        if self._adapter:
            existing = await self._adapter.get_world(world.id)
            if not existing:
                await self._adapter.create_world(world)

    async def ensure_room_exists(self, room: Room) -> None:
        """Ensure a room exists."""
        if self._adapter:
            rooms = await self._adapter.get_rooms_by_ids([room.id])
            if not rooms or len(rooms) == 0:
                await self._adapter.create_rooms([room])

    async def compose_state(
        self,
        message: Memory,
        include_list: list[str] | None = None,
        only_include: bool = False,
        skip_cache: bool = False,
    ) -> State:
        # If we're running inside a trajectory step, always bypass the state cache
        # so providers are executed and logged for training/benchmark traces.
        traj_step_id: str | None = None
        if message.metadata is not None:
            maybe_step = getattr(message.metadata, "trajectoryStepId", None)
            if isinstance(maybe_step, str) and maybe_step:
                traj_step_id = maybe_step
                skip_cache = True

        cache_key = str(message.room_id)

        if not skip_cache and cache_key in self._state_cache:
            return self._state_cache[cache_key]

        # Create new state
        state = State(
            values={},
            data=StateData(),
            text="",
        )

        providers_to_run = self._providers
        if include_list and only_include:
            providers_to_run = [p for p in self._providers if p.name in include_list]
        elif include_list:
            providers_to_run = [
                p for p in self._providers if p.name not in include_list or p.name in include_list
            ]

        # Sort by position
        providers_to_run.sort(key=lambda p: p.position or 0)

        # Optional trajectory logging (end-to-end capture)

        from typing import Protocol, runtime_checkable

        @runtime_checkable
        class _TrajectoryLogger(Protocol):
            def log_provider_access(
                self,
                *,
                step_id: str,
                provider_name: str,
                data: dict[str, str | int | float | bool | None],
                purpose: str,
                query: dict[str, str | int | float | bool | None] | None = None,
            ) -> None: ...

        traj_svc = self.get_service("trajectory_logger")
        traj_logger = traj_svc if isinstance(traj_svc, _TrajectoryLogger) else None

        def _as_json_scalar(value: object) -> str | int | float | bool | None:
            if value is None:
                return None
            if isinstance(value, (str, int, float, bool)):
                if isinstance(value, str):
                    return value[:2000]
                return value
            return str(value)[:2000]

        def _as_json_dict(data: object) -> dict[str, str | int | float | bool | None]:
            if not isinstance(data, dict):
                return {"value": _as_json_scalar(data)}
            out: dict[str, str | int | float | bool | None] = {}
            for k, v in data.items():
                if isinstance(k, str):
                    out[k] = _as_json_scalar(v)
            return out

        text_parts: list[str] = []
        for provider in providers_to_run:
            if provider.private:
                continue

            result = await provider.get(self, message, state)
            if result.text:
                text_parts.append(result.text)
            if result.values:
                state.values.update(result.values)
            if result.data:
                if not state.data.providers:
                    state.data.providers = {}
                state.data.providers[provider.name] = result.data

            # Log provider access to trajectory service (if available)
            if traj_step_id and traj_logger is not None:
                try:
                    user_text = message.content.text or ""
                    traj_logger.log_provider_access(
                        step_id=traj_step_id,
                        provider_name=provider.name,
                        data=_as_json_dict(result.data or {}),
                        purpose="compose_state",
                        query={"message": _as_json_scalar(user_text)},
                    )
                except Exception:
                    # Trajectory logging must never break core message flow.
                    pass

        state.text = "\n".join(text_parts)
        # Match TypeScript behavior: expose providers text under {{providers}}.
        state.values["providers"] = state.text

        if not skip_cache:
            self._state_cache[cache_key] = state

        return state

    # Model usage
    def has_model(self, model_type: str | ModelType) -> bool:
        """Check if a model handler is registered for the given model type."""

        key = model_type.value if isinstance(model_type, ModelType) else model_type
        handlers = self._models.get(key, [])
        return len(handlers) > 0

    async def use_model(
        self,
        model_type: str | ModelType,
        params: dict[str, Any] | None = None,
        provider: str | None = None,
        **kwargs: Any,
    ) -> Any:
        effective_model_type = model_type.value if isinstance(model_type, ModelType) else model_type
        if params is None:
            params = dict(kwargs)
        elif kwargs:
            params = {**params, **kwargs}

        # Apply LLM mode override for text generation models
        llm_mode = self.get_llm_mode()
        if llm_mode != LLMMode.DEFAULT:
            # List of text generation model types that can be overridden
            text_generation_models = [
                ModelType.TEXT_SMALL.value,
                ModelType.TEXT_LARGE.value,
                ModelType.TEXT_REASONING_SMALL.value,
                ModelType.TEXT_REASONING_LARGE.value,
                ModelType.TEXT_COMPLETION.value,
            ]
            if effective_model_type in text_generation_models:
                override_model_type = (
                    ModelType.TEXT_SMALL.value
                    if llm_mode == LLMMode.SMALL
                    else ModelType.TEXT_LARGE.value
                )
                if effective_model_type != override_model_type:
                    self.logger.debug(
                        f"LLM mode override applied: {effective_model_type} -> {override_model_type} (mode: {llm_mode})"
                    )
                    effective_model_type = override_model_type

        handlers = self._models.get(effective_model_type, [])

        if not handlers:
            raise RuntimeError(f"No model handler registered for: {effective_model_type}")

        handlers.sort(key=lambda h: h.priority, reverse=True)

        if provider:
            handlers = [h for h in handlers if h.provider == provider]
            if not handlers:
                raise RuntimeError(f"No model handler for provider: {provider}")

        handler = handlers[0]
        start_ms = self.get_current_time_ms()
        result = await handler.handler(self, params)
        end_ms = self.get_current_time_ms()

        # Optional trajectory logging: associate model calls with the current trajectory step
        try:
            from elizaos.trajectory_context import CURRENT_TRAJECTORY_STEP_ID

            step_id = CURRENT_TRAJECTORY_STEP_ID.get()
            traj_svc = self.get_service("trajectory_logger")
            if step_id and traj_svc is not None and hasattr(traj_svc, "log_llm_call"):
                prompt = str(params.get("prompt", "")) if isinstance(params, dict) else ""
                system_prompt = str(params.get("system", "")) if isinstance(params, dict) else ""
                temperature_raw = params.get("temperature") if isinstance(params, dict) else None
                temperature = (
                    float(temperature_raw) if isinstance(temperature_raw, (int, float)) else 0.0
                )
                max_tokens_raw = params.get("maxTokens") if isinstance(params, dict) else None
                max_tokens = int(max_tokens_raw) if isinstance(max_tokens_raw, int) else 0

                traj_svc.log_llm_call(  # type: ignore[call-arg]
                    step_id=step_id,
                    model=str(effective_model_type),
                    system_prompt=system_prompt,
                    user_prompt=prompt,
                    response=str(result),
                    temperature=temperature,
                    max_tokens=max_tokens,
                    purpose="action",
                    action_type="runtime.use_model",
                    latency_ms=max(0, end_ms - start_ms),
                )
        except Exception:
            pass

        return result

    async def generate_text(
        self,
        input_text: str,
        options: GenerateTextOptions | None = None,
    ) -> GenerateTextResult:
        model_type: str | ModelType = ModelType.TEXT_LARGE
        if options and options.model_type:
            model_type = options.model_type

        params: dict[str, str | int | float] = {
            "prompt": input_text,
        }
        if options:
            if options.temperature is not None:
                params["temperature"] = options.temperature
            if options.max_tokens is not None:
                params["maxTokens"] = options.max_tokens

        result = await self.use_model(model_type, params)
        return GenerateTextResult(text=str(result))

    def register_model(
        self,
        model_type: str | ModelType,
        handler: Callable[[IAgentRuntime, dict[str, Any]], Awaitable[Any]],
        provider: str,
        priority: int = 0,
    ) -> None:
        key = model_type.value if isinstance(model_type, ModelType) else model_type
        if key not in self._models:
            self._models[key] = []

        self._models[key].append(
            ModelHandler(handler=handler, provider=provider, priority=priority)
        )

    def get_model(
        self, model_type: str
    ) -> Callable[[IAgentRuntime, dict[str, Any]], Awaitable[Any]] | None:
        handlers = self._models.get(model_type, [])
        if handlers:
            handlers.sort(key=lambda h: h.priority, reverse=True)
            return handlers[0].handler
        return None

    def register_streaming_model(
        self,
        model_type: str | ModelType,
        handler: StreamingModelHandler,
        provider: str,
        priority: int = 0,
    ) -> None:
        """Register a streaming model handler."""
        key = model_type.value if isinstance(model_type, ModelType) else model_type
        if key not in self._streaming_models:
            self._streaming_models[key] = []

        self._streaming_models[key].append(
            StreamingModelHandlerWrapper(handler=handler, provider=provider, priority=priority)
        )

    async def _use_model_stream_impl(
        self,
        model_type: str | ModelType,
        params: dict[str, Any] | None = None,
        provider: str | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[str]:
        """Internal implementation for streaming model calls."""
        effective_model_type = model_type.value if isinstance(model_type, ModelType) else model_type
        if params is None:
            params = dict(kwargs)
        elif kwargs:
            params = {**params, **kwargs}

        # Apply LLM mode override for streaming text generation models
        llm_mode = self.get_llm_mode()
        if llm_mode != LLMMode.DEFAULT:
            streaming_text_models = [
                ModelType.TEXT_SMALL_STREAM.value,
                ModelType.TEXT_LARGE_STREAM.value,
            ]
            if effective_model_type in streaming_text_models:
                override_model_type = (
                    ModelType.TEXT_SMALL_STREAM.value
                    if llm_mode == LLMMode.SMALL
                    else ModelType.TEXT_LARGE_STREAM.value
                )
                if effective_model_type != override_model_type:
                    self.logger.debug(
                        f"LLM mode override applied: {effective_model_type} -> {override_model_type} (mode: {llm_mode})"
                    )
                    effective_model_type = override_model_type

        handlers = self._streaming_models.get(effective_model_type, [])

        if not handlers:
            raise RuntimeError(f"No streaming model handler registered for: {effective_model_type}")

        handlers.sort(key=lambda h: h.priority, reverse=True)

        if provider:
            handlers = [h for h in handlers if h.provider == provider]
            if not handlers:
                raise RuntimeError(f"No streaming model handler for provider: {provider}")

        handler = handlers[0]
        async for chunk in handler.handler(self, params):
            yield chunk

    def use_model_stream(
        self,
        model_type: str | ModelType,
        params: dict[str, Any] | None = None,
        provider: str | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[str]:
        """
        Use a streaming model handler to generate text token by token.

        Args:
            model_type: The model type (e.g., ModelType.TEXT_LARGE_STREAM)
            params: Parameters for the model (prompt, system, temperature, etc.)
            provider: Optional specific provider to use
            **kwargs: Additional parameters merged into params

        Returns:
            An async iterator yielding text chunks as they are generated.
        """
        return self._use_model_stream_impl(model_type, params, provider, **kwargs)

    # Event handling
    def register_event(
        self,
        event: str,
        handler: Callable[[Any], Awaitable[None]],
    ) -> None:
        if event not in self._events:
            self._events[event] = []
        self._events[event].append(handler)

    def get_event(self, event: str) -> list[Callable[[Any], Awaitable[None]]] | None:
        """Get event handlers for an event type."""
        return self._events.get(event)

    async def emit_event(
        self,
        event: str | list[str],
        params: Any,
    ) -> None:
        events = [event] if isinstance(event, str) else event

        for evt in events:
            handlers = self._events.get(evt, [])
            for handler in handlers:
                await handler(params)

    # Task management
    def register_task_worker(self, task_handler: TaskWorker) -> None:
        """Register a task worker."""
        self._task_workers[task_handler.name] = task_handler

    def get_task_worker(self, name: str) -> TaskWorker | None:
        """Get a task worker by name."""
        return self._task_workers.get(name)

    # Lifecycle
    async def stop(self) -> None:
        """Stop the runtime."""
        self.logger.info("Stopping AgentRuntime...")

        # Stop all services
        for service_type, services in self._services.items():
            for service in services:
                try:
                    await service.stop()
                except Exception as e:
                    self.logger.error(f"Failed to stop service {service_type}: {e}")

        if self._adapter:
            await self._adapter.close()

        self.logger.info("AgentRuntime stopped")

    async def add_embedding_to_memory(self, memory: Memory) -> Memory:
        return memory

    async def queue_embedding_generation(self, memory: Memory, priority: str = "normal") -> None:
        await self.emit_event(
            EventType.EMBEDDING_GENERATION_REQUESTED.value,
            {"runtime": self, "memory": memory, "priority": priority, "source": "runtime"},
        )

    async def get_all_memories(self) -> list[Memory]:
        if not self._adapter:
            return []
        return await self._adapter.get_memories(
            {"agentId": str(self._agent_id), "tableName": "memories"}
        )

    async def clear_all_agent_memories(self) -> None:
        pass

    def create_run_id(self) -> UUID:
        return as_uuid(str(uuid.uuid4()))

    def start_run(self, room_id: UUID | None = None) -> UUID:
        self._current_run_id = self.create_run_id()
        self._current_room_id = room_id
        return self._current_run_id

    def end_run(self) -> None:
        self._current_run_id = None
        self._current_room_id = None

    def get_current_run_id(self) -> UUID:
        if not self._current_run_id:
            return self.start_run()
        return self._current_run_id

    async def get_entity_by_id(self, entity_id: UUID) -> Entity | None:
        if not self._adapter:
            return None
        entities = await self._adapter.get_entities_by_ids([entity_id])
        return entities[0] if entities else None

    async def get_room(self, room_id: UUID) -> Room | None:
        if not self._adapter:
            return None
        rooms = await self._adapter.get_rooms_by_ids([room_id])
        return rooms[0] if rooms else None

    async def create_entity(self, entity: Entity) -> bool:
        if not self._adapter:
            return False
        return await self._adapter.create_entities([entity])

    async def create_room(self, room: Room) -> UUID:
        if not self._adapter:
            raise RuntimeError("Database adapter not set")
        ids = await self._adapter.create_rooms([room])
        return ids[0]

    async def add_participant(self, entity_id: UUID, room_id: UUID) -> bool:
        if not self._adapter:
            return False
        return await self._adapter.add_participants_room([entity_id], room_id)

    async def get_rooms(self, world_id: UUID) -> list[Room]:
        if not self._adapter:
            return []
        return await self._adapter.get_rooms_by_world(world_id)

    def register_send_handler(self, source: str, handler: SendHandlerFunction) -> None:
        self._send_handlers[source] = handler

    async def send_message_to_target(self, target: TargetInfo, content: Content) -> None:
        if target.source and target.source in self._send_handlers:
            await self._send_handlers[target.source](target, content)

    async def init(self) -> None:
        if self._adapter:
            await self._adapter.init()

    async def is_ready(self) -> bool:
        if not self._adapter:
            return False
        return await self._adapter.is_ready()

    async def close(self) -> None:
        if self._adapter:
            await self._adapter.close()

    async def get_connection(self) -> Any:
        if not self._adapter:
            raise RuntimeError("Database adapter not set")
        return await self._adapter.get_connection()

    async def get_agent(self, agent_id: UUID) -> Any | None:
        if not self._adapter:
            return None
        return await self._adapter.get_agent(agent_id)

    async def get_agents(self) -> list[Any]:
        if not self._adapter:
            return []
        return await self._adapter.get_agents()

    async def create_agent(self, agent: Any) -> bool:
        if not self._adapter:
            return False
        return await self._adapter.create_agent(agent)

    async def update_agent(self, agent_id: UUID, agent: Any) -> bool:
        if not self._adapter:
            return False
        return await self._adapter.update_agent(agent_id, agent)

    async def delete_agent(self, agent_id: UUID) -> bool:
        if not self._adapter:
            return False
        return await self._adapter.delete_agent(agent_id)

    async def ensure_embedding_dimension(self, dimension: int) -> None:
        if self._adapter:
            await self._adapter.ensure_embedding_dimension(dimension)

    async def get_entity(self, entity_id: UUID) -> Any | None:
        """Get a single entity by ID."""
        if not self._adapter:
            return None
        entities = await self._adapter.get_entities_by_ids([entity_id])
        return entities[0] if entities else None

    async def get_entities_by_ids(self, entity_ids: list[UUID]) -> list[Any] | None:
        if not self._adapter:
            return None
        return await self._adapter.get_entities_by_ids(entity_ids)

    async def get_entities_for_room(
        self, room_id: UUID, include_components: bool = False
    ) -> list[Any]:
        if not self._adapter:
            return []
        return await self._adapter.get_entities_for_room(room_id, include_components)

    async def create_entities(self, entities: list[Any]) -> bool:
        if not self._adapter:
            return False
        return await self._adapter.create_entities(entities)

    async def update_entity(self, entity: Any) -> None:
        if self._adapter:
            await self._adapter.update_entity(entity)

    async def get_component(
        self,
        entity_id: UUID,
        component_type: str,
        world_id: UUID | None = None,
        source_entity_id: UUID | None = None,
    ) -> Any | None:
        if not self._adapter:
            return None
        return await self._adapter.get_component(
            entity_id, component_type, world_id, source_entity_id
        )

    async def get_components(
        self,
        entity_id: UUID,
        world_id: UUID | None = None,
        source_entity_id: UUID | None = None,
    ) -> list[Any]:
        if not self._adapter:
            return []
        return await self._adapter.get_components(entity_id, world_id, source_entity_id)

    async def create_component(self, component: Any) -> bool:
        if not self._adapter:
            return False
        return await self._adapter.create_component(component)

    async def update_component(self, component: Any) -> None:
        if self._adapter:
            await self._adapter.update_component(component)

    async def delete_component(self, component_id: UUID) -> None:
        if self._adapter:
            await self._adapter.delete_component(component_id)

    async def get_memories(
        self,
        params: dict[str, Any] | None = None,
        *,
        room_id: UUID | None = None,
        limit: int | None = None,
        order_by: str | None = None,
        order_direction: str | None = None,
        table_name: str | None = None,
        **kwargs: Any,
    ) -> list[Any]:
        """
        Get memories, supporting both dict-style and kwargs-style calling.

        Can be called as:
            get_memories({"roomId": room_id, "limit": 10})
        or:
            get_memories(room_id=room_id, limit=10)
        """
        if not self._adapter:
            return []
        # Start with provided params or empty dict
        merged_params = dict(params) if params else {}
        # Explicit keyword arguments take precedence over params dict
        if room_id is not None:
            merged_params["roomId"] = str(room_id)
        if limit is not None:
            merged_params["limit"] = limit
        if order_by is not None:
            merged_params["orderBy"] = order_by
        if order_direction is not None:
            merged_params["orderDirection"] = order_direction
        if table_name is not None:
            merged_params["tableName"] = table_name
        # Additional kwargs also take precedence
        merged_params.update(kwargs)
        return await self._adapter.get_memories(merged_params)

    async def get_memory_by_id(self, id: UUID) -> Any | None:
        if not self._adapter:
            return None
        return await self._adapter.get_memory_by_id(id)

    async def get_memories_by_ids(
        self, ids: list[UUID], table_name: str | None = None
    ) -> list[Any]:
        if not self._adapter:
            return []
        return await self._adapter.get_memories_by_ids(ids, table_name)

    async def get_memories_by_room_ids(self, params: dict[str, Any]) -> list[Any]:
        if not self._adapter:
            return []
        return await self._adapter.get_memories_by_room_ids(params)

    async def get_cached_embeddings(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        if not self._adapter:
            return []
        return await self._adapter.get_cached_embeddings(params)

    async def log(self, params: dict[str, Any]) -> None:
        if self._adapter:
            await self._adapter.log(params)

    async def get_logs(self, params: dict[str, Any]) -> list[Log]:
        if not self._adapter:
            return []
        return await self._adapter.get_logs(params)

    async def delete_log(self, log_id: UUID) -> None:
        if self._adapter:
            await self._adapter.delete_log(log_id)

    async def get_agent_run_summaries(self, params: dict[str, Any]) -> AgentRunSummaryResult:
        if not self._adapter:
            return AgentRunSummaryResult(runs=[], total=0, has_more=False)
        return await self._adapter.get_agent_run_summaries(params)

    async def search_memories(self, params: dict[str, Any]) -> list[Any]:
        if not self._adapter:
            return []
        return await self._adapter.search_memories(params)

    async def create_memory(
        self,
        memory: dict[str, object] | None = None,
        table_name: str | None = None,
        unique: bool | None = None,
        **kwargs: object,
    ) -> UUID:
        if not self._adapter:
            raise RuntimeError("Database adapter not set")
        return await self._adapter.create_memory(memory, table_name, unique)

    async def update_memory(self, memory: Memory | dict[str, Any]) -> bool:
        if not self._adapter:
            return False
        return await self._adapter.update_memory(memory)

    async def delete_memory(self, memory_id: UUID) -> None:
        if self._adapter:
            await self._adapter.delete_memory(memory_id)

    async def delete_many_memories(self, memory_ids: list[UUID]) -> None:
        if self._adapter:
            await self._adapter.delete_many_memories(memory_ids)

    async def delete_all_memories(self, room_id: UUID, table_name: str) -> None:
        if self._adapter:
            await self._adapter.delete_all_memories(room_id, table_name)

    async def count_memories(
        self, room_id: UUID, unique: bool = False, table_name: str | None = None
    ) -> int:
        if not self._adapter:
            return 0
        return await self._adapter.count_memories(room_id, unique, table_name)

    async def create_world(self, world: Any) -> UUID:
        if not self._adapter:
            raise RuntimeError("Database adapter not set")
        return await self._adapter.create_world(world)

    async def get_world(self, id: UUID) -> Any | None:
        if not self._adapter:
            return None
        return await self._adapter.get_world(id)

    async def remove_world(self, id: UUID) -> None:
        if self._adapter:
            await self._adapter.remove_world(id)

    async def get_all_worlds(self) -> list[Any]:
        if not self._adapter:
            return []
        return await self._adapter.get_all_worlds()

    async def update_world(self, world: Any) -> None:
        if self._adapter:
            await self._adapter.update_world(world)

    async def get_rooms_by_ids(self, room_ids: list[UUID]) -> list[Any] | None:
        if not self._adapter:
            return None
        return await self._adapter.get_rooms_by_ids(room_ids)

    async def create_rooms(self, rooms: list[Any]) -> list[UUID]:
        if not self._adapter:
            raise RuntimeError("Database adapter not set")
        return await self._adapter.create_rooms(rooms)

    async def delete_room(self, room_id: UUID) -> None:
        if self._adapter:
            await self._adapter.delete_room(room_id)

    async def delete_rooms_by_world_id(self, world_id: UUID) -> None:
        if self._adapter:
            await self._adapter.delete_rooms_by_world_id(world_id)

    async def update_room(self, room: Any) -> None:
        if self._adapter:
            await self._adapter.update_room(room)

    async def get_rooms_for_participant(self, entity_id: UUID) -> list[UUID]:
        if not self._adapter:
            return []
        return await self._adapter.get_rooms_for_participant(entity_id)

    async def get_rooms_for_participants(self, user_ids: list[UUID]) -> list[UUID]:
        if not self._adapter:
            return []
        return await self._adapter.get_rooms_for_participants(user_ids)

    async def get_rooms_by_world(self, world_id: UUID) -> list[Any]:
        if not self._adapter:
            return []
        return await self._adapter.get_rooms_by_world(world_id)

    async def remove_participant(self, entity_id: UUID, room_id: UUID) -> bool:
        if not self._adapter:
            return False
        return await self._adapter.remove_participant(entity_id, room_id)

    async def get_participants_for_entity(self, entity_id: UUID) -> list[Any]:
        if not self._adapter:
            return []
        return await self._adapter.get_participants_for_entity(entity_id)

    async def get_participants_for_room(self, room_id: UUID) -> list[UUID]:
        if not self._adapter:
            return []
        return await self._adapter.get_participants_for_room(room_id)

    async def is_room_participant(self, room_id: UUID, entity_id: UUID) -> bool:
        if not self._adapter:
            return False
        return await self._adapter.is_room_participant(room_id, entity_id)

    async def add_participants_room(self, entity_ids: list[UUID], room_id: UUID) -> bool:
        if not self._adapter:
            return False
        return await self._adapter.add_participants_room(entity_ids, room_id)

    async def get_participant_user_state(self, room_id: UUID, entity_id: UUID) -> str | None:
        if not self._adapter:
            return None
        return await self._adapter.get_participant_user_state(room_id, entity_id)

    async def set_participant_user_state(
        self, room_id: UUID, entity_id: UUID, state: str | None
    ) -> None:
        if self._adapter:
            await self._adapter.set_participant_user_state(room_id, entity_id, state)

    async def create_relationship(self, params: dict[str, Any]) -> bool:
        if not self._adapter:
            return False
        return await self._adapter.create_relationship(params)

    async def update_relationship(self, relationship: Any) -> None:
        if self._adapter:
            await self._adapter.update_relationship(relationship)

    async def get_relationship(self, params: dict[str, Any]) -> Any | None:
        if not self._adapter:
            return None
        return await self._adapter.get_relationship(params)

    async def get_relationships(self, params: dict[str, Any]) -> list[Any]:
        if not self._adapter:
            return []
        return await self._adapter.get_relationships(params)

    async def get_cache(self, key: str) -> Any | None:
        if not self._adapter:
            return None
        return await self._adapter.get_cache(key)

    async def set_cache(self, key: str, value: Any) -> bool:
        if not self._adapter:
            return False
        return await self._adapter.set_cache(key, value)

    async def delete_cache(self, key: str) -> None:
        if not self._adapter:
            return
        await self._adapter.delete_cache(key)

    async def create_task(self, task: Any) -> UUID:
        if not self._adapter:
            raise RuntimeError("Database adapter not set")
        return await self._adapter.create_task(task)

    async def get_tasks(self, params: dict[str, Any]) -> list[Any]:
        if not self._adapter:
            return []
        return await self._adapter.get_tasks(params)

    async def get_task(self, id: UUID) -> Any | None:
        if not self._adapter:
            return None
        return await self._adapter.get_task(id)

    async def get_tasks_by_name(self, name: str) -> list[Any]:
        if not self._adapter:
            return []
        return await self._adapter.get_tasks_by_name(name)

    async def update_task(self, id: UUID, task: dict[str, Any]) -> None:
        if self._adapter:
            await self._adapter.update_task(id, task)

    async def delete_task(self, id: UUID) -> None:
        if self._adapter:
            await self._adapter.delete_task(id)

    async def get_memories_by_world_id(self, params: dict[str, Any]) -> list[Any]:
        if not self._adapter:
            return []
        return await self._adapter.get_memories_by_world_id(params)

    async def search_knowledge(self, query: str, limit: int = 5) -> list[object]:
        """Search for knowledge matching the given query."""
        if not self._adapter:
            return []
        return await self._adapter.search_memories({"query": query, "limit": limit})
