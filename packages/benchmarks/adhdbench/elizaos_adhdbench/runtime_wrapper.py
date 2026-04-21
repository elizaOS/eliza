"""Runtime wrapper with method instrumentation for benchmark data capture."""

from __future__ import annotations

import time
import types
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from elizaos.runtime import AgentRuntime
from elizaos.types.agent import Character
from elizaos.types.components import Action
from elizaos.types.memory import Memory
from elizaos.types.primitives import Content, as_uuid

from elizaos_adhdbench.config import ADHDBenchConfig

if TYPE_CHECKING:
    from elizaos.types.state import State


@dataclass
class TurnCapture:
    """Data captured from one handle_message call."""
    providers_run: list[str] = field(default_factory=list)
    compose_state_calls: int = 0


class InstrumentedCapture:
    """Captures provider execution data by wrapping compose_state.

    This replaces the trajectory logger approach because the Eliza runtime's
    trajectory_step_id path uses camelCase getattr on protobuf objects which
    always returns None (protobuf only exposes snake_case).  Method wrapping
    is reliable and doesn't depend on broken metadata plumbing.
    """

    def __init__(self) -> None:
        self._current: TurnCapture = TurnCapture()
        self._original_compose: object | None = None

    def reset(self) -> None:
        self._current = TurnCapture()

    @property
    def capture(self) -> TurnCapture:
        return self._current

    def install(self, runtime: AgentRuntime) -> None:
        """Wrap runtime.compose_state to capture provider data."""
        original = runtime.compose_state.__func__
        self._original_compose = original
        capture_ref = self

        async def instrumented_compose_state(
            self_rt: AgentRuntime,
            message: Memory,
            include_list: list[str] | None = None,
            only_include: bool = False,
            skip_cache: bool = False,
        ) -> State:
            # Always skip cache during benchmarking for consistent provider execution
            result = await original(self_rt, message, include_list, only_include, skip_cache=True)
            capture_ref._current.compose_state_calls += 1
            # Extract provider names from state.data.providers map
            if hasattr(result, "data") and hasattr(result.data, "providers"):
                providers_map = result.data.providers
                if hasattr(providers_map, "keys"):
                    for name in providers_map.keys():
                        if name not in capture_ref._current.providers_run:
                            capture_ref._current.providers_run.append(name)
            return result

        runtime.compose_state = types.MethodType(instrumented_compose_state, runtime)


def create_benchmark_runtime(
    config: ADHDBenchConfig,
    config_name: str,
) -> tuple[AgentRuntime, InstrumentedCapture]:
    """Create an AgentRuntime configured for benchmarking.

    Returns (runtime, capture).  Call install() after initialize().
    """
    is_full = config_name == "full"

    character = Character(
        name=config.character_name,
        bio=[config.character_bio],
        system=config.character_system,
        advanced_memory=is_full,
        advanced_planning=is_full,
    )

    runtime = AgentRuntime(
        character=character,
        log_level="WARNING",
    )

    return runtime, InstrumentedCapture()


class _DictLikeSettings:
    """Wraps protobuf CharacterSettings to support dict-style .get() access.

    The Eliza MemoryService/PlanningService call ``settings.get("KEY")`` but
    CharacterSettings is a protobuf message without .get().  This wrapper
    bridges the gap by delegating .get() to the protobuf extra Struct field
    and forwarding all other attribute access to the underlying proto.
    """

    def __init__(self, proto_settings: object) -> None:
        object.__setattr__(self, "_proto", proto_settings)

    def get(self, key: str, default: object = None) -> object:
        proto = object.__getattribute__(self, "_proto")
        if hasattr(proto, "extra") and hasattr(proto.extra, "fields"):
            fields = proto.extra.fields
            if key in fields:
                val = fields[key]
                if val.HasField("string_value"):
                    return val.string_value
                if val.HasField("number_value"):
                    return val.number_value
                if val.HasField("bool_value"):
                    return val.bool_value
        return default

    def __getattr__(self, name: str) -> object:
        return getattr(object.__getattribute__(self, "_proto"), name)

    def __bool__(self) -> bool:
        return True


async def initialize_benchmark_runtime(
    runtime: AgentRuntime,
    capture: InstrumentedCapture,
    extra_actions: list[Action] | None = None,
) -> None:
    """Initialize the runtime and install instrumentation."""
    # Patch character.settings to be dict-compatible before init.
    # The MemoryService calls settings.get() but protobuf CharacterSettings
    # doesn't have .get().  This wrapper fixes it.
    if runtime._character is not None and runtime._character.settings is not None:
        wrapped = _DictLikeSettings(runtime._character.settings)
        # Replace the settings reference on the character proto via ClearField + re-set
        # Actually, we can't mutate protobuf fields to non-proto values.
        # Instead, we monkey-patch the character object's __dict__ won't work either.
        # The real fix: store the wrapped settings and patch the property lookup.
        runtime._settings_wrapper = wrapped
        # Monkey-patch the character property to return settings with .get()
        original_character = runtime._character
        class _CharacterProxy:
            def __init__(self, inner, settings_wrapper):
                object.__setattr__(self, '_inner', inner)
                object.__setattr__(self, '_settings_wrapper', settings_wrapper)
            @property
            def settings(self):
                return object.__getattribute__(self, '_settings_wrapper')
            def __getattr__(self, name):
                return getattr(object.__getattribute__(self, '_inner'), name)
        runtime._character = _CharacterProxy(original_character, wrapped)

    await runtime.initialize()
    capture.install(runtime)

    if extra_actions:
        for action in extra_actions:
            runtime.register_action(action)


async def prefill_conversation(
    runtime: AgentRuntime,
    room_id: str,
    entity_id: str,
    messages: list[str],
) -> None:
    """Inject synthetic conversation history into the runtime's memory.

    If no database adapter is configured, this is a no-op.
    """
    if runtime._adapter is None:
        return

    for i, text in enumerate(messages):
        is_user = i % 2 == 0
        sender_id = entity_id if is_user else str(runtime.agent_id)

        memory = Memory(
            id=as_uuid(str(uuid.uuid4())),
            entity_id=as_uuid(sender_id),
            room_id=as_uuid(room_id),
            content=Content(text=text),
        )
        await runtime.create_memory(memory, "messages")
