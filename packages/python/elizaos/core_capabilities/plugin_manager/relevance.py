"""Keyword relevance scoring for plugin-manager providers.

Ported from plugin-manager/providers/relevance.ts.  Provides helpers to
build keyword lists from provider-specific terms and loaded plugin names,
then test whether a message/state is relevant to a given provider.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from elizaos.types import Memory, State

# Tokens stripped when extracting keywords from plugin names — they are too
# generic to be useful for relevance matching.
_IGNORED_PLUGIN_NAME_TOKENS: frozenset[str] = frozenset(
    {
        "app",
        "core",
        "eliza",
        "elizaos",
        "manager",
        "plugin",
        "plugins",
        "provider",
        "providers",
    }
)

# ---------------------------------------------------------------------------
# Shared keyword sets
# ---------------------------------------------------------------------------

PLUGIN_MANAGER_BASE_KEYWORDS: list[str] = [
    "plugin",
    "plugins",
    "plugin manager",
    "plugin-manager",
    "extension",
    "extensions",
    "module",
    "modules",
    "addon",
    "add-on",
    "add-ons",
    "integration",
    "integrations",
    "integrate",
    "integrated",
    "connect",
    "connected",
    "connection",
    "connector",
    "connectors",
    "adapter",
    "adapters",
    "bridge",
    "bridges",
    "interoperability",
    "orchestration",
    "compatibility",
    "ecosystem",
    "registry",
    "catalog",
    "directory",
    "marketplace",
    "index",
    "search",
    "discover",
    "install",
    "installed",
    "installation",
    "uninstall",
    "remove",
    "removed",
    "load",
    "loaded",
    "unload",
    "unloaded",
    "enable",
    "enabled",
    "disable",
    "disabled",
    "configure",
    "configuration",
    "config",
    "settings",
    "setup",
    "status",
    "state",
    "health",
    "available",
    "availability",
    "error",
    "errors",
    "package",
    "packages",
    "repo",
    "repository",
    "dependencies",
    "runtime",
    "provider",
    "providers",
    "service",
    "services",
    "tool",
    "tools",
    "workflow",
    "workflows",
]

COMMON_CONNECTOR_KEYWORDS: list[str] = [
    "discord",
    "telegram",
    "slack",
    "whatsapp",
    "twitter",
    "github",
    "farcaster",
    "nostr",
    "line",
    "matrix",
    "google chat",
    "msteams",
    "teams",
    "twilio",
    "imessage",
    "bluebubbles",
    "bluesky",
    "twitch",
    "instagram",
    "zalo",
    "nextcloud",
    "gmail",
    "openai",
    "anthropic",
    "groq",
    "ollama",
    "xai",
    "solana",
    "evm",
    "n8n",
    "mcp",
    "rss",
    "s3",
    "sql",
]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_ESCAPE_RE = re.compile(r"[.*+?^${}()|[\]\\]")


def _escape_regex(value: str) -> str:
    return _ESCAPE_RE.sub(r"\\\g<0>", value)


def _normalize(value: str) -> str:
    return value.strip().lower()


def build_provider_keywords(
    *groups: list[str] | None,
) -> list[str]:
    """Merge multiple keyword groups, normalising and deduplicating."""
    seen: set[str] = set()
    result: list[str] = []
    for group in groups:
        if group is None:
            continue
        for raw in group:
            kw = _normalize(raw)
            if not kw or kw in seen:
                continue
            seen.add(kw)
            result.append(kw)
    return result


def keywords_from_plugin_names(plugin_names: list[str]) -> list[str]:
    """Extract relevance keywords from a list of plugin names.

    Strips scopes (``@elizaos/``), common prefixes (``plugin-``), and
    generic tokens to produce a meaningful keyword set.
    """
    seen: set[str] = set()
    result: list[str] = []

    def _add(val: str) -> None:
        if val and val not in seen:
            seen.add(val)
            result.append(val)

    for raw_name in plugin_names:
        name = _normalize(raw_name)
        if not name:
            continue

        _add(name)

        # Strip npm scope
        without_scope = re.sub(r"^@[^/]+/", "", name)
        if without_scope:
            _add(without_scope)

        # Strip plugin/app prefix
        without_prefix = re.sub(r"^(plugin|app)[-_]", "", without_scope)
        if without_prefix:
            _add(without_prefix)

        # Individual tokens
        for token in re.split(r"[^a-z0-9]+", without_prefix):
            if not token or len(token) < 2 or token in _IGNORED_PLUGIN_NAME_TOKENS:
                continue
            _add(token)

    return result


def build_keyword_regex(keywords: list[str]) -> re.Pattern[str]:
    """Build a compiled regex that matches any of the given keywords at word
    boundaries, longest-first to avoid partial-match shadows.
    """
    normalised = sorted(
        {_normalize(kw) for kw in keywords if _normalize(kw)},
        key=len,
        reverse=True,
    )
    if not normalised:
        return re.compile(r"$^")  # never matches
    escaped = [_escape_regex(kw) for kw in normalised]
    return re.compile(r"\b(" + "|".join(escaped) + r")\b", re.IGNORECASE)


# ---------------------------------------------------------------------------
# Memory / State text extraction
# ---------------------------------------------------------------------------


def _get_memory_text(memory: object | None) -> str:
    if memory is None:
        return ""
    content = getattr(memory, "content", None)
    if content is None:
        return ""
    text = getattr(content, "text", None)
    return text.lower() if isinstance(text, str) else ""


def _get_attr_or_key(value: object | None, key: str) -> object | None:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _get_recent_messages(state: object | None) -> list[object]:
    if state is None:
        return []
    data = _get_attr_or_key(state, "data")
    providers = _get_attr_or_key(data, "providers")
    recent_provider = _get_attr_or_key(providers, "RECENT_MESSAGES")
    recent_provider_data = _get_attr_or_key(recent_provider, "data")

    for candidate in (
        _get_attr_or_key(recent_provider_data, "recentMessages"),
        _get_attr_or_key(data, "recentMessages"),
        _get_attr_or_key(state, "recentMessagesData"),
        _get_attr_or_key(state, "recentMessages"),
    ):
        if isinstance(candidate, list):
            return candidate

    return []


def _get_recent_message_texts(state: object | None) -> list[str]:
    return [t for msg in _get_recent_messages(state) if (t := _get_memory_text(msg))]


# ---------------------------------------------------------------------------
# Relevance check
# ---------------------------------------------------------------------------


def _validate_keywords(
    message: object,
    state: object | None,
    keywords: list[str],
) -> bool:
    if not keywords:
        return False
    texts = [_get_memory_text(message)] + _get_recent_message_texts(state)
    if all(not t for t in texts):
        return False
    for kw in keywords:
        nkw = _normalize(kw)
        if not nkw:
            continue
        if any(nkw in t for t in texts):
            return True
    return False


def _validate_regex(
    message: object,
    state: object | None,
    regex: re.Pattern[str],
) -> bool:
    texts = [_get_memory_text(message)] + _get_recent_message_texts(state)
    return any(bool(t) and regex.search(t) is not None for t in texts)


def is_provider_relevant(
    message: Memory,
    state: State | None,
    keywords: list[str],
) -> bool:
    """Return ``True`` when the current message or recent conversation context
    matches any of the given relevance *keywords*.  Uses both a simple
    substring check and a word-boundary regex for robustness.
    """
    keyword_regex = build_keyword_regex(keywords)
    has_keyword = _validate_keywords(message, state, keywords)
    has_regex = _validate_regex(message, state, keyword_regex)
    return has_keyword or has_regex
