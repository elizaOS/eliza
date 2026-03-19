"""
HookService - Unified Hook Management Service for Python

This service provides a centralized hook management system that integrates
with the Eliza event system. Hooks can be registered for specific event
types and will be triggered when those events are emitted.

Key Features:
- Register hooks for specific event types with priority ordering
- FIFO execution order by default, with priority override support
- Hook eligibility checks based on requirements (OS, binaries, env vars, config paths)
- Directory-based hook discovery from HOOK.md files
"""

from __future__ import annotations

import os
import platform
import shutil
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import TYPE_CHECKING, Any

from elizaos.types.service import Service, ServiceType

if TYPE_CHECKING:
    from elizaos.types.runtime import IAgentRuntime


class HookSource(str, Enum):
    """Source of a hook registration."""

    BUNDLED = "bundled"
    MANAGED = "managed"
    WORKSPACE = "workspace"
    PLUGIN = "plugin"
    RUNTIME = "runtime"


class HookEventType(str, Enum):
    """Hook-specific event types."""

    HOOK_COMMAND_NEW = "HOOK_COMMAND_NEW"
    HOOK_COMMAND_RESET = "HOOK_COMMAND_RESET"
    HOOK_COMMAND_STOP = "HOOK_COMMAND_STOP"
    HOOK_SESSION_START = "HOOK_SESSION_START"
    HOOK_SESSION_END = "HOOK_SESSION_END"
    HOOK_AGENT_BASIC_CAPABILITIES = "HOOK_AGENT_BASIC_CAPABILITIES"
    HOOK_AGENT_START = "HOOK_AGENT_START"
    HOOK_AGENT_END = "HOOK_AGENT_END"
    HOOK_GATEWAY_START = "HOOK_GATEWAY_START"
    HOOK_GATEWAY_STOP = "HOOK_GATEWAY_STOP"
    HOOK_COMPACTION_BEFORE = "HOOK_COMPACTION_BEFORE"
    HOOK_COMPACTION_AFTER = "HOOK_COMPACTION_AFTER"
    HOOK_TOOL_BEFORE = "HOOK_TOOL_BEFORE"
    HOOK_TOOL_AFTER = "HOOK_TOOL_AFTER"
    HOOK_TOOL_PERSIST = "HOOK_TOOL_PERSIST"
    HOOK_MESSAGE_SENDING = "HOOK_MESSAGE_SENDING"


DEFAULT_HOOK_PRIORITY: int = 0


@dataclass
class HookRequirements:
    """Requirements that must be met for a hook to be eligible."""

    os: list[str] | None = None
    bins: list[str] | None = None
    any_bins: list[str] | None = None
    env: list[str] | None = None
    config: list[str] | None = None


@dataclass
class HookEligibilityResult:
    """Result of checking hook eligibility."""

    eligible: bool
    reasons: list[str] = field(default_factory=list)


@dataclass
class HookMetadata:
    """Metadata describing a registered hook."""

    name: str
    source: HookSource
    events: list[str]
    priority: int = DEFAULT_HOOK_PRIORITY
    enabled: bool = True
    description: str = ""
    plugin_id: str | None = None
    always: bool = False
    requires: HookRequirements | None = None


HookHandler = Callable[[dict[str, Any]], None]


@dataclass
class HookRegistration:
    """A registered hook with its handler."""

    id: str
    metadata: HookMetadata
    handler: HookHandler
    registered_at: float


@dataclass
class HookSummary:
    """Summary information for a hook."""

    name: str
    events: list[str]
    source: HookSource
    enabled: bool
    priority: int
    plugin_id: str | None = None


@dataclass
class HookSnapshot:
    """Snapshot of all registered hooks."""

    hooks: list[HookSummary]
    version: int
    timestamp: float


@dataclass
class HookLoadResult:
    """Result of loading hooks from a directory."""

    loaded: list[str]
    skipped: list[dict[str, str]]
    errors: list[dict[str, str]]


LEGACY_EVENT_MAP: dict[str, str] = {
    "command:new": HookEventType.HOOK_COMMAND_NEW.value,
    "command:reset": HookEventType.HOOK_COMMAND_RESET.value,
    "command:stop": HookEventType.HOOK_COMMAND_STOP.value,
    "session:start": HookEventType.HOOK_SESSION_START.value,
    "session:end": HookEventType.HOOK_SESSION_END.value,
    "agent:basic_capabilities": HookEventType.HOOK_AGENT_BASIC_CAPABILITIES.value,
    "agent:start": HookEventType.HOOK_AGENT_START.value,
    "agent:end": HookEventType.HOOK_AGENT_END.value,
    "gateway:start": HookEventType.HOOK_GATEWAY_START.value,
    "gateway:stop": HookEventType.HOOK_GATEWAY_STOP.value,
    "compaction:before": HookEventType.HOOK_COMPACTION_BEFORE.value,
    "compaction:after": HookEventType.HOOK_COMPACTION_AFTER.value,
    "tool:before": HookEventType.HOOK_TOOL_BEFORE.value,
    "tool:after": HookEventType.HOOK_TOOL_AFTER.value,
    "tool:persist": HookEventType.HOOK_TOOL_PERSIST.value,
    "message:sending": HookEventType.HOOK_MESSAGE_SENDING.value,
}


def map_legacy_event(legacy_event: str) -> str | None:
    """Map a legacy event string to its HookEventType."""
    return LEGACY_EVENT_MAP.get(legacy_event)


def map_legacy_events(legacy_events: list[str]) -> list[str]:
    """Map a list of legacy events to HookEventTypes."""
    result = []
    for legacy in legacy_events:
        mapped = map_legacy_event(legacy)
        if mapped:
            result.append(mapped)
    return result


class HookService(Service):
    """
    Unified hook management service.

    Provides centralized hook registration, discovery, eligibility checking,
    and dispatch integrated with the Eliza event system.
    """

    service_type = ServiceType.HOOKS

    def __init__(self, runtime: IAgentRuntime | None = None) -> None:
        super().__init__(runtime)
        self._registry: dict[str, HookRegistration] = {}
        self._event_index: dict[str, set[str]] = {}
        self._id_counter = 0
        self._snapshot_version = 0
        self._hook_config: dict[str, Any] = {}

    @property
    def capability_description(self) -> str:
        return "Hook registration and execution"

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> HookService:
        """Start the HookService and set up event interceptors."""
        service = cls(runtime)
        service._setup_event_interceptors()
        return service

    async def stop(self) -> None:
        """Stop the HookService and clean up."""
        self._registry.clear()
        self._event_index.clear()

    def _setup_event_interceptors(self) -> None:
        """Register this service to intercept HOOK_* events."""
        if self._runtime is None:
            return

        for event_type in HookEventType:
            self._runtime.register_event(
                event_type.value,
                self._create_event_handler(event_type.value),
            )

    def _create_event_handler(self, event_type: str) -> Callable[[dict[str, Any]], None]:
        """Create an async event handler for a specific event type."""

        async def handler(payload: dict[str, Any]) -> None:
            await self._dispatch_to_hooks(event_type, payload)

        return handler

    async def _dispatch_to_hooks(self, event_type: str, payload: dict[str, Any]) -> None:
        """Dispatch an event to all registered hooks for that event type."""
        hook_ids = self._event_index.get(event_type, set())
        if not hook_ids:
            return

        registrations = [self._registry[hid] for hid in hook_ids if hid in self._registry]
        registrations.sort(key=lambda r: (-r.metadata.priority, r.registered_at))

        for registration in registrations:
            if not registration.metadata.enabled:
                continue

            eligibility = self._check_eligibility_internal(registration)
            if not eligibility.eligible:
                continue

            registration.handler(payload)

    def _check_eligibility_internal(self, registration: HookRegistration) -> HookEligibilityResult:
        """Check if a hook is eligible to run."""
        if not registration.metadata.requires:
            return HookEligibilityResult(eligible=True)
        return self.check_requirements(registration.metadata.requires)

    def register(
        self,
        events: str | list[str],
        handler: HookHandler,
        *,
        name: str,
        description: str = "",
        source: HookSource = HookSource.RUNTIME,
        plugin_id: str | None = None,
        priority: int = DEFAULT_HOOK_PRIORITY,
        always: bool = False,
        requires: HookRequirements | None = None,
    ) -> str:
        """
        Register a hook for one or more events.

        Args:
            events: Event type(s) to listen for
            handler: Handler function to call when event is emitted
            name: Name of the hook
            description: Optional description
            source: Source of the hook registration
            plugin_id: Optional plugin ID if hook comes from a plugin
            priority: Hook priority (higher runs first, default 0)
            always: If True, hook runs even when globally disabled
            requires: Optional requirements for hook eligibility

        Returns:
            Unique hook ID
        """
        event_list = [events] if isinstance(events, str) else events

        self._id_counter += 1
        hook_id = f"hook-{self._id_counter}-{uuid.uuid4().hex[:8]}"

        metadata = HookMetadata(
            name=name,
            description=description,
            source=source,
            plugin_id=plugin_id,
            events=event_list,
            priority=priority,
            enabled=True,
            always=always,
            requires=requires,
        )

        registration = HookRegistration(
            id=hook_id,
            metadata=metadata,
            handler=handler,
            registered_at=datetime.now().timestamp(),
        )

        self._registry[hook_id] = registration

        for event in event_list:
            if event not in self._event_index:
                self._event_index[event] = set()
            self._event_index[event].add(hook_id)

        self._snapshot_version += 1
        return hook_id

    def unregister(self, hook_id: str) -> bool:
        """
        Unregister a hook by ID.

        Args:
            hook_id: The hook ID to unregister

        Returns:
            True if hook was found and removed, False otherwise
        """
        registration = self._registry.pop(hook_id, None)
        if registration is None:
            return False

        for event in registration.metadata.events:
            if event in self._event_index:
                self._event_index[event].discard(hook_id)
                if not self._event_index[event]:
                    del self._event_index[event]

        self._snapshot_version += 1
        return True

    def get_snapshot(self) -> HookSnapshot:
        """Get a snapshot of all registered hooks."""
        hooks = [
            HookSummary(
                name=reg.metadata.name,
                events=reg.metadata.events,
                source=reg.metadata.source,
                enabled=reg.metadata.enabled,
                priority=reg.metadata.priority,
                plugin_id=reg.metadata.plugin_id,
            )
            for reg in self._registry.values()
        ]
        return HookSnapshot(
            hooks=hooks,
            version=self._snapshot_version,
            timestamp=datetime.now().timestamp(),
        )

    def get_hooks_by_event(self, event: str) -> list[HookRegistration]:
        """Get all hooks registered for a specific event."""
        hook_ids = self._event_index.get(event, set())
        return [self._registry[hid] for hid in hook_ids if hid in self._registry]

    def get_hook(self, hook_id: str) -> HookRegistration | None:
        """Get a specific hook by ID."""
        return self._registry.get(hook_id)

    def get_all_hooks(self) -> list[HookRegistration]:
        """Get all registered hooks."""
        return list(self._registry.values())

    def set_enabled(self, hook_id: str, enabled: bool) -> None:
        """Enable or disable a hook."""
        registration = self._registry.get(hook_id)
        if registration:
            registration.metadata.enabled = enabled
            self._snapshot_version += 1

    def set_priority(self, hook_id: str, priority: int) -> None:
        """Update the priority of a hook."""
        registration = self._registry.get(hook_id)
        if registration:
            registration.metadata.priority = priority
            self._snapshot_version += 1

    def set_config(self, config: dict[str, Any]) -> None:
        """Set the configuration for requirement checks."""
        self._hook_config = config

    def check_eligibility(self, hook_id: str) -> HookEligibilityResult:
        """Check if a hook is eligible to run."""
        registration = self._registry.get(hook_id)
        if registration is None:
            return HookEligibilityResult(eligible=False, reasons=["Hook not found"])
        return self._check_eligibility_internal(registration)

    def check_requirements(
        self,
        requirements: HookRequirements,
        config: dict[str, Any] | None = None,
    ) -> HookEligibilityResult:
        """
        Check if requirements are met.

        Args:
            requirements: Requirements to check
            config: Optional config for config path checks

        Returns:
            Eligibility result with reasons if not eligible
        """
        cfg = config or self._hook_config
        reasons: list[str] = []

        if requirements.os:
            current_os = _get_current_platform()
            if current_os not in requirements.os:
                reasons.append(f"OS '{current_os}' not in allowed list: {requirements.os}")

        if requirements.bins:
            for bin_name in requirements.bins:
                if not _has_binary(bin_name):
                    reasons.append(f"Required binary '{bin_name}' not found")

        if requirements.any_bins:
            if not any(_has_binary(b) for b in requirements.any_bins):
                reasons.append(f"None of the required binaries found: {requirements.any_bins}")

        if requirements.env:
            for env_var in requirements.env:
                value = os.environ.get(env_var)
                if not value or not _is_truthy(value):
                    reasons.append(f"Required env var '{env_var}' not set or falsy")

        if requirements.config:
            for config_path in requirements.config:
                value = _resolve_config_path(cfg, config_path)
                if not _is_truthy(value):
                    reasons.append(f"Required config path '{config_path}' not set or falsy")

        return HookEligibilityResult(
            eligible=len(reasons) == 0,
            reasons=reasons,
        )


def _get_current_platform() -> str:
    """Get the current platform name."""
    system = platform.system().lower()
    if system == "darwin":
        return "darwin"
    elif system == "linux":
        return "linux"
    elif system == "windows":
        return "win32"
    return system


def _has_binary(bin_name: str) -> bool:
    """Check if a binary is available in PATH."""
    return shutil.which(bin_name) is not None


def _is_truthy(value: Any) -> bool:
    """Check if a value is truthy."""
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.lower() not in ("", "0", "false", "no", "off")
    if isinstance(value, (int, float)):
        return value != 0
    return True


def _resolve_config_path(config: dict[str, Any], path: str) -> Any:
    """Resolve a dot-separated path in a config dict."""
    parts = path.split(".")
    current: Any = config
    for part in parts:
        if isinstance(current, dict):
            current = current.get(part)
        else:
            return None
        if current is None:
            return None
    return current


__all__ = [
    "HookService",
    "HookSource",
    "HookEventType",
    "HookRequirements",
    "HookEligibilityResult",
    "HookMetadata",
    "HookHandler",
    "HookRegistration",
    "HookSummary",
    "HookSnapshot",
    "HookLoadResult",
    "DEFAULT_HOOK_PRIORITY",
    "LEGACY_EVENT_MAP",
    "map_legacy_event",
    "map_legacy_events",
]
