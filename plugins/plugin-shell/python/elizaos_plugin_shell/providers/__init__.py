"""Shell plugin providers."""

from elizaos_plugin_shell.providers.shell_history import ShellHistoryProvider

__all__ = [
    "ShellHistoryProvider",
    "get_shell_providers",
    "get_shell_provider_names",
]


def get_shell_providers() -> list:
    """Get all shell providers as instances."""
    return [
        ShellHistoryProvider(),
    ]


def get_shell_provider_names() -> list[str]:
    """Get all shell provider names."""
    return [
        "SHELL_HISTORY",
    ]
