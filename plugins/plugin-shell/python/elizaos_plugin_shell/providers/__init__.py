from elizaos_plugin_shell.providers.shell_history import ShellHistoryProvider

__all__ = [
    "ShellHistoryProvider",
    "get_shell_providers",
    "get_shell_provider_names",
]


def get_shell_providers() -> list:
    return [
        ShellHistoryProvider(),
    ]


def get_shell_provider_names() -> list[str]:
    return [
        "SHELL_HISTORY",
    ]
