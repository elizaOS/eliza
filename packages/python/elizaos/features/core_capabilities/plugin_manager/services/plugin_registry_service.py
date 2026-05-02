"""Plugin registry service.

Fetches, caches, and searches plugin metadata from the elizaOS
remote registry (``generated-registry.json`` on the ``next`` branch).

Ported from plugin-manager/services/pluginRegistryService.ts.

The Python port adapts ``fetch`` to ``httpx`` (async) and ``fs``/``path``
to ``pathlib``.  The in-memory cache, fuzzy resolution, and search scoring
are preserved.
"""

from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar

from elizaos.types import Service

from ..types import PluginMetadata, PluginSearchResult, RegistryPlugin

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime

logger = logging.getLogger("elizaos.plugin_manager.registry")

# ---------------------------------------------------------------------------
# Registry URLs — next branch
# ---------------------------------------------------------------------------

_GENERATED_REGISTRY_URL = (
    "https://raw.githubusercontent.com/elizaos-plugins/registry/next/generated-registry.json"
)
_INDEX_REGISTRY_URL = "https://raw.githubusercontent.com/elizaos-plugins/registry/next/index.json"

_CACHE_DURATION = 3_600  # 1 hour in seconds

_LOCAL_PLUGINS_DIR = "plugins"

# ---------------------------------------------------------------------------
# Internal cache
# ---------------------------------------------------------------------------

_registry_cache: dict[str, Any] | None = None  # {"plugins": dict, "timestamp": float}


def reset_registry_cache() -> None:
    global _registry_cache
    _registry_cache = None


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------


def _entry_to_plugin(name: str, entry: dict) -> RegistryPlugin:
    git = entry.get("git", {})
    npm = entry.get("npm", {})
    supports = entry.get("supports", {})
    return RegistryPlugin(
        name=name,
        git_repo=git.get("repo", ""),
        git_url=f"https://github.com/{git.get('repo', '')}.git",
        description=entry.get("description", ""),
        homepage=entry.get("homepage"),
        topics=entry.get("topics", []),
        stars=entry.get("stargazers_count", 0),
        language=entry.get("language", "TypeScript"),
        npm_package=npm.get("repo", name),
        npm_v0_version=npm.get("v0"),
        npm_v1_version=npm.get("v1"),
        npm_v2_version=npm.get("v2"),
        supports_v0=supports.get("v0", False),
        supports_v1=supports.get("v1", False),
        supports_v2=supports.get("v2", False),
        kind=entry.get("kind"),
    )


def _stub_plugin(name: str, git_ref: str) -> RegistryPlugin:
    repo = git_ref.removeprefix("github:")
    return RegistryPlugin(
        name=name,
        git_repo=repo,
        git_url=f"https://github.com/{repo}.git",
        description="",
        homepage=None,
        topics=[],
        stars=0,
        language="TypeScript",
        npm_package=name,
        supports_v2=False,
    )


def _to_metadata(plugin: RegistryPlugin) -> PluginMetadata:
    author = plugin.git_repo.split("/")[0] if "/" in plugin.git_repo else "unknown"
    versions = [
        v
        for v in (plugin.npm_v0_version, plugin.npm_v1_version, plugin.npm_v2_version)
        if v is not None
    ]
    latest = plugin.npm_v2_version or plugin.npm_v1_version or plugin.npm_v0_version or "unknown"
    rv = "v2" if plugin.supports_v2 else ("v1" if plugin.supports_v1 else "v0")
    return PluginMetadata(
        name=plugin.name,
        description=plugin.description,
        author=author,
        repository=f"https://github.com/{plugin.git_repo}",
        versions=versions,
        latest_version=latest,
        runtime_version=rv,
        maintainer=author,
        tags=plugin.topics,
        categories=[],
    )


# ---------------------------------------------------------------------------
# Fetch
# ---------------------------------------------------------------------------


async def _fetch_json(url: str) -> Any:
    """Fetch JSON from *url* using httpx if available, falling back to urllib."""
    try:
        httpx = __import__("httpx")

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            return resp.json()
    except ImportError:
        import urllib.request

        with urllib.request.urlopen(url, timeout=30) as resp:  # noqa: S310
            return json.loads(resp.read())


async def _fetch_generated_registry() -> dict[str, RegistryPlugin]:
    data = await _fetch_json(_GENERATED_REGISTRY_URL)
    plugins: dict[str, RegistryPlugin] = {}
    for name, entry in data.get("registry", {}).items():
        plugins[name] = _entry_to_plugin(name, entry)
    for name, entry in data.get("apps", {}).items():
        entry_with_kind = {**entry, "kind": "app"}
        plugins[name] = _entry_to_plugin(name, entry_with_kind)
    return plugins


async def _fetch_index_registry() -> dict[str, RegistryPlugin]:
    data = await _fetch_json(_INDEX_REGISTRY_URL)
    plugins: dict[str, RegistryPlugin] = {}
    for name, git_ref in data.items():
        plugins[name] = _stub_plugin(name, git_ref)
    return plugins


def _scan_local_plugins() -> dict[str, RegistryPlugin]:
    """Scan the local ``plugins/`` directory for ``elizaos.plugin.json`` files."""
    plugins: dict[str, RegistryPlugin] = {}
    plugins_dir = Path.cwd() / _LOCAL_PLUGINS_DIR
    if not plugins_dir.is_dir():
        return plugins

    for entry in plugins_dir.iterdir():
        if not entry.is_dir():
            continue
        manifest = entry / "elizaos.plugin.json"
        if not manifest.exists():
            continue
        try:
            data = json.loads(manifest.read_text())
            name = data.get("id") or f"@elizaos/{entry.name}"
            description = data.get("description", "")
            repo = (
                (data.get("repository", "") or "")
                .replace("https://github.com/", "")
                .replace(".git", "")
            )
            if not repo:
                repo = f"elizaos/{entry.name}"
            plugin = RegistryPlugin(
                name=name,
                git_repo=repo,
                git_url=data.get("repository") or f"https://github.com/{repo}.git",
                description=description,
                homepage=data.get("homepage"),
                topics=data.get("keywords", []),
                stars=0,
                language="TypeScript",
                npm_package=name,
                npm_v1_version=data.get("version"),
                npm_v2_version=data.get("version"),
                supports_v1=True,
                supports_v2=True,
                kind=data.get("kind"),
            )
            plugins[name] = plugin
            logger.debug("[registry] Found local plugin: %s (%s)", name, entry.name)
        except Exception as exc:
            logger.warning("[registry] Failed to parse %s: %s", manifest, exc)

    if plugins:
        logger.info("[registry] Loaded %d local plugins from %s", len(plugins), plugins_dir)
    return plugins


async def load_registry() -> dict[str, RegistryPlugin]:
    """Load the plugin registry.  Tries ``generated-registry.json`` first,
    falls back to ``index.json``, then merges in local plugins.
    Results are cached in-memory for 1 hour.
    """
    global _registry_cache
    if (
        _registry_cache is not None
        and (time.time() - _registry_cache["timestamp"]) < _CACHE_DURATION
    ):
        return _registry_cache["plugins"]

    logger.info("[registry] Fetching from next@registry...")
    plugins: dict[str, RegistryPlugin] = {}

    try:
        plugins = await _fetch_generated_registry()
        logger.info("[registry] Loaded %d plugins (generated-registry.json)", len(plugins))
    except Exception as exc:
        logger.warning(
            "[registry] generated-registry.json unavailable: %s, falling back to index.json",
            exc,
        )
        try:
            plugins = await _fetch_index_registry()
            logger.info("[registry] Loaded %d plugins (index.json)", len(plugins))
        except Exception as exc2:
            logger.warning(
                "[registry] index.json also unavailable: %s, using local plugins only",
                exc2,
            )

    # Merge local plugins (override remote)
    local = _scan_local_plugins()
    plugins.update(local)

    _registry_cache = {"plugins": plugins, "timestamp": time.time()}
    return plugins


# ---------------------------------------------------------------------------
# Lookup
# ---------------------------------------------------------------------------


def _resolve_plugin(
    registry: dict[str, RegistryPlugin],
    name: str,
) -> RegistryPlugin | None:
    p = registry.get(name)
    if p:
        return p
    if not name.startswith("@"):
        p = registry.get(f"@elizaos/{name}")
        if p:
            return p
    bare = re.sub(r"^@[^/]+/", "", name)
    for key, value in registry.items():
        if key.endswith(f"/{bare}") or key == bare:
            return value
    return None


# ---------------------------------------------------------------------------
# Search scoring
# ---------------------------------------------------------------------------


def _compute_search_score(plugin: RegistryPlugin, query: str) -> int:
    lq = query.lower()
    terms = [t for t in lq.split() if len(t) > 1]
    ln = plugin.name.lower()
    ld = plugin.description.lower()

    score = 0
    if ln == lq or ln == f"@elizaos/{lq}":
        score += 100
    elif lq in ln:
        score += 50

    if lq in ld:
        score += 30
    for t in plugin.topics:
        if lq in t.lower():
            score += 25

    for term in terms:
        if term in ln:
            score += 15
        if term in ld:
            score += 10
        for t in plugin.topics:
            if term in t.lower():
                score += 8

    if score > 0:
        if plugin.stars > 100:
            score += 5
        if plugin.stars > 500:
            score += 5
        if plugin.stars > 1000:
            score += 5

    return score


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class PluginRegistryService(Service):
    """Fetches, caches, and searches the elizaOS plugin registry."""

    service_type: ClassVar[str] = "plugin_registry"

    @property
    def capability_description(self) -> str:
        return "Fetches, caches, and searches the elizaOS plugin registry"

    @classmethod
    async def start(cls, runtime: IAgentRuntime) -> PluginRegistryService:
        service = cls(runtime)
        logger.info("[PluginRegistryService] Started")
        return service

    async def stop(self) -> None:
        logger.info("[PluginRegistryService] Stopped")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def get_registry_entry(self, name: str) -> RegistryPlugin | None:
        """Resolve a plugin by name with fuzzy matching."""
        registry = await load_registry()
        return _resolve_plugin(registry, name)

    async def search_plugins(
        self,
        query: str,
        limit: int = 10,
    ) -> list[PluginSearchResult]:
        """Search the registry by content query, returning scored results."""
        registry = await load_registry()
        scored: list[tuple[RegistryPlugin, int]] = []
        for plugin in registry.values():
            s = _compute_search_score(plugin, query)
            if s > 0:
                scored.append((plugin, s))

        scored.sort(key=lambda x: (-x[1], -x[0].stars))
        max_score = scored[0][1] if scored else 1

        return [
            PluginSearchResult(
                name=p.name,
                description=p.description,
                score=s / max_score,
                tags=p.topics,
                version=p.npm_v2_version or p.npm_v1_version or p.npm_v0_version,
                npm_package=p.npm_package,
                repository=f"https://github.com/{p.git_repo}",
                stars=p.stars,
                supports={"v0": p.supports_v0, "v1": p.supports_v1, "v2": p.supports_v2},
            )
            for p, s in scored[:limit]
        ]

    async def get_plugin_details(self, name: str) -> PluginMetadata | None:
        """Get full metadata for a plugin by name."""
        registry = await load_registry()
        plugin = _resolve_plugin(registry, name)
        return _to_metadata(plugin) if plugin else None

    async def get_all_plugins(self) -> list[PluginMetadata]:
        """Get metadata for all plugins in the registry."""
        registry = await load_registry()
        return [_to_metadata(p) for p in registry.values()]

    async def refresh(self) -> dict[str, RegistryPlugin]:
        """Force-refresh the registry cache."""
        reset_registry_cache()
        return await load_registry()
