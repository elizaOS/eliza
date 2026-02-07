"""Type definitions for the plugin manager plugin."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import TypedDict


# ----- Service Type Constants -----

SERVICE_TYPE_PLUGIN_MANAGER = "plugin_manager"
SERVICE_TYPE_PLUGIN_CONFIGURATION = "plugin_configuration"
SERVICE_TYPE_REGISTRY = "registry"


# ----- Plugin Status -----


class PluginStatus(str, Enum):
    READY = "ready"
    LOADED = "loaded"
    ERROR = "error"
    UNLOADED = "unloaded"


# ----- Component Type -----


class ComponentType(str, Enum):
    ACTION = "action"
    PROVIDER = "provider"
    EVALUATOR = "evaluator"
    SERVICE = "service"
    EVENT_HANDLER = "eventHandler"


# ----- Install Phase -----


class InstallPhase(str, Enum):
    FETCHING_REGISTRY = "fetching-registry"
    DOWNLOADING = "downloading"
    EXTRACTING = "extracting"
    INSTALLING_DEPS = "installing-deps"
    VALIDATING = "validating"
    COMPLETE = "complete"


# ----- Dynamic Plugin Status -----


class DynamicPluginStatus(str, Enum):
    INSTALLED = "installed"
    LOADED = "loaded"
    ACTIVE = "active"
    INACTIVE = "inactive"
    ERROR = "error"
    NEEDS_CONFIGURATION = "needs_configuration"


# ----- Data Classes -----


@dataclass
class PluginComponents:
    actions: set[str] = field(default_factory=set)
    providers: set[str] = field(default_factory=set)
    evaluators: set[str] = field(default_factory=set)
    services: set[str] = field(default_factory=set)
    event_handlers: dict[str, set[str]] = field(default_factory=dict)


@dataclass
class ComponentRegistration:
    plugin_id: str
    component_type: ComponentType
    component_name: str
    timestamp: int


@dataclass
class PluginState:
    id: str
    name: str
    status: PluginStatus
    error: str | None = None
    created_at: int = 0
    loaded_at: int | None = None
    unloaded_at: int | None = None
    version: str | None = None
    components: PluginComponents | None = None


@dataclass
class LoadPluginParams:
    plugin_id: str
    force: bool = False


@dataclass
class UnloadPluginParams:
    plugin_id: str


@dataclass
class PluginManagerConfig:
    plugin_directory: str = "./plugins"


@dataclass
class InstallProgress:
    phase: InstallPhase
    message: str


@dataclass
class PluginMetadata:
    name: str
    description: str
    author: str
    repository: str
    versions: list[str]
    latest_version: str
    runtime_version: str
    maintainer: str
    tags: list[str] | None = None
    categories: list[str] | None = None


@dataclass
class EnvVarRequirement:
    name: str
    description: str
    sensitive: bool
    is_set: bool


@dataclass
class DynamicPluginInfo:
    name: str
    version: str
    status: DynamicPluginStatus
    path: str
    required_env_vars: list[EnvVarRequirement]
    installed_at: str
    error_details: str | None = None
    last_activated: str | None = None


@dataclass
class NpmInfo:
    repo: str
    v1: str | None = None


@dataclass
class GitVersionInfo:
    branch: str | None = None
    version: str | None = None


@dataclass
class GitInfo:
    repo: str
    v1: GitVersionInfo | None = None


@dataclass
class RegistryEntry:
    name: str
    repository: str
    description: str | None = None
    npm: NpmInfo | None = None
    git: GitInfo | None = None


@dataclass
class PluginSearchResult:
    name: str
    description: str
    id: str | None = None
    score: float | None = None
    tags: list[str] | None = None
    features: list[str] | None = None
    required_config: list[str] | None = None
    version: str | None = None
    npm_package: str | None = None
    repository: str | None = None
    relevant_section: str | None = None


@dataclass
class CloneResult:
    success: bool
    error: str | None = None
    plugin_name: str | None = None
    local_path: str | None = None
    has_tests: bool | None = None
    dependencies: dict[str, str] | None = None


@dataclass
class RegistryResult[T]:
    data: T
    from_api: bool
    error: str | None = None


@dataclass
class PluginConfigStatus:
    configured: bool
    missing_keys: list[str]
    total_keys: int


# ----- Protected Plugins -----

PROTECTED_PLUGINS: frozenset[str] = frozenset({
    "plugin-manager",
    "@elizaos/plugin-sql",
    "bootstrap",
    "game-api",
    "inference",
    "autonomy",
    "knowledge",
    "@elizaos/plugin-personality",
    "experience",
    "goals",
    "todo",
})


# ----- Base Action/Provider Types (from plugin-linear pattern) -----


class ActionResultDict(TypedDict, total=False):
    text: str
    success: bool
    data: dict[str, str | int | float | bool | list[str] | dict[str, str] | None]


class ProviderResultDict(TypedDict, total=False):
    text: str
    data: dict[str, str | int | float | bool | list[str] | dict[str, str] | None] | None
    values: dict[str, str | int | float | bool | list[str] | None] | None
