"""Plugin manager type definitions.

Ported from plugin-plugin-manager TypeScript types.  Defines data structures
for plugin state tracking, component registration, and plugin metadata.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


class PluginStatus(StrEnum):
    READY = "ready"
    LOADED = "loaded"
    ERROR = "error"
    UNLOADED = "unloaded"


@dataclass
class ComponentRegistration:
    """Registration record for a component belonging to a plugin."""

    plugin_id: str
    component_type: str
    """One of: action, provider, evaluator, service, event_handler."""
    component_name: str
    timestamp: float


@dataclass
class PluginComponents:
    """Tracked components for a loaded plugin."""

    actions: set[str] = field(default_factory=set)
    providers: set[str] = field(default_factory=set)
    evaluators: set[str] = field(default_factory=set)
    services: set[str] = field(default_factory=set)
    event_handlers: dict[str, set[str]] = field(default_factory=dict)


@dataclass
class PluginState:
    """State of a registered plugin."""

    id: str
    name: str
    status: PluginStatus
    created_at: float
    error: str | None = None
    loaded_at: float | None = None
    unloaded_at: float | None = None
    version: str | None = None
    components: PluginComponents | None = None


@dataclass
class PluginMetadata:
    """Metadata for a plugin in the registry."""

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
class PluginManagerConfig:
    """Configuration for the plugin manager service."""

    plugin_directory: str = "./plugins"


@dataclass
class InstallProgress:
    """Progress of a plugin installation."""

    phase: str
    """One of: fetching-registry, resolving, downloading, extracting,
    installing-deps, validating, configuring, restarting, complete, error."""
    message: str
    plugin_name: str | None = None


@dataclass
class InstallResult:
    success: bool
    plugin_name: str
    version: str
    install_path: str
    requires_restart: bool
    error: str | None = None


@dataclass
class UninstallResult:
    success: bool
    plugin_name: str
    requires_restart: bool
    error: str | None = None


@dataclass
class UpstreamMetadata:
    """Metadata tracking the upstream source for an ejected plugin/core."""

    schema: str  # "milaidy-upstream-v1"
    source: str
    git_url: str
    branch: str
    commit_hash: str
    ejected_at: str
    npm_package: str
    npm_version: str
    last_sync_at: str | None = None
    local_commits: int = 0


@dataclass
class EjectedPluginInfo:
    """Information about an ejected plugin being managed locally."""

    name: str
    path: str
    version: str
    upstream: UpstreamMetadata | None = None


@dataclass
class PluginSearchResult:
    """A single result from a registry search."""

    name: str
    description: str
    score: float
    tags: list[str]
    version: str | None
    npm_package: str
    repository: str
    stars: int
    supports: dict[str, bool] = field(default_factory=dict)


@dataclass
class RegistryPlugin:
    """Normalised representation of a plugin from the remote registry."""

    name: str
    git_repo: str
    git_url: str
    description: str
    homepage: str | None
    topics: list[str]
    stars: int
    language: str
    npm_package: str
    npm_v0_version: str | None = None
    npm_v1_version: str | None = None
    npm_v2_version: str | None = None
    supports_v0: bool = False
    supports_v1: bool = False
    supports_v2: bool = False
    kind: str | None = None


# Protected plugins that cannot be manipulated externally
PROTECTED_PLUGINS: frozenset[str] = frozenset(
    {
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
    }
)
